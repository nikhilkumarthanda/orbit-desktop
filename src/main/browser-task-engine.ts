import { randomUUID } from "node:crypto";
import * as browser from "./embedded-browser.js";
import { handleCareerCommand } from "./career-agent.js";
import { answerWithGemini, geminiStatus } from "./gemini.js";
import { ollamaStatus, planBrowserActionWithOllama } from "./ollama.js";
import type { BrowserTask, BrowserTaskAction, BrowserTaskEvent, EmbeddedBrowserState } from "../shared/contracts.js";

const riskyLabels = /\b(?:send|submit(?:\s+application)?|purchase|buy|pay|book|publish|post|delete|remove|confirm order|place order|accept|agree|connect)\b/i;
const MAX_STEPS = 20;
const STEP_TIMEOUT_MS = 105_000;
const ACTION_TIMEOUT_MS = 25_000;
const WORKFLOW_TIMEOUT_MS = 240_000;
const LOOP_RECOVERY_MARKER = "__orbit_loop_recovery__";
const MAX_LOOP_RECOVERIES = 2;
const SUPPORTED_ACTIONS = ["navigate", "new_tab", "switch_tab", "close_tab", "back", "forward", "reload", "click", "fill", "select", "scroll", "wait", "complete", "ask_user"] as const;
const NAMED_SITES: Array<[RegExp, string]> = [
  [/\bwikipedia\b/i, "https://en.wikipedia.org"],
  [/\bgithub\b/i, "https://github.com"],
  [/\bnpm(?:js)?\b/i, "https://www.npmjs.com"],
  [/\belectron(?:js)?\b/i, "https://www.electronjs.org"],
  [/\byoutube\b/i, "https://www.youtube.com"],
  [/\bamazon\b/i, "https://www.amazon.com"],
  [/\blinkedin\b/i, "https://www.linkedin.com"],
  [/\bjobright\b/i, "https://jobright.ai"],
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

function youtubePlayTerms(goal: string) {
  if (!/\byoutube\b/i.test(goal) || !/\bplay\b/i.test(goal)) return "";
  return goal
    .replace(/^(?:hey\s+orbit[,;:\s-]*)?/i, "")
    .replace(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?/i, "")
    .replace(/\bplay\b/gi, " ")
    .replace(/\b(?:on\s+)?youtube\b/gi, " ")
    .replace(/\b(?:for\s+me|please|now)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTerms(goal: string) {
  const play = youtubePlayTerms(goal);
  if (play) return play;
  const match = goal.match(/\b(?:search|look\s+up|find)(?:\s+(?:on|in))?\s+(?:github|wikipedia|youtube|amazon|npm(?:js)?)?\s*(?:for\s+)?(.+?)(?=,\s*(?:and|then)\b|\s+and\s+(?:tell|show|give|report|find out|open)\b|$)/i);
  return match?.[1]?.trim().replace(/^the\s+/i, "") || "";
}

function deterministicSearchUrl(goal: string) {
  const query = searchTerms(goal);
  if (!query) return "";
  if (/\bgithub\b/i.test(goal)) return `https://github.com/search?q=${encodeURIComponent(query.slice(0, 180))}&type=repositories`;
  if (/\bwikipedia\b/i.test(goal)) return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query.slice(0, 180))}`;
  if (/\byoutube\b/i.test(goal)) return `https://www.youtube.com/results?search_query=${encodeURIComponent(query.slice(0, 180))}`;
  if (/\bnpm(?:js)?\b/i.test(goal)) return `https://www.npmjs.com/search?q=${encodeURIComponent(query.slice(0, 180))}`;
  if (/\bamazon\b/i.test(goal)) return `https://www.amazon.com/s?k=${encodeURIComponent(query.slice(0, 180))}`;
  return "";
}

function initialGoalUrl(goal: string) {
  return deterministicSearchUrl(goal) || explicitGoalUrl(goal);
}

function directCareerCommand(goal: string) {
  const text = goal.trim();
  return /\b(?:career|application)\s+profile\b/i.test(text)
    || /\b(?:inspect|review|analy[sz]e|read|summari[sz]e)\b.*\b(?:job|role|posting|description|application|form)\b/i.test(text)
    || /\b(?:autofill|auto-fill|fill)\b.*\b(?:application|form)\b/i.test(text)
    || /\b(?:draft|write|create)\b.*\b(?:recruiter|hiring manager|outreach|connection note|linkedin message)\b/i.test(text)
    || /\b(?:show|list|mark|track|save)\b.*\b(?:applications?|job tracker|career tracker|applied|application|job)\b/i.test(text);
}

function requiresReasoningAfterNavigation(goal: string) {
  return /\b(?:play|tell\s+me|summari[sz]e|compare|explain|read\s+(?:this|the)|find\s+out|report|what\s+(?:is|are|was|were)|who\s+is|when\s+(?:is|was|did)|where\s+(?:is|was)|why\b|how\b|open\s+(?:the\s+)?(?:first|second|third|next|result|article|repository|repo|release|issue))\b/i.test(goal);
}

function youtubeUrl(url: string) {
  try { return /(?:^|\.)youtube\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
}

function youtubeWatchUrl(url: string) {
  try {
    const parsed = new URL(url);
    return /(?:^|\.)youtube\.com$/i.test(parsed.hostname) && parsed.pathname === "/watch" && Boolean(parsed.searchParams.get("v"));
  } catch { return false; }
}

function youtubeSearchMatches(url: string, target: string) {
  try {
    const current = new URL(url);
    const expected = new URL(target);
    return /(?:^|\.)youtube\.com$/i.test(current.hostname)
      && current.pathname.startsWith("/results")
      && current.searchParams.get("search_query") === expected.searchParams.get("search_query");
  } catch { return false; }
}

function youtubeResultControl(query: string, controls: Array<{ kind: string; label: string }>) {
  const stop = new Set(["the", "a", "an", "and", "or", "of", "to", "for", "on", "in", "official", "video"]);
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !stop.has(token));
  const candidates = controls
    .filter(control => /^(?:a|link)$/i.test(control.kind) && control.label.trim().length >= 4)
    .filter(control => !/^(?:home|shorts|subscriptions|you|history|sign in|youtube|explore|trending)$/i.test(control.label.trim()))
    .map(control => {
      const label = control.label.toLowerCase();
      const score = tokens.reduce((total, token) => total + (label.includes(token) ? 3 : 0), 0)
        + (/trailer/i.test(query) && /trailer/i.test(label) ? 2 : 0)
        + (label.includes(query.toLowerCase()) ? 6 : 0);
      return { control, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.control || null;
}

function deterministicGoalSatisfied(goal: string, pageUrl: string, pageText: string) {
  const play = youtubePlayTerms(goal);
  if (play) return youtubeWatchUrl(pageUrl);
  if (requiresReasoningAfterNavigation(goal)) return false;
  const target = initialGoalUrl(goal);
  if (!target || !usablePage(pageUrl, pageText)) return false;
  try {
    const current = new URL(pageUrl);
    const expected = new URL(target);
    if (current.hostname !== expected.hostname) return false;
    const search = deterministicSearchUrl(goal);
    if (search) {
      if (/github\.com$/i.test(current.hostname)) return current.pathname.startsWith("/search") && Boolean(current.searchParams.get("q"));
      if (/wikipedia\.org$/i.test(current.hostname)) return current.pathname.includes("/w/index.php") || current.searchParams.has("search");
      if (/youtube\.com$/i.test(current.hostname)) return current.pathname.startsWith("/results") && Boolean(current.searchParams.get("search_query"));
      if (/npmjs\.com$/i.test(current.hostname)) return current.pathname.startsWith("/search") && Boolean(current.searchParams.get("q"));
      if (/amazon\.com$/i.test(current.hostname)) return current.pathname.startsWith("/s") && Boolean(current.searchParams.get("k"));
    }
    return sameDestination(pageUrl, target);
  } catch {}
  return false;
}

function wantsNewTab(goal: string) {
  return /\b(?:open|create|start|add|use)\b[^.?!]{0,50}\bnew\s+(?:orbit\s+browser\s+)?tab\b|\b(?:in|into)\s+(?:a\s+)?new\s+(?:orbit\s+browser\s+)?tab\b/i.test(goal);
}

function tabOrdinal(goal: string) {
  const match = goal.match(/\b(?:switch|go|move|return)\s+(?:back\s+)?to\s+(?:the\s+)?(first|second|third|fourth|fifth|last|previous|next|\d+(?:st|nd|rd|th)?)\s+(?:orbit\s+browser\s+)?tab\b/i);
  if (!match) return null;
  const value = match[1].toLowerCase();
  const named: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
  if (value in named) return named[value];
  if (value === "last") return -1;
  if (value === "previous") return -2;
  if (value === "next") return -3;
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) ? Math.max(0, numeric - 1) : null;
}

function tabSubject(goal: string) {
  const match = goal.match(/\b(?:switch|go|move|return)\s+(?:back\s+)?to\s+(?:the\s+)?([a-z0-9._-]+)\s+(?:orbit\s+browser\s+)?tab\b/i);
  const value = match?.[1]?.toLowerCase() || "";
  if (!value || /^(?:first|second|third|fourth|fifth|last|previous|next|\d+)/.test(value)) return "";
  return value;
}

function deterministicNativeIntent(goal: string) {
  return wantsNewTab(goal)
    || /\b(?:close|remove)\s+(?:this|current|active|the)?\s*(?:orbit\s+browser\s+)?tab\b/i.test(goal)
    || /^(?:please\s+)?(?:go\s+)?back\b/i.test(goal.trim())
    || /^(?:please\s+)?(?:go\s+)?forward\b/i.test(goal.trim())
    || /^(?:please\s+)?(?:reload|refresh)(?:\s+(?:this|the)\s+page)?\b/i.test(goal.trim())
    || tabOrdinal(goal) !== null
    || Boolean(tabSubject(goal));
}

function deterministicNativeAction(goal: string, state: EmbeddedBrowserState): BrowserTaskAction | null {
  if (wantsNewTab(goal)) {
    const url = initialGoalUrl(goal);
    return { type: "new_tab", ...(url ? { url } : {}), reason: url ? `Opening a new Orbit Browser tab at ${new URL(url).hostname}` : "Opening a new Orbit Browser tab" };
  }
  if (/\b(?:close|remove)\s+(?:this|current|active|the)?\s*(?:orbit\s+browser\s+)?tab\b/i.test(goal)) return { type: "close_tab", tabId: state.activeTabId, reason: "Closing the active Orbit Browser tab" };
  if (/^(?:please\s+)?(?:go\s+)?back\b/i.test(goal.trim())) return { type: "back", reason: "Going back in the active Orbit Browser tab" };
  if (/^(?:please\s+)?(?:go\s+)?forward\b/i.test(goal.trim())) return { type: "forward", reason: "Going forward in the active Orbit Browser tab" };
  if (/^(?:please\s+)?(?:reload|refresh)(?:\s+(?:this|the)\s+page)?\b/i.test(goal.trim())) return { type: "reload", reason: "Reloading the active Orbit Browser tab" };
  const subject = tabSubject(goal);
  if (subject) {
    const match = state.tabs.find(tab => `${tab.title} ${tab.url}`.toLowerCase().includes(subject));
    if (match) return { type: "switch_tab", tabId: match.id, reason: `Switching to the ${subject} Orbit Browser tab` };
  }
  const ordinal = tabOrdinal(goal);
  if (ordinal !== null && state.tabs.length) {
    const currentIndex = Math.max(0, state.tabs.findIndex(tab => tab.id === state.activeTabId));
    const index = ordinal === -1 ? state.tabs.length - 1 : ordinal === -2 ? Math.max(0, currentIndex - 1) : ordinal === -3 ? Math.min(state.tabs.length - 1, currentIndex + 1) : Math.min(state.tabs.length - 1, ordinal);
    return { type: "switch_tab", tabId: state.tabs[index]?.id, tabIndex: index, reason: `Switching to Orbit Browser tab ${index + 1}` };
  }
  return null;
}

function nativeActionCompletesImmediately(action: BrowserTaskAction) {
  return ["back", "forward", "reload", "close_tab", "switch_tab"].includes(action.type) || (action.type === "new_tab" && !action.url);
}

function sameDestination(current: string, target: string) {
  try {
    const currentUrl = new URL(current);
    const targetUrl = new URL(target);
    const normalizedCurrentPath = currentUrl.pathname.replace(/\/$/, "") || "/";
    const normalizedTargetPath = targetUrl.pathname.replace(/\/$/, "") || "/";
    if (currentUrl.hostname !== targetUrl.hostname || (normalizedTargetPath !== "/" && normalizedCurrentPath !== normalizedTargetPath)) return false;
    if (targetUrl.search) return currentUrl.search === targetUrl.search;
    return normalizedTargetPath === "/" || normalizedCurrentPath === normalizedTargetPath;
  } catch { return false; }
}

function usablePage(url: string, text: string) { return /^https?:\/\//i.test(url) && text.trim().length >= 20; }

async function dynamicPageSnapshot(goal: string) {
  let page = await browser.actionSnapshot();
  const playQuery = youtubePlayTerms(goal);
  if (!playQuery || !youtubeUrl(page.url) || usablePage(page.url, page.text) || youtubeWatchUrl(page.url) || youtubeResultControl(playQuery, page.controls)) return page;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (cancelled) throw new Error("Browser task cancelled");
    if (active) active.summary = `Waiting for YouTube to finish rendering · ${attempt}/4`;
    await new Promise(resolve => setTimeout(resolve, 900 + attempt * 350));
    page = await browser.actionSnapshot();
    if (usablePage(page.url, page.text) || youtubeWatchUrl(page.url) || youtubeResultControl(playQuery, page.controls)) break;
  }
  return page;
}

function githubSecondaryRateLimit(url: string, text: string) {
  try { if (!/(?:^|\.)github\.com$/i.test(new URL(url).hostname)) return false; }
  catch { return false; }
  const normalized = text.toLowerCase();
  return normalized.includes("secondary rate limit") || (normalized.includes("too many requests") && normalized.includes("please wait"));
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
  if (action.type !== "navigate" && action.type !== "new_tab") return action;
  if (action.type === "new_tab" && !action.url) return action;
  const url = repairedNavigationUrl(action.url, currentUrl);
  if (url) return { ...action, url };
  const label = action.label?.trim();
  if (action.type === "navigate" && label) return { type: "click", label, reason: action.reason || `Using the visible “${label}” control instead of an invalid navigation target` };
  return { type: "wait", reason: "Re-inspecting the page because the planner omitted a valid navigation URL" };
}

function actionSignature(action: BrowserTaskAction) {
  return [action.type, action.url || "", action.label || "", action.value || "", action.direction || "", action.tabId || "", action.tabIndex ?? ""].map(value => String(value).trim().toLowerCase()).join("|");
}

function pageFingerprint(page: { url: string; title: string; text: string }) { return `${page.url}|${page.title}|${page.text.slice(0, 1600)}`; }

function avoidActionLoop(action: BrowserTaskAction, page: { url: string; controls: Array<{ kind: string; label: string }> }, steps: BrowserTask["steps"]): BrowserTaskAction {
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
    if (submit) return { type: "click", label: submit.label, reason: `Submitting with “${submit.label}” instead of repeating the same fill action` };
  }
  if (action.type === "wait" && stagnantPageRounds < 4) return { type: "scroll", direction: "down", reason: "The page did not change, so Orbit is inspecting more content instead of waiting again" };
  if (action.type === "navigate" && action.url && sameDestination(page.url, action.url) && stagnantPageRounds < 4) return { type: "scroll", direction: "down", reason: "Orbit is already at that destination, so it is inspecting the page instead of reopening it" };
  if (action.type === "scroll" && recentMatches >= 2 && stagnantPageRounds < 4) return { type: "scroll", direction: action.direction === "up" ? "down" : "up", reason: "Orbit detected repeated scrolling without progress and changed direction" };
  if (recentMatches >= 3 || stagnantPageRounds >= 4) return { type: "wait", reason: LOOP_RECOVERY_MARKER };
  return action;
}

function transientGeminiFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /quota|rate.?limit|resource.?exhausted|429|too many requests|high demand|try again later|temporar(?:y|ily)|overload(?:ed)?|service(?:\s+is)?(?:\s+currently)?\s+unavailable|currently\s+unavailable|\b503\b|timeout|timed.?out|aborted|aborterror/i.test(message);
}

function retryDelayMs(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const seconds = Number(message.match(/retry\s+in\s+(\d+(?:\.\d+)?)s/i)?.[1] || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 12_000;
  return Math.min(20_000, Math.ceil(seconds * 1000) + 500);
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
        if (active) { active.summary = "Gemini temporarily unavailable — continuing locally"; emit(listener, "status", active.summary); }
        return planBrowserActionWithOllama({ prompt });
      }
      const delay = retryDelayMs(error);
      if (active) { active.summary = `Gemini temporarily unavailable — retrying in ${Math.ceil(delay / 1000)}s`; emit(listener, "status", active.summary); }
      await new Promise(resolve => setTimeout(resolve, delay));
      if (cancelled) throw new Error("Browser task cancelled");
      setPlanner("gemini", listener);
      return parseBrowserAction(await answerWithGemini({ query: prompt, history: [] }));
    }
  }
  const local = await ollamaStatus();
  if (!local.available) throw new Error("Orbit needs Gemini or the local qwen3:4b model to reason about this browser step");
  setPlanner("ollama", listener);
  if (active) { active.summary = "Planning browser step locally"; emit(listener, "status", active.summary); }
  return planBrowserActionWithOllama({ prompt });
}

