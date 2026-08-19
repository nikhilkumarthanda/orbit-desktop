import { randomUUID } from "node:crypto";
import * as browser from "./browser-agent.js";
import { answerWithGemini, geminiStatus } from "./gemini.js";
import type { BrowserTask, BrowserTaskAction, BrowserTaskEvent } from "../shared/contracts.js";

const riskyLabels = /\b(?:send|submit|apply|purchase|buy|pay|book|publish|post|delete|remove|confirm order|place order|accept|agree)\b/i;
const MAX_STEPS = 20;
const STEP_TIMEOUT_MS = 40_000;
const ACTION_TIMEOUT_MS = 15_000;
const WORKFLOW_TIMEOUT_MS = 150_000;
let active: BrowserTask | null = null;
let cancelled = false;
const cleanJson = (value: string) => value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

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

function explicitGoalUrl(goal: string) {
  const direct = goal.match(/https?:\/\/[^\s,)]+/i)?.[0];
  if (direct) return direct;
  const domain = goal.match(/\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,)]+)?\b/i)?.[0];
  return domain ? `https://${domain}` : "";
}

function isBlankOrNewTab(url: string) {
  const normalized = String(url || "").trim().toLowerCase().replace(/\/$/, "");
  return !normalized
    || normalized === "about:blank"
    || normalized === "chrome://newtab"
    || normalized === "chrome://new-tab-page"
    || normalized === "chrome-search://local-ntp";
}

async function nextAction(goal: string, steps: BrowserTask["steps"], listener: (event: BrowserTaskEvent) => void): Promise<BrowserTaskAction> {
  if (!active) throw new Error("No browser task is active");
  active.summary = steps.length ? "Inspecting the updated page" : "Inspecting the current page";
  emit(listener, "status", active.summary);
  const page = await browser.actionSnapshot();
  if (cancelled) throw new Error("Browser task cancelled");

  active.url = page.url;
  active.title = page.title;

  // If the user named an explicit public site and the private agent is still on a
  // blank/new-tab page, navigate there deterministically. This avoids spending a
  // model call on an obvious first step and makes demo/startup behavior reliable.
  const goalUrl = explicitGoalUrl(goal);
  if (!steps.length && goalUrl && isBlankOrNewTab(page.url)) {
    return { type: "navigate", url: goalUrl, reason: `Opening ${new URL(goalUrl).hostname}` };
  }

  active.summary = `Planning browser step ${steps.length + 1}`;
  emit(listener, "status", active.summary);

  const history = steps.slice(-6).map(step => `${step.action.type}: ${step.action.label || step.action.url || ""} -> ${step.outcome}`).join("\n");
  const prompt = `You are Orbit's browser controller. Choose exactly one safe next browser action to advance the user's goal.\nGoal: ${goal}\nCurrent page: ${page.title} (${page.url})\nRecent steps:\n${history || "none"}\nVisible controls: ${JSON.stringify(page.controls.slice(0, 60))}\nVisible text: ${page.text.slice(0, 7000)}\nReturn JSON only: {"type":"navigate|click|fill|select|scroll|wait|complete|ask_user","url":"","label":"","value":"","direction":"down|up","reason":"short explanation"}. Use labels exactly as shown. Never choose send, submit, apply, purchase, pay, book, publish, post, delete, accept, or agree; use ask_user immediately before such an action. Use complete only when the goal is visibly satisfied. Never enter passwords, payment data, government IDs, or authentication codes.`;
  const parsed = JSON.parse(cleanJson(await answerWithGemini({ query: prompt, history: [] }))) as BrowserTaskAction;
  if (!["navigate", "click", "fill", "select", "scroll", "wait", "complete", "ask_user"].includes(parsed.type)) throw new Error("Orbit's browser planner returned an unsupported action");
  return parsed;
}

function publicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Orbit only opens HTTP or HTTPS pages");
  if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error("Orbit's browser agent cannot open private network addresses");
  return url.toString();
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
  active.summary = "Starting autonomous browser workflow";
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
        active.summary = "Orbit stopped this browser task after 2.5 minutes. The page was left unchanged after the last verified step.";
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
      active.summary = `Orbit reached the ${MAX_STEPS}-step safety limit. Review the page before continuing.`;
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
      active.summary = `Orbit paused the browser task safely: ${detail}`;
    }
    emit(listener, "status", active.summary);
    return active;
  }
}

export async function startBrowserTask(goal: string, listener: (event: BrowserTaskEvent) => void) {
  if (!goal.trim()) throw new Error("Tell Orbit what you want the browser to accomplish");
  if (!geminiStatus().available) throw new Error("Connect Gemini in Settings before starting an autonomous browser task");
  if (active?.status === "running") throw new Error("Orbit is already running a browser task. Stop it before starting another one.");

  cancelled = false;
  active = {
    id: randomUUID(),
    goal: goal.trim(),
    status: "running",
    steps: [],
    summary: "Starting autonomous browser workflow",
    url: "",
    title: "",
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
  active.summary = "Confirmed. Continuing the browser workflow";
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
  return active;
}

export function browserTaskStatus() { return active; }
