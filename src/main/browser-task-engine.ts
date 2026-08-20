import { randomUUID } from "node:crypto";
import * as browser from "./embedded-browser.js";
import { answerWithGemini, geminiStatus } from "./gemini.js";
import { ollamaStatus, planBrowserActionWithOllama } from "./ollama.js";
import type { BrowserTask, BrowserTaskAction, BrowserTaskEvent } from "../shared/contracts.js";

const riskyLabels = /\b(?:send|submit|apply|purchase|buy|pay|book|publish|post|delete|remove|confirm order|place order|accept|agree)\b/i;
const MAX_STEPS = 20;
const STEP_TIMEOUT_MS = 105_000;
const ACTION_TIMEOUT_MS = 25_000;
const WORKFLOW_TIMEOUT_MS = 240_000;
const LOOP_RECOVERY_MARKER = "__orbit_loop_recovery__";
const MAX_LOOP_RECOVERIES = 2;
const NAMED_SITES: Array<[RegExp, string]> = [
  [/\bwikipedia\b/i, "https://en.wikipedia.org"],
  [/\bgithub\b/i, "https://github.com"],
  [/\bnpm(?:js)?\b/i, "https://www.npmjs.com"],
  [/\belectron(?:js)?\b/i, "https://www.electronjs.org"],
  [/\byoutube\b/i, "https://www.youtube.com"],
  [/\bamazon\b/i, "https://www.amazon.com"],
  [/\blinkedin\b/i, "https://www.linkedin.com"],
];
let active: BrowserTask | null = null;
let cancelled = false;
let lastPageFingerprint = "";
let stagnantPageRounds = 0;
let loopRecoveryAttempts = 0;

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function emit(listener: (event: BrowserTaskEvent) => void, type: BrowserTaskEvent["type"], message?: string) {
  if (!active) return;
  listener({ type, task: active, message });
}

function setPlanner(planner: "gemini"|"ollama", listener?: (event: BrowserTaskEvent) => void) {
  if (!active) return;
  const changed = active.planner !== planner;
  active.planner = planner;
  if (changed && listener) emit(listener, "status", planner === "ollama" ? "Browser planning switched to Local Ollama" : "Browser planning with Gemini");
}

function explicitGoalUrl(goal: string) {
  const direct = goal.match(/https?:\/\/[^\s,)]+/i)?.[0];
  if (direct) return direct;
  const domain = goal.match(/\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,)]+)?\b/i)?.[0];
  if (domain) return `https://${domain}`;
  return NAMED_SITES.find(([pattern]) => pattern.test(goal))?.[1] || "";
}

function wikipediaSearchUrl(goal: string) {
  if (!/\bwikipedia\b/i.test(goal)) return "";
  const match = goal.match(/\bsearch(?:\s+for)?\s+(.+?)(?=,\s*(?:and|then)\b|\s+and\s+(?:tell|show|give|report|find out)\b|$)/i);
  const query = match?.[1]?.trim().replace(/^the\s+/i, "");
  if (!query) return "";
  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query.slice(0, 180))}`;
}

function initialGoalUrl(goal: string) {
  return wikipediaSearchUrl(goal) || explicitGoalUrl(goal);
}

function sameDestination(current: string, target: string) {
  try {
    const currentUrl = new URL(current);
    const targetUrl = new URL(target);
    const normalizedCurrentPath = currentUrl.pathname.replace(/\/$/, "") || "/";
    const normalizedTargetPath = targetUrl.pathname.replace(/\/$/, "") || "/";
    return currentUrl.hostname === targetUrl.hostname
      && (normalizedTargetPath === "/" || normalizedCurrentPath === normalizedTargetPath);
  } catch {
    return false;
  }
}

function usablePage(url: string, text: string) {
  return /^https?:\/\//i.test(url) && text.trim().length >= 20;
}

function publicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Orbit only opens HTTP or HTTPS pages");
  if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error("Orbit's browser agent cannot open private network addresses");
  return url.toString();
}

function repairedNavigationUrl(value: string | undefined, currentUrl: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (/^https?:\/\//i.test(raw)) return publicUrl(raw);
    if (/^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(raw)) return publicUrl(`https://${raw}`);
    if (/^(?:\/|\.\.?\/)/.test(raw) && /^https?:\/\//i.test(currentUrl)) return publicUrl(new URL(raw, currentUrl).toString());
  } catch {}
  return "";
}