async function nextAction(goal: string, steps: BrowserTask["steps"], listener: (event: BrowserTaskEvent) => void): Promise<BrowserTaskAction> {
  if (!active) throw new Error("No browser task is active");
  const browserState = browser.embeddedBrowserState() as EmbeddedBrowserState;
  const native = deterministicNativeAction(goal, browserState);
  if (!steps.length && native) return native;
  if (steps.length && native && nativeActionCompletesImmediately(steps[0].action) && steps[0].action.type === native.type) return { type: "complete", reason: steps[0].outcome || "Orbit Browser action completed" };
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
  active.summary = steps.length ? "Inspecting the updated page" : "Inspecting the active Orbit Browser tab";
  emit(listener, "status", active.summary);
  const page = await dynamicPageSnapshot(goal);
  if (cancelled) throw new Error("Browser task cancelled");
  active.url = page.url;
  active.title = page.title;
  if (githubSecondaryRateLimit(page.url, page.text)) throw new Error("GITHUB_SECONDARY_RATE_LIMIT");

  const playQuery = youtubePlayTerms(goal);
  const playTarget = playQuery ? deterministicSearchUrl(goal) : "";
  if (playQuery && youtubeWatchUrl(page.url)) {
    return { type: "complete", reason: `Opened the matching YouTube video for “${playQuery}” in Orbit Browser` };
  }
  if (playQuery && youtubeUrl(page.url)) {
    if (playTarget && !youtubeSearchMatches(page.url, playTarget)) {
      return { type: "navigate", url: playTarget, reason: `Correcting YouTube to the search results for “${playQuery}” before inspecting the page` };
    }
    const result = youtubeResultControl(playQuery, page.controls);
    if (result) return { type: "click", label: result.label, reason: `Opening the best matching YouTube result for “${playQuery}”` };
  }

  const fingerprint = pageFingerprint(page);
  if (fingerprint === lastPageFingerprint) stagnantPageRounds += 1;
  else { lastPageFingerprint = fingerprint; stagnantPageRounds = 0; loopRecoveryAttempts = 0; }
  if (deterministicGoalSatisfied(goal, page.url, page.text)) {
    const query = searchTerms(goal);
    return { type: "complete", reason: query ? `Search results are open in Orbit Browser for “${query}”` : "The requested page is open in Orbit Browser" };
  }
  if (!usablePage(page.url, page.text)) {
    const goalUrl = initialGoalUrl(goal);
    if (goalUrl && !sameDestination(page.url, goalUrl)) return { type: "navigate", url: goalUrl, reason: `Opening ${new URL(goalUrl).hostname} inside Orbit` };
    if (playQuery && youtubeUrl(page.url)) {
      const youtubeRecoverySteps = steps.filter(step => /YouTube/i.test(step.outcome || step.action.reason || "")).length;
      const alreadyReloaded = steps.some(step => step.action.type === "reload");
      if (youtubeRecoverySteps < 2) return { type: "wait", reason: "YouTube search results are still rendering; Orbit is keeping the tab open and re-inspecting instead of failing" };
      if (!alreadyReloaded) return { type: "reload", reason: "YouTube search results are still sparse, so Orbit is reloading this tab once and preserving the search" };
      if (youtubeRecoverySteps < 4) return { type: "wait", reason: "YouTube is still hydrating the results; Orbit is making one more bounded re-inspection" };
      throw new Error("YouTube stayed on the requested search but did not expose a playable result to Orbit after bounded recovery");
    }
    throw new Error("The active Orbit Browser page did not finish loading, so Orbit did not continue from model memory");
  }
  active.summary = `Planning browser step ${steps.length + 1}`;
  emit(listener, "status", active.summary);
  const history = steps.slice(-6).map(step => `${step.action.type}: ${step.action.label || step.action.url || step.action.tabId || ""} -> ${step.outcome}`).join("\n");
  const noProgress = stagnantPageRounds > 0 ? `\nProgress warning: the visible page has been materially unchanged for ${stagnantPageRounds} planning round(s). Do NOT repeat the same action; choose a different control/action that can advance the goal.` : "";
  const latestState = browser.embeddedBrowserState() as EmbeddedBrowserState;
  const tabContext = latestState.tabs.map((tab, index) => ({ index, id: tab.id, active: tab.id === latestState.activeTabId, title: tab.title, url: tab.url }));
  const prompt = `You are Orbit's browser controller. Orbit Browser is a native multi-tab browser. Choose exactly one safe next action to advance the user's goal.\nGoal: ${goal}\nActive page: ${page.title} (${page.url})\nOrbit Browser tabs: ${JSON.stringify(tabContext)}\nRecent steps:\n${history || "none"}${noProgress}\nVisible controls: ${JSON.stringify(page.controls.slice(0, 60))}\nVisible text: ${page.text.slice(0, 7000)}\nReturn JSON only: {"type":"navigate|new_tab|switch_tab|close_tab|back|forward|reload|click|fill|select|scroll|wait|complete|ask_user","url":"","label":"","value":"","direction":"down|up","tabId":"","tabIndex":0,"reason":"short explanation"}. Prefer native tab/navigation actions when they match the user's request. Opening an Apply or Easy Apply flow is allowed without confirmation because it does not submit an application. Final submission, sending a message, connecting, posting/publishing, purchasing, paying, deleting, accepting, agreeing, or other consequential external actions MUST use ask_user immediately before the action. Never guess or fill work authorization, sponsorship, visa, citizenship, salary/compensation, demographic/EEO, disability, veteran, identity, authentication, signature, or attestation fields; use ask_user for those. For navigate/new_tab with a URL, url MUST be an absolute http:// or https:// URL. Use tabId from Orbit Browser tabs when switching or closing a specific tab. Use labels exactly as shown for page controls. Never repeat a failed action. Use complete only when the goal is visibly satisfied. Never answer from memory instead of using the browser. Never enter passwords, payment data, government IDs, or authentication codes.`;
  const normalized = normalizePlannedAction(await planBrowserStep(prompt, listener), page.url);
  let parsed = avoidActionLoop(normalized, page, steps);
  if (parsed.type === "wait" && parsed.reason === LOOP_RECOVERY_MARKER) {
    loopRecoveryAttempts += 1;
    const forbidden = [...new Set(steps.slice(-6).map(step => actionSignature(step.action)))];
    if (active) { active.summary = `Recovering from repeated browser actions · attempt ${loopRecoveryAttempts}/${MAX_LOOP_RECOVERIES}`; emit(listener, "status", active.summary); }
    const recoveryPrompt = `${prompt}\nRECOVERY MODE: The previous plan is stuck. You MUST choose an action whose signature is NOT in this forbidden list: ${JSON.stringify(forbidden)}. Do not reverse-scroll back and forth. Do not refill the same field. Do not reopen the same URL. If another Orbit Browser tab is relevant, you may switch_tab. If the visible text already satisfies the user's goal, choose complete now. Otherwise choose a genuinely different visible control or safe action that advances the goal.`;
    const recovered = normalizePlannedAction(await planBrowserStep(recoveryPrompt, listener), page.url);
    const recoveredSignature = actionSignature(recovered);
    if (forbidden.includes(recoveredSignature)) {
      const recentLabels = new Set(steps.slice(-6).map(step => String(step.action.label || "").trim().toLowerCase()).filter(Boolean));
      const alternate = page.controls.find(control => {
        const label = control.label.trim();
        if (!label || recentLabels.has(label.toLowerCase())) return false;
        return /button|a|link|submit/i.test(control.kind) && /\b(?:search|result|article|release|issues?|next|more|details?|read|view|open|apply)\b/i.test(label);
      });
      if (alternate) parsed = { type: "click", label: alternate.label, reason: `Loop recovery selected a different visible control: “${alternate.label}”` };
      else if (latestState.tabs.length > 1 && latestState.tabs.some(tab => tab.id !== latestState.activeTabId)) {
        const alternateTab = latestState.tabs.find(tab => tab.id !== latestState.activeTabId)!;
        parsed = { type: "switch_tab", tabId: alternateTab.id, reason: "Loop recovery is checking another Orbit Browser tab for relevant context" };
      } else if (loopRecoveryAttempts < MAX_LOOP_RECOVERIES) parsed = { type: "scroll", direction: "down", reason: "Loop recovery is inspecting a new part of the page before replanning" };
      else throw new Error(`Orbit could not find a new safe browser path after ${MAX_LOOP_RECOVERIES} recovery attempts`);
    } else { parsed = recovered; stagnantPageRounds = Math.max(0, stagnantPageRounds - 2); }
  }
  if (!(SUPPORTED_ACTIONS as readonly string[]).includes(parsed.type)) throw new Error("Orbit's browser planner returned an unsupported action");
  if (parsed.type === "complete" && !usablePage(page.url, page.text) && !youtubeWatchUrl(page.url)) throw new Error("Orbit refused to complete a browser task from an unloaded page");
  return parsed;
}