function normalizePlannedAction(action: BrowserTaskAction, currentUrl: string): BrowserTaskAction {
  if (action.type !== "navigate") return action;
  const url = repairedNavigationUrl(action.url, currentUrl);
  if (url) return { ...action, url };
  const label = action.label?.trim();
  if (label) {
    return {
      type: "click",
      label,
      reason: action.reason || `Using the visible “${label}” control instead of an invalid navigation target`,
    };
  }
  return {
    type: "wait",
    reason: "Re-inspecting the page because the planner omitted a valid navigation URL",
  };
}

function actionSignature(action: BrowserTaskAction) {
  return [
    action.type,
    action.url || "",
    action.label || "",
    action.value || "",
    action.direction || "",
  ].map(value => String(value).trim().toLowerCase()).join("|");
}

function pageFingerprint(page: { url: string; title: string; text: string }) {
  return `${page.url}|${page.title}|${page.text.slice(0, 1600)}`;
}

function avoidActionLoop(
  action: BrowserTaskAction,
  page: { url: string; controls: Array<{ kind: string; label: string }> },
  steps: BrowserTask["steps"],
): BrowserTaskAction {
  const signature = actionSignature(action);
  const recentMatches = steps.slice(-5).filter(step => actionSignature(step.action) === signature).length;
  if (recentMatches < 2 && stagnantPageRounds < 2) return action;

  if (action.type === "fill") {
    const wanted = (action.label || "").trim().toLowerCase();
    const submit = page.controls.find(control => {
      const label = control.label.trim().toLowerCase();
      const clickable = /button|submit/i.test(control.kind);
      return clickable && Boolean(label) && (label === wanted || /\b(?:search|go|find|next|continue)\b/i.test(label));
    });
    if (submit) {
      return {
        type: "click",
        label: submit.label,
        reason: `Submitting with “${submit.label}” instead of repeating the same fill action`,
      };
    }
  }

  if (action.type === "wait" && stagnantPageRounds < 4) {
    return { type: "scroll", direction: "down", reason: "The page did not change, so Orbit is inspecting more content instead of waiting again" };
  }

  if (action.type === "navigate" && action.url && sameDestination(page.url, action.url) && stagnantPageRounds < 4) {
    return { type: "scroll", direction: "down", reason: "Orbit is already at that destination, so it is inspecting the page instead of reopening it" };
  }

  if (action.type === "scroll" && recentMatches >= 2 && stagnantPageRounds < 4) {
    return {
      type: "scroll",
      direction: action.direction === "up" ? "down" : "up",
      reason: "Orbit detected repeated scrolling without progress and changed direction",
    };
  }

  if (recentMatches >= 3 || stagnantPageRounds >= 4) {
    return { type: "wait", reason: LOOP_RECOVERY_MARKER };
  }

  return action;
}

function transientGeminiFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /quota|rate.?limit|resource.?exhausted|429|too many requests|high demand|try again later|temporar(?:y|ily)|overload(?:ed)?|service unavailable|\b503\b|timeout|timed.?out|aborted|aborterror/i.test(message);
}

function retryDelayMs(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const seconds = Number(message.match(/retry\s+in\s+(\d+(?:\.\d+)?)s/i)?.[1] || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 30_000;
  return Math.min(35_000, Math.ceil(seconds * 1000) + 500);
}

function parseBrowserAction(value: string): BrowserTaskAction {
  const clean = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error(`Browser planner returned invalid structured output: ${clean.slice(0, 120)}`);
  try { return JSON.parse(clean.slice(first, last + 1)) as BrowserTaskAction; }
  catch { throw new Error(`Browser planner returned invalid JSON: ${clean.slice(0, 120)}`); }
}

async function planBrowserStep(prompt: string, listener: (event: BrowserTaskEvent) => void): Promise<BrowserTaskAction> {
  if (geminiStatus().available) {
    try {
      setPlanner("gemini", listener);
      return parseBrowserAction(await answerWithGemini({ query: prompt, history: [] }));
    } catch (error) {
      if (!transientGeminiFailure(error)) throw error;

      const local = await ollamaStatus();
      if (local.available) {
        setPlanner("ollama", listener);
        if (active) {
          active.summary = "Gemini temporarily unavailable — continuing locally";
          emit(listener, "status", active.summary);
        }
        return planBrowserActionWithOllama({ prompt });
      }

      const delay = retryDelayMs(error);
      if (active) {
        active.summary = `Gemini temporarily unavailable — retrying in ${Math.ceil(delay / 1000)}s`;
        emit(listener, "status", active.summary);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      if (cancelled) throw new Error("Browser task cancelled");
      setPlanner("gemini", listener);
      return parseBrowserAction(await answerWithGemini({ query: prompt, history: [] }));
    }
  }

  const local = await ollamaStatus();
  if (!local.available) throw new Error("Orbit needs Gemini or the local qwen3:4b model to plan browser actions");
  setPlanner("ollama", listener);
  if (active) {
    active.summary = "Planning browser step locally";
    emit(listener, "status", active.summary);
  }
  return planBrowserActionWithOllama({ prompt });
}

async function nextAction(goal: string, steps: BrowserTask["steps"], listener: (event: BrowserTaskEvent) => void): Promise<BrowserTaskAction> {
  if (!active) throw new Error("No browser task is active");

  if (!steps.length) {
    const goalUrl = initialGoalUrl(goal);
    if (goalUrl) {
      const current = await browser.currentUrl();
      if (!sameDestination(current, goalUrl)) {
        active.url = current;
        active.summary = `Opening ${new URL(goalUrl).hostname} inside Orbit`;
        emit(listener, "status", active.summary);
        return { type: "navigate", url: goalUrl, reason: active.summary };
      }
    }
  }

  active.summary = steps.length ? "Inspecting the updated page" : "Inspecting the embedded browser";
  emit(listener, "status", active.summary);
  const page = await browser.actionSnapshot();
  if (cancelled) throw new Error("Browser task cancelled");

  active.url = page.url;
  active.title = page.title;

  const fingerprint = pageFingerprint(page);
  if (fingerprint === lastPageFingerprint) stagnantPageRounds += 1;
  else {
    lastPageFingerprint = fingerprint;
    stagnantPageRounds = 0;
    loopRecoveryAttempts = 0;
  }

  if (!usablePage(page.url, page.text)) {
    const goalUrl = initialGoalUrl(goal);
    if (goalUrl && !sameDestination(page.url, goalUrl)) {
      return { type: "navigate", url: goalUrl, reason: `Opening ${new URL(goalUrl).hostname} inside Orbit` };
    }
    throw new Error("The embedded page did not finish loading, so Orbit did not continue from model memory");
  }

  active.summary = `Planning browser step ${steps.length + 1}`;
  emit(listener, "status", active.summary);

  const history = steps.slice(-6).map(step => `${step.action.type}: ${step.action.label || step.action.url || ""} -> ${step.outcome}`).join("\n");
  const noProgress = stagnantPageRounds > 0
    ? `\nProgress warning: the visible page has been materially unchanged for ${stagnantPageRounds} planning round(s). Do NOT repeat the same action; choose a different control/action that can advance the goal.`
    : "";
  const prompt = `You are Orbit's browser controller. Choose exactly one safe next browser action to advance the user's goal.\nGoal: ${goal}\nCurrent page: ${page.title} (${page.url})\nRecent steps:\n${history || "none"}${noProgress}\nVisible controls: ${JSON.stringify(page.controls.slice(0, 60))}\nVisible text: ${page.text.slice(0, 7000)}\nReturn JSON only: {"type":"navigate|click|fill|select|scroll|wait|complete|ask_user","url":"","label":"","value":"","direction":"down|up","reason":"short explanation"}. Use labels exactly as shown. For navigate, url MUST be an absolute http:// or https:// URL; if you do not have one, use click, fill, select, scroll, wait, or ask_user instead. Never repeat the same action from Recent steps when it did not change the page. Never choose send, submit, apply, purchase, pay, book, publish, post, delete, accept, or agree; use ask_user immediately before such an action. Use complete only when the goal is visibly satisfied by the current loaded page. Never answer from memory instead of using the browser. Never enter passwords, payment data, government IDs, or authentication codes.`;
  const normalized = normalizePlannedAction(await planBrowserStep(prompt, listener), page.url);
  let parsed = avoidActionLoop(normalized, page, steps);

  if (parsed.type === "wait" && parsed.reason === LOOP_RECOVERY_MARKER) {
    loopRecoveryAttempts += 1;
    const forbidden = [...new Set(steps.slice(-6).map(step => actionSignature(step.action)))];
    if (active) {
      active.summary = `Recovering from repeated browser actions · attempt ${loopRecoveryAttempts}/${MAX_LOOP_RECOVERIES}`;
      emit(listener, "status", active.summary);
    }
    const recoveryPrompt = `${prompt}\nRECOVERY MODE: The previous plan is stuck. You MUST choose an action whose signature is NOT in this forbidden list: ${JSON.stringify(forbidden)}. Do not reverse-scroll back and forth. Do not refill the same field. Do not reopen the same URL. If the visible text already satisfies the user's goal, choose complete now. Otherwise choose a genuinely different visible control or safe action that advances the goal.`;
    const recovered = normalizePlannedAction(await planBrowserStep(recoveryPrompt, listener), page.url);
    const recoveredSignature = actionSignature(recovered);

    if (forbidden.includes(recoveredSignature)) {
      const recentLabels = new Set(steps.slice(-6).map(step => String(step.action.label || "").trim().toLowerCase()).filter(Boolean));
      const alternate = page.controls.find(control => {
        const label = control.label.trim();
        if (!label || recentLabels.has(label.toLowerCase())) return false;
        return /button|a|link|submit/i.test(control.kind) && /\b(?:search|result|article|release|issues?|next|more|details?|read|view|open)\b/i.test(label);
      });
      if (alternate) {
        parsed = { type: "click", label: alternate.label, reason: `Loop recovery selected a different visible control: “${alternate.label}”` };
      } else if (loopRecoveryAttempts < MAX_LOOP_RECOVERIES) {
        parsed = { type: "scroll", direction: "down", reason: "Loop recovery is inspecting a new part of the page before replanning" };
      } else {
        throw new Error(`Orbit could not find a new safe browser path after ${MAX_LOOP_RECOVERIES} recovery attempts`);
      }
    } else {
      parsed = recovered;
      stagnantPageRounds = Math.max(0, stagnantPageRounds - 2);
    }
  }

  if (!["navigate", "click", "fill", "select", "scroll", "wait", "complete", "ask_user"].includes(parsed.type)) throw new Error("Orbit's browser planner returned an unsupported action");
  if (parsed.type === "complete" && !usablePage(page.url, page.text)) throw new Error("Orbit refused to complete a browser task from an unloaded page");
  return parsed;
}

async function act(action: BrowserTaskAction) {
  if ((action.type === "click" && riskyLabels.test(action.label || "")) || action.type === "ask_user") return { pause: true, outcome: action.reason || `Approval required before ${action.label || "continuing"}` };
  if (action.type === "navigate") await browser.openUrl(publicUrl(action.url || ""));
  else if (action.type === "click") await browser.clickByLabel(action.label || "");
  else if (action.type === "fill") await browser.fillByLabel(action.label || "", action.value || "");
  else if (action.type === "select") await browser.selectByLabel(action.label || "", action.value || "");
  else if (action.type === "scroll") await browser.scroll(action.direction === "up" ? "up" : "down");
  else if (action.type === "wait") await new Promise(resolve => setTimeout(resolve, 1200));
  return { pause: false, outcome: action.reason || `${action.type} completed` };
}

async function run(taskId: string, listener: (event: BrowserTaskEvent) => void) {
  if (!active || active.id !== taskId) return active;
  const startedAt = Date.now();
  active.status = "running";
  active.summary = "Starting embedded browser workflow";
  emit(listener, "status", active.summary);

  try {
    for (let round = active.steps.length; round < MAX_STEPS; round++) {
      if (!active || active.id !== taskId) return active;
      if (cancelled) {
        active.status = "cancelled";
        active.summary = "Browser task stopped";
        emit(listener, "status", active.summary);
        return active;
      }
      if (Date.now() - startedAt >= WORKFLOW_TIMEOUT_MS) {
        active.status = "failed";
        active.summary = "Orbit stopped this browser task after 4 minutes. The embedded page remains open at the last verified step.";
        emit(listener, "status", active.summary);
        return active;
      }

      const action = await withTimeout(
        nextAction(active.goal, active.steps, listener),
        STEP_TIMEOUT_MS,
        "The browser planner took too long on this step",
      );

      if (!active || active.id !== taskId) return active;
      if (cancelled) {
        active.status = "cancelled";
        active.summary = "Browser task stopped before the next action";
        emit(listener, "status", active.summary);
        return active;
      }

      if (action.type === "complete") {
        active.status = "completed";
        active.summary = action.reason || "Browser task completed";
        emit(listener, "status", active.summary);
        return active;
      }

      active.summary = action.reason || `Executing ${action.type}`;
      emit(listener, "status", active.summary);
      const result = await withTimeout(act(action), ACTION_TIMEOUT_MS, `The ${action.type} action took too long`);
      active.steps.push({ at: new Date().toISOString(), action, outcome: result.outcome });
      active.url = await browser.currentUrl();
      active.title = await browser.pageTitle();

      if (result.pause) {
        active.status = "waiting_for_confirmation";
        active.pendingAction = action;
        active.summary = result.outcome;
        emit(listener, "status", active.summary);
        return active;
      }

      emit(listener, "step", `${result.outcome} · Step ${active.steps.length} verified`);
    }

    if (active && active.id === taskId) {
      active.status = "paused";
      active.summary = `Orbit reached the ${MAX_STEPS}-step safety limit. Review the embedded page before continuing.`;
      emit(listener, "status", active.summary);
    }
    return active;
  } catch (error) {
    if (!active || active.id !== taskId) return active;
    if (cancelled || (error instanceof Error && /cancelled/i.test(error.message))) {
      active.status = "cancelled";
      active.summary = "Browser task stopped";
    } else {
      active.status = "failed";
      const detail = error instanceof Error ? error.message : "an unknown browser-agent error occurred";
      const friendly = /timeout|timed.?out|aborted|aborterror/i.test(detail)
        ? "the browser planner timed out before it could verify the next step. The current page is still open, so retrying can continue from here."
        : detail;
      active.summary = `Orbit paused the embedded browser safely: ${friendly}`;
    }
    emit(listener, "status", active.summary);
    return active;
  }
}

export async function startBrowserTask(goal: string, listener: (event: BrowserTaskEvent) => void) {
  if (!goal.trim()) throw new Error("Tell Orbit what you want the browser to accomplish");
  const local = await ollamaStatus();
  const geminiReady = geminiStatus().available;
  if (!geminiReady && !local.available) throw new Error("Connect Gemini or start the local qwen3:4b model before starting an autonomous browser task");
  if (active?.status === "running") throw new Error("Orbit is already running a browser task. Stop it before starting another one.");

  cancelled = false;
  lastPageFingerprint = "";
  stagnantPageRounds = 0;
  loopRecoveryAttempts = 0;
  await browser.showEmbeddedBrowser();
  active = {
    id: randomUUID(),
    goal: goal.trim(),
    status: "running",
    steps: [],
    summary: "Opening Orbit's embedded browser",
    url: await browser.currentUrl(),
    title: await browser.pageTitle(),
    planner: geminiReady ? "gemini" : "ollama",
  };
  const taskId = active.id;
  emit(listener, "status", active.summary);
  void run(taskId, listener);
  return active;
}

export async function resumeBrowserTask(confirmed: boolean, listener: (event: BrowserTaskEvent) => void) {
  if (!active) throw new Error("No browser task is waiting");
  if (active.status !== "waiting_for_confirmation") return active;
  if (!confirmed) return active;

  const pending = active.pendingAction;
  if (!pending || !pending.label || !["click", "ask_user"].includes(pending.type)) throw new Error("Orbit needs you to take over for this step");
  await withTimeout(browser.clickByLabel(pending.label), ACTION_TIMEOUT_MS, "The confirmed browser action took too long");
  active.steps.push({ at: new Date().toISOString(), action: pending, outcome: "Confirmed by user and completed" });
  active.pendingAction = undefined;
  active.status = "running";
  active.summary = "Confirmed. Continuing the embedded browser workflow";
  cancelled = false;
  const taskId = active.id;
  emit(listener, "step", `Confirmed action completed · Step ${active.steps.length} verified`);
  void run(taskId, listener);
  return active;
}

export function cancelBrowserTask() {
  cancelled = true;
  if (active && !["completed", "failed", "cancelled"].includes(active.status)) {
    active.status = "cancelled";
    active.summary = "Browser task stopped";
  }
  browser.hideEmbeddedBrowser();
  return active;
}

export function browserTaskStatus() { return active; }