async function act(action: BrowserTaskAction) {
  if ((action.type === "click" && riskyLabels.test(action.label || "")) || action.type === "ask_user") return { pause: true, outcome: action.reason || `Approval required before ${action.label || "continuing"}` };
  if (action.type === "navigate") await browser.openUrl(publicUrl(action.url || ""));
  else if (action.type === "new_tab") await browser.newTab(action.url ? publicUrl(action.url) : undefined);
  else if (action.type === "switch_tab") {
    const state = browser.embeddedBrowserState() as EmbeddedBrowserState;
    const id = action.tabId || (Number.isInteger(action.tabIndex) ? state.tabs[action.tabIndex!]?.id : "");
    if (!id) throw new Error("Orbit could not resolve the requested browser tab");
    await browser.switchTab(id);
  }
  else if (action.type === "close_tab") {
    const state = browser.embeddedBrowserState() as EmbeddedBrowserState;
    const id = action.tabId || state.activeTabId;
    if (!id) throw new Error("Orbit could not resolve the tab to close");
    await browser.closeTab(id);
  }
  else if (action.type === "back") await browser.goBack();
  else if (action.type === "forward") await browser.goForward();
  else if (action.type === "reload") await browser.reload();
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
  active.summary = "Starting Orbit Browser workflow";
  emit(listener, "status", active.summary);
  try {
    for (let round = active.steps.length; round < MAX_STEPS; round++) {
      if (!active || active.id !== taskId) return active;
      if (cancelled) { active.status = "cancelled"; active.summary = "Browser task stopped"; emit(listener, "status", active.summary); return active; }
      if (Date.now() - startedAt >= WORKFLOW_TIMEOUT_MS) { active.status = "paused"; active.summary = "Orbit paused this browser workflow after 4 minutes. The Orbit Browser session remains open at the last verified step."; emit(listener, "status", active.summary); return active; }
      const action = await withTimeout(nextAction(active.goal, active.steps, listener), STEP_TIMEOUT_MS, "The browser planner took too long on this step");
      if (!active || active.id !== taskId) return active;
      if (cancelled) { active.status = "cancelled"; active.summary = "Browser task stopped before the next action"; emit(listener, "status", active.summary); return active; }
      if (action.type === "complete") { active.status = "completed"; active.summary = action.reason || "Browser task completed"; emit(listener, "status", active.summary); return active; }
      active.summary = action.reason || `Executing ${action.type}`;
      emit(listener, "status", active.summary);
      const result = await withTimeout(act(action), ACTION_TIMEOUT_MS, `The ${action.type} action took too long`);
      active.steps.push({ at: new Date().toISOString(), action, outcome: result.outcome });
      active.url = await browser.currentUrl();
      active.title = await browser.pageTitle();
      if (result.pause) { active.status = "waiting_for_confirmation"; active.pendingAction = action; active.summary = result.outcome; emit(listener, "status", active.summary); return active; }
      emit(listener, "step", `${result.outcome} · Step ${active.steps.length} verified`);
    }
    if (active && active.id === taskId) { active.status = "paused"; active.summary = `Orbit reached the ${MAX_STEPS}-step safety limit. Review the Orbit Browser before continuing.`; emit(listener, "status", active.summary); }
    return active;
  } catch (error) {
    if (!active || active.id !== taskId) return active;
    if (cancelled || (error instanceof Error && /cancelled/i.test(error.message))) { active.status = "cancelled"; active.summary = "Browser task stopped"; }
    else {
      const detail = error instanceof Error ? error.message : "an unknown browser-agent error occurred";
      const githubRateLimited = detail === "GITHUB_SECONDARY_RATE_LIMIT" || /secondary rate limit|too many requests/i.test(detail);
      const providerUnavailable = /service(?:\s+is)?(?:\s+currently)?\s+unavailable|currently\s+unavailable|\b503\b|quota|rate.?limit|resource.?exhausted|429|high demand|overload/i.test(detail);
      const timedOut = /timeout|timed.?out|aborted|aborterror/i.test(detail);
      active.status = githubRateLimited || providerUnavailable || timedOut ? "paused" : "failed";
      const friendly = githubRateLimited
        ? "GitHub temporarily rate-limited this Orbit Browser session. Orbit stopped retrying so it does not extend the block. Wait a few minutes, or sign in to GitHub inside Orbit Browser; the persistent Orbit session will keep that login."
        : providerUnavailable
          ? "the AI planner is temporarily unavailable. The Orbit Browser session is still open; native navigation, tab controls, and supported searches remain available."
          : timedOut
            ? "the AI planner timed out before it could verify the next reasoning step. The current Orbit Browser session remains open."
            : detail;
      active.summary = `${active.status === "paused" ? "Orbit paused the browser workflow" : "Orbit paused the embedded browser safely"}: ${friendly}`;
    }
    emit(listener, "status", active.summary);
    return active;
  }
}

export async function startBrowserTask(goal: string, listener: (event: BrowserTaskEvent) => void) {
  const cleanGoal = goal.trim();
  if (!cleanGoal) throw new Error("Tell Orbit what you want the browser to accomplish");
  if (active?.status === "running") throw new Error("Orbit is already running a browser task. Stop it before starting another one.");

  if (directCareerCommand(cleanGoal)) {
    cancelled = false;
    const result = await handleCareerCommand(cleanGoal);
    const state = browser.embeddedBrowserState();
    active = {
      id: randomUUID(), goal: cleanGoal, status: "completed", steps: [], summary: String(result.summary || "Career Mode action completed"),
      url: state.url || "", title: state.title || "Orbit Career Mode",
    };
    emit(listener, "status", active.summary);
    return active;
  }

  const geminiReady = geminiStatus().available;
  const deterministic = Boolean(initialGoalUrl(cleanGoal) || deterministicNativeIntent(cleanGoal));
  const local = deterministic ? null : await ollamaStatus();
  if (!deterministic && !geminiReady && !local?.available) throw new Error("Connect Gemini or start the local qwen3:4b model before starting a browser task that requires AI reasoning");
  cancelled = false;
  lastPageFingerprint = "";
  stagnantPageRounds = 0;
  loopRecoveryAttempts = 0;
  await browser.showEmbeddedBrowser();
  active = {
    id: randomUUID(), goal: cleanGoal, status: "running", steps: [], summary: deterministic ? "Using Orbit Browser's native controls" : "Opening Orbit Browser",
    url: await browser.currentUrl(), title: await browser.pageTitle(), planner: geminiReady ? "gemini" : local?.available ? "ollama" : undefined,
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
  active.summary = "Confirmed. Continuing the Orbit Browser workflow";
  cancelled = false;
  const taskId = active.id;
  emit(listener, "step", `Confirmed action completed · Step ${active.steps.length} verified`);
  void run(taskId, listener);
  return active;
}

export function cancelBrowserTask() {
  cancelled = true;
  if (active && !["completed", "failed", "cancelled"].includes(active.status)) { active.status = "cancelled"; active.summary = "Browser task stopped"; }
  browser.hideEmbeddedBrowser();
  return active;
}

export function browserTaskStatus() { return active; }
