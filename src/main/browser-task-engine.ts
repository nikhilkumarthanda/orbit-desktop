import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import * as browser from "./embedded-browser.js";
import { careerProfileSetupFieldLabel, careerProfileSetupQuestion, handleCareerCommand, saveCareerProfileSetupAnswer, type CareerProfileSetupField } from "./career-agent.js";
import { answerWithGemini, geminiStatus } from "./gemini.js";
import { ollamaStatus, planBrowserActionWithOllama } from "./ollama.js";
import type { BrowserTask, BrowserTaskAction, BrowserTaskEvent, EmbeddedBrowserState } from "../shared/contracts.js";

const riskyLabels = /\b(?:send|submit(?:\s+application)?|purchase|buy|pay|book|publish|post|delete|remove|confirm order|place order|accept|agree|connect)\b/i;
const manualOnlyInput = /\b(?:password|passcode|one[- ]?time(?:\s+password|\s+code)?|otp|mfa|2fa|verification code|auth(?:entication)? code|captcha|social security|ssn|government id|passport(?: number)?|driver'?s license(?: number)?)\b/i;
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
let approvedConsequentialLabel = "";
let resumeInputContext: { question: string; answer: string } | null = null;
let careerProfileSetup: { originalGoal: string; currentField: CareerProfileSetupField } | null = null;
type DirectCareerResult = {
  summary?: string;
  requiresProfileSetup?: boolean;
  nextProfileField?: CareerProfileSetupField;
  requiresApproval?: boolean;
  approvalLabel?: string;
  requiresInput?: boolean;
  inputLabel?: string;
  requiresManualTakeover?: boolean;
  manualLabel?: string;
  checkpoint?: unknown;
};
let careerWorkflowResume: { originalGoal: string; mode: "input"|"manual"|"approval"; fieldLabel?: string } | null = null;

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

function applyCareerResult(result: DirectCareerResult, originalGoal: string, listener: (event: BrowserTaskEvent) => void) {
  if (!active) throw new Error("Orbit lost the active Career task");
  active.pendingAction = undefined;
  active.pendingKind = undefined;
  active.summary = String(result.summary || "Career Mode action completed");

  if (result.requiresProfileSetup && result.nextProfileField) {
    careerWorkflowResume = null;
    careerProfileSetup = { originalGoal, currentField: result.nextProfileField };
    active.status = "waiting_for_confirmation";
    active.pendingKind = "input";
    active.pendingAction = {
      type: "ask_user",
      label: `Career profile: ${careerProfileSetupFieldLabel(result.nextProfileField)}`,
      reason: active.summary || careerProfileSetupQuestion(result.nextProfileField),
    };
  } else if (result.requiresApproval && result.approvalLabel) {
    careerProfileSetup = null;
    careerWorkflowResume = { originalGoal, mode: "approval" };
    active.status = "waiting_for_confirmation";
    active.pendingKind = "approval";
    active.pendingAction = {
      type: "click",
      label: result.approvalLabel,
      reason: active.summary,
    };
  } else if (result.requiresManualTakeover && result.manualLabel) {
    careerProfileSetup = null;
    careerWorkflowResume = { originalGoal, mode: "manual", fieldLabel: result.manualLabel };
    active.status = "waiting_for_confirmation";
    active.pendingKind = "input";
    active.pendingAction = {
      type: "ask_user",
      label: result.manualLabel,
      reason: active.summary,
    };
  } else if (result.requiresInput && result.inputLabel) {
    careerProfileSetup = null;
    careerWorkflowResume = { originalGoal, mode: "input", fieldLabel: result.inputLabel };
    active.status = "waiting_for_confirmation";
    active.pendingKind = "input";
    active.pendingAction = {
      type: "ask_user",
      label: result.inputLabel,
      reason: active.summary,
    };
  } else {
    careerProfileSetup = null;
    careerWorkflowResume = null;
    active.status = "completed";
  }
  emit(listener, "status", active.summary);
  return active;
}

function setPlanner(planner: "gemini"|"ollama", listener?: (event: BrowserTaskEvent) => void) {
  if (!active) return;
  const changed = active.planner !== planner;
  active.planner = planner;
  if (changed && listener) emit(listener, "status", planner === "ollama" ? "Browser planning switched to Local Ollama" : "Browser planning with Gemini");
}

function activeLinkedInJobsContext() {
  try {
    const url = new URL(String(browser.embeddedBrowserState().url || ""));
    return /(?:^|\.)linkedin\.com$/i.test(url.hostname) && url.pathname.startsWith("/jobs");
  } catch { return false; }
}

function linkedinJobViewUrl(url: string) {
  try {
    const parsed = new URL(url);
    return /(?:^|\.)linkedin\.com$/i.test(parsed.hostname) && /\/jobs\/view\/\d+/.test(parsed.pathname);
  } catch { return false; }
}

function linkedinResultOrdinal(goal: string) {
  if (!activeLinkedInJobsContext() && !/\blinkedin\b/i.test(goal)) return null;
  const match = goal.match(/\b(?:open|show|view)\s+(?:the\s+)?(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\s+(?:one|job|role|result)?\b/i);
  if (!match) return null;
  const named: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };
  const token = match[1].toLowerCase();
  if (token in named) return named[token];
  const number = Number.parseInt(token, 10);
  return Number.isFinite(number) ? Math.max(0, number - 1) : null;
}

function linkedinJobKeywords(goal: string) {
  const text = goal.trim();
  let match = text.match(/\b(?:search|find|look\s+for|show)\s+(?:on\s+)?linkedin(?:\s+jobs?)?\s+(?:for\s+)?(.+?)(?=\s+(?:with|using|filtered|filter(?:ed)?|posted|from|in|at)\b|$)/i);
  if (!match) match = text.match(/\b(?:search|find|look\s+for|show)\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+linkedin(?:\s+jobs?)?(?=\s|$)/i);
  if (!match && activeLinkedInJobsContext()) match = text.match(/\b(?:search|find|look\s+for|show)\s+(?:for\s+)?(.+?)(?=\s+(?:with|using|filtered|filter(?:ed)?|posted|from|in|at)\b|$)/i);
  return String(match?.[1] || "")
    .replace(/\b(?:new\s+grad(?:uate)?s?|recent\s+grad(?:uate)?s?|early\s+career|entry[- ]?level)\b/gi, " ")
    .replace(/\b(?:roles?|jobs?|positions?|openings?)\b\s*$/i, "")
    .replace(/\b(?:on|in)\s+linkedin(?:\s+jobs?)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linkedinJobsSearchUrl(goal: string) {
  const explicitLinkedIn = /\blinkedin\b/i.test(goal);
  if (!explicitLinkedIn && !activeLinkedInJobsContext()) return "";
  if (!/\b(?:search|find|look\s+for|show|jobs?|roles?)\b/i.test(goal)) return "";

  const keywords = linkedinJobKeywords(goal);
  const newGrad = /\b(?:new\s+grad(?:uate)?s?|recent\s+grad(?:uate)?s?|early\s+career|entry[- ]?level)\b/i.test(goal);
  const past24Hours = /\b(?:past|last|within)\s+(?:24\s+hours?|1\s+day)|\btoday\b/i.test(goal);
  const pastWeek = /\b(?:past|last|within)\s+(?:7\s+days?|1\s+week)\b/i.test(goal);
  const pastMonth = /\b(?:past|last|within)\s+(?:30\s+days?|1\s+month)\b/i.test(goal);
  const remote = /\bremote\b/i.test(goal);
  if (!keywords && !newGrad && !past24Hours && !pastWeek && !pastMonth && !remote) return "";

  const url = new URL("https://www.linkedin.com/jobs/search/");
  if (keywords) url.searchParams.set("keywords", keywords.slice(0, 180));
  if (newGrad) url.searchParams.set("f_E", "2");
  if (past24Hours) url.searchParams.set("f_TPR", "r86400");
  else if (pastWeek) url.searchParams.set("f_TPR", "r604800");
  else if (pastMonth) url.searchParams.set("f_TPR", "r2592000");
  if (remote) url.searchParams.set("f_WT", "2");
  return url.toString();
}

function explicitGoalUrl(goal: string) {
  const direct = goal.match(/https?:\/\/[^\s,)]+/i)?.[0];
  if (direct) return direct;
  const domain = goal.match(/\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,)]+)?\b/i)?.[0];
  if (domain) return `https://${domain}`;
  if (/\blinkedin\b[^.?!]{0,80}\bjobs?\b|\bjobs?\b[^.?!]{0,80}\blinkedin\b/i.test(goal)) return "https://www.linkedin.com/jobs/";
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
  const linkedIn = linkedinJobKeywords(goal);
  if (linkedIn) return linkedIn;
  const play = youtubePlayTerms(goal);
  if (play) return play;
  const match = goal.match(/\b(?:search|look\s+up|find)(?:\s+(?:on|in))?\s+(?:github|wikipedia|youtube|amazon|npm(?:js)?)?\s*(?:for\s+)?(.+?)(?=,\s*(?:and|then)\b|\s+and\s+(?:tell|show|give|report|find out|open)\b|$)/i);
  return match?.[1]?.trim().replace(/^the\s+/i, "") || "";
}

function deterministicSearchUrl(goal: string) {
  const linkedIn = linkedinJobsSearchUrl(goal);
  if (linkedIn) return linkedIn;
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
    || /\b(?:start|open|begin)\b.*\b(?:easy\s+apply|application)\b|\bapply\s+(?:to\s+)?(?:this|the)\s+(?:job|role)\b/i.test(text)
    || /\b(?:upload|attach|add)\b.*\b(?:resume|cv)\b/i.test(text)
    || /\b(?:continue|next|advance|proceed|save\s+and\s+continue)\b.*\b(?:application|form|step)\b/i.test(text)
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
      if (/linkedin\.com$/i.test(current.hostname)) {
        if (!current.pathname.startsWith("/jobs/search")) return false;
        for (const [key, value] of expected.searchParams.entries()) if (current.searchParams.get(key) !== value) return false;
        return true;
      }
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

  const linkedInOrdinal = linkedinResultOrdinal(goal);
  if (linkedInOrdinal !== null) {
    if (linkedinJobViewUrl(page.url)) return { type: "complete", reason: `Opened LinkedIn job result ${linkedInOrdinal + 1} while preserving the filtered search in browser history` };
    if (activeLinkedInJobsContext()) {
      const results = await browser.linkedinJobResults(Math.max(10, linkedInOrdinal + 1));
      const chosen = results[linkedInOrdinal];
      if (chosen) return { type: "navigate", url: chosen.url, reason: `Opening LinkedIn job result ${linkedInOrdinal + 1}: ${chosen.title}` };
      const attempts = steps.filter(step => /LinkedIn job results are still rendering/.test(step.outcome || step.action.reason || "")).length;
      if (attempts < 2) return { type: "wait", reason: "LinkedIn job results are still rendering; Orbit is preserving the current filters and re-inspecting the list" };
      throw new Error(`LinkedIn did not expose job result ${linkedInOrdinal + 1} after bounded re-inspection`);
    }
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
  const userResume = resumeInputContext
    ? `\nUser-provided resume context (task-scoped only): pending question/field=${JSON.stringify(resumeInputContext.question)}; explicit answer=${JSON.stringify(resumeInputContext.answer)}. Use this answer only for a clearly matching visible field/control. Do not reinterpret it as an answer to any different legal, compensation, demographic, identity, consent, or authentication question.`
    : "";
  const latestState = browser.embeddedBrowserState() as EmbeddedBrowserState;
  const tabContext = latestState.tabs.map((tab, index) => ({ index, id: tab.id, active: tab.id === latestState.activeTabId, title: tab.title, url: tab.url }));
  const prompt = `You are Orbit's browser controller. Orbit Browser is a native multi-tab browser. Choose exactly one safe next action to advance the user's goal.\nGoal: ${goal}\nActive page: ${page.title} (${page.url})\nOrbit Browser tabs: ${JSON.stringify(tabContext)}\nRecent steps:\n${history || "none"}${noProgress}${userResume}\nVisible controls: ${JSON.stringify(page.controls.slice(0, 60))}\nVisible text: ${page.text.slice(0, 7000)}\nReturn JSON only: {"type":"navigate|new_tab|switch_tab|close_tab|back|forward|reload|click|fill|select|scroll|wait|complete|ask_user","url":"","label":"","value":"","direction":"down|up","tabId":"","tabIndex":0,"reason":"short explanation"}. Prefer native tab/navigation actions when they match the user's request. Opening an Apply or Easy Apply flow is allowed without confirmation because it does not submit an application. Final submission, sending a message, connecting, posting/publishing, purchasing, paying, deleting, accepting, agreeing, or other consequential external actions MUST use ask_user immediately before the action, and that ask_user action MUST put the exact visible consequential control text in label. If recent steps say the user approved the exact next consequential control, you may click only that exact same label once; if the page or label changed, ask again. Never guess work authorization, sponsorship, visa, citizenship, salary/compensation, demographic/EEO, disability, veteran, identity, consent, signature, or attestation answers. If task-scoped user resume context explicitly supplies an answer to one of those non-secret fields, you may fill/select exactly that answer only when the visible field clearly matches the pending question; otherwise use ask_user. Never enter passwords, payment data, government IDs, SSNs, passport/license numbers, authentication/MFA/OTP codes, or CAPTCHA responses; ask the user to complete those manually, then re-inspect after they say continue. For navigate/new_tab with a URL, url MUST be an absolute http:// or https:// URL. Use tabId from Orbit Browser tabs when switching or closing a specific tab. Use labels exactly as shown for page controls. Never repeat a failed action. Use complete only when the goal is visibly satisfied. Never answer from memory instead of using the browser.`;
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

async function act(action: BrowserTaskAction): Promise<{ pause: boolean; outcome: string; pendingKind?: "approval"|"input" }> {
  const actionLabel = String(action.label || "").trim().toLowerCase();
  if (approvedConsequentialLabel && !(action.type === "click" && actionLabel === approvedConsequentialLabel)) {
    approvedConsequentialLabel = "";
  }

  if (action.type === "ask_user") {
    const pendingKind = actionLabel && riskyLabels.test(actionLabel) ? "approval" : "input";
    return { pause: true, pendingKind, outcome: action.reason || (pendingKind === "approval" ? `Approval required before ${action.label || "continuing"}` : "Orbit needs your input before it can safely continue") };
  }
  if (action.type === "click" && riskyLabels.test(action.label || "")) {
    if (!approvedConsequentialLabel || approvedConsequentialLabel !== actionLabel) return { pause: true, pendingKind: "approval", outcome: action.reason || `Approval required before ${action.label || "continuing"}` };
    approvedConsequentialLabel = "";
  }
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
  if (resumeInputContext && ["fill", "select"].includes(action.type)) resumeInputContext = null;
  return { pause: false, outcome: action.reason || `${action.type} completed` };
}

async function run(taskId: string, listener: (event: BrowserTaskEvent) => void) {
  if (!active || active.id !== taskId) return active;
  const startedAt = Date.now();
  active.status = "running";
  active.summary = active.steps.length ? "Resuming Orbit Browser workflow from the current page" : "Starting Orbit Browser workflow";
  emit(listener, "status", active.summary);
  try {
    for (let round = active.steps.length; round < MAX_STEPS; round++) {
      if (!active || active.id !== taskId) return active;
      if (cancelled) { active.status = "cancelled"; active.summary = "Browser task stopped"; emit(listener, "status", active.summary); return active; }
      if (Date.now() - startedAt >= WORKFLOW_TIMEOUT_MS) { active.status = "paused"; active.summary = "Orbit paused this browser workflow after 4 minutes. The Orbit Browser session remains open at the last verified step."; emit(listener, "status", active.summary); return active; }
      const action = await withTimeout(nextAction(active.goal, active.steps, listener), STEP_TIMEOUT_MS, "The browser planner took too long on this step");
      if (!active || active.id !== taskId) return active;
      if (cancelled) { active.status = "cancelled"; active.summary = "Browser task stopped before the next action"; emit(listener, "status", active.summary); return active; }
      if (action.type === "complete") { active.status = "completed"; active.summary = action.reason || "Browser task completed"; resumeInputContext = null; emit(listener, "status", active.summary); return active; }
      active.summary = action.reason || `Executing ${action.type}`;
      emit(listener, "status", active.summary);
      const result = await withTimeout(act(action), ACTION_TIMEOUT_MS, `The ${action.type} action took too long`);
      active.steps.push({ at: new Date().toISOString(), action, outcome: result.outcome });
      active.url = await browser.currentUrl();
      active.title = await browser.pageTitle();
      if (result.pause) {
        if (result.pendingKind === "input" && resumeInputContext) resumeInputContext = null;
        active.status = "waiting_for_confirmation";
        active.pendingAction = action;
        active.pendingKind = result.pendingKind || "input";
        active.summary = result.outcome;
        emit(listener, "status", active.summary);
        return active;
      }
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
  if (active && ["running", "waiting_for_confirmation", "paused"].includes(active.status)) {
    const waiting = active.status === "waiting_for_confirmation";
    const paused = active.status === "paused";
    throw new Error(waiting
      ? "Orbit is waiting for approval or input in the current browser task. Resolve it or stop the browser task before starting another one."
      : paused
        ? "Orbit has a resumable browser task paused at its last checkpoint. Continue it or stop it before starting another browser task."
        : "Orbit is already running a browser task. Stop it before starting another one.");
  }

  if (directCareerCommand(cleanGoal)) {
    cancelled = false;
    approvedConsequentialLabel = "";
    resumeInputContext = null;
    careerProfileSetup = null;
    careerWorkflowResume = null;
    const result = await handleCareerCommand(cleanGoal) as DirectCareerResult;
    const state = browser.embeddedBrowserState();
    active = {
      id: randomUUID(), goal: cleanGoal, status: "running", steps: [], summary: String(result.summary || "Career Mode action completed"),
      url: state.url || "", title: state.title || "Orbit Career Mode", planner: "native",
    };
    return applyCareerResult(result, cleanGoal, listener);
  }

  const geminiReady = geminiStatus().available;
  const deterministic = Boolean(initialGoalUrl(cleanGoal) || deterministicNativeIntent(cleanGoal));
  const local = deterministic ? null : await ollamaStatus();
  if (!deterministic && !geminiReady && !local?.available) throw new Error("Connect Gemini or start the local qwen3:4b model before starting a browser task that requires AI reasoning");
  cancelled = false;
  approvedConsequentialLabel = "";
  resumeInputContext = null;
  careerProfileSetup = null;
  careerWorkflowResume = null;
  lastPageFingerprint = "";
  stagnantPageRounds = 0;
  loopRecoveryAttempts = 0;
  await browser.showEmbeddedBrowser();
  active = {
    id: randomUUID(), goal: cleanGoal, status: "running", steps: [], summary: deterministic ? "Using Orbit Browser's native controls" : "Opening Orbit Browser",
    url: await browser.currentUrl(), title: await browser.pageTitle(), planner: deterministic ? "native" : geminiReady ? "gemini" : local?.available ? "ollama" : undefined,
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
  if (!pending) throw new Error("Orbit needs you to take over for this step");

  if (active.pendingKind === "input") {
    active.summary = pending.reason || "Orbit needs your answer or manual takeover for this step. Approval alone cannot supply the missing information.";
    emit(listener, "status", active.summary);
    return active;
  }

  if (pending.type === "click") {
    const label = String(pending.label || "").trim();
    if (!label) throw new Error("Orbit cannot safely resume a confirmed click without an exact visible control label");
    await withTimeout(browser.clickByLabel(label), ACTION_TIMEOUT_MS, "The confirmed browser action took too long");
    active.steps.push({ at: new Date().toISOString(), action: pending, outcome: "Exact pending action confirmed by user and completed" });
    active.pendingAction = undefined;
    active.pendingKind = undefined;
    cancelled = false;
    emit(listener, "step", `Confirmed exact action completed · Step ${active.steps.length} verified`);
    if (careerWorkflowResume?.mode === "approval") {
      careerWorkflowResume = null;
      active.status = "completed";
      active.summary = `Approved and completed only “${label}”. Orbit stopped after the exact final Career action.`;
      emit(listener, "status", active.summary);
      return active;
    }
    active.status = "running";
    active.summary = "Confirmed exact action. Continuing the Orbit Browser workflow";
    const taskId = active.id;
    void run(taskId, listener);
    return active;
  }

  if (pending.type === "ask_user") {
    const label = String(pending.label || "").trim();
    if (!label || !riskyLabels.test(label)) {
      active.summary = pending.reason || "Orbit needs your answer or manual takeover for this step; a generic approval cannot safely supply that information.";
      emit(listener, "status", active.summary);
      return active;
    }
    approvedConsequentialLabel = label.toLowerCase();
    active.steps.push({ at: new Date().toISOString(), action: pending, outcome: `User approved only the exact next consequential control “${label}”` });
    active.pendingAction = undefined;
    active.pendingKind = undefined;
    active.status = "running";
    active.summary = `Approved only “${label}”. Orbit will re-check the page before executing it.`;
    cancelled = false;
    const taskId = active.id;
    emit(listener, "step", `One-action approval recorded · Step ${active.steps.length} verified`);
    void run(taskId, listener);
    return active;
  }

  throw new Error("Orbit needs you to take over for this step");
}

export async function submitBrowserTaskInput(answer: string, listener: (event: BrowserTaskEvent) => void) {
  if (!active) throw new Error("No browser task is waiting for input");
  if (active.status !== "waiting_for_confirmation" || active.pendingKind !== "input") return active;
  const pending = active.pendingAction;
  if (!pending) throw new Error("Orbit no longer has a pending browser question to answer");
  const cleanAnswer = String(answer || "").trim().slice(0, 1_000);
  if (!cleanAnswer) {
    active.summary = "Orbit is still waiting for your answer. Nothing was changed.";
    emit(listener, "status", active.summary);
    return active;
  }

  if (careerProfileSetup) {
    const currentField = careerProfileSetup.currentField;
    const result = await saveCareerProfileSetupAnswer(currentField, cleanAnswer);
    if (!result.saved) {
      active.summary = result.summary;
      emit(listener, "status", active.summary);
      return active;
    }

    active.steps.push({
      at: new Date().toISOString(),
      action: pending,
      outcome: `Saved reusable Career profile field(s): ${(result.savedFields || [currentField]).join(", ")}. Sensitive legal, compensation, demographic, visa, and authentication answers were not promoted into the profile.`,
    });

    if (result.missing.length) {
      const nextField = result.missing[0];
      careerProfileSetup.currentField = nextField;
      active.pendingKind = "input";
      active.pendingAction = {
        type: "ask_user",
        label: `Career profile: ${careerProfileSetupFieldLabel(nextField)}`,
        reason: result.summary,
      };
      active.summary = result.summary;
      emit(listener, "step", `Career profile updated · ${result.missing.length} reusable field(s) remaining`);
      emit(listener, "status", active.summary);
      return active;
    }

    const originalGoal = careerProfileSetup.originalGoal;
    careerProfileSetup = null;
    active.pendingAction = undefined;
    active.pendingKind = undefined;
    active.status = "running";
    active.summary = "Career profile setup complete. Resuming the Career task you originally requested.";
    emit(listener, "step", "Career profile setup complete · resuming original Career task");

    const resumed = await handleCareerCommand(originalGoal) as DirectCareerResult;
    resumed.summary = `Career profile setup complete. ${String(resumed.summary || "The original Career task is complete.")}`;
    return applyCareerResult(resumed, originalGoal, listener);
  }

  if (careerWorkflowResume?.mode === "input") {
    const workflow = careerWorkflowResume;
    const fieldLabel = workflow.fieldLabel || String(pending.label || "").trim();
    const page = await browser.actionSnapshot();
    const control = page.controls.find(item => item.label.trim().toLowerCase() === fieldLabel.toLowerCase())
      || page.controls.find(item => item.label.toLowerCase().includes(fieldLabel.toLowerCase()));
    try {
      if (control && ["select", "combobox"].includes(control.kind.toLowerCase())) await browser.selectByLabel(control.label, cleanAnswer);
      else await browser.fillByLabel(control?.label || fieldLabel, cleanAnswer);
    } catch (error) {
      active.summary = `Orbit could not safely apply that answer to “${fieldLabel}”. ${error instanceof Error ? error.message : String(error)}`;
      emit(listener, "status", active.summary);
      return active;
    }
    active.steps.push({ at: new Date().toISOString(), action: pending, outcome: `User supplied an explicit task-scoped answer for “${fieldLabel}”; Orbit applied only that value and did not save it to the Career profile.` });
    active.pendingAction = undefined;
    active.pendingKind = undefined;
    const originalGoal = workflow.originalGoal;
    careerWorkflowResume = null;
    const resumed = await handleCareerCommand(originalGoal) as DirectCareerResult;
    return applyCareerResult(resumed, originalGoal, listener);
  }

  const question = String(pending.label || pending.reason || active.summary || "the pending browser question").trim().slice(0, 300);
  const manualOnly = manualOnlyInput.test(`${question} ${pending.reason || ""}`);
  if (manualOnly) {
    active.summary = `For “${question}”, enter the secret or verification information manually in the website. Orbit will not capture or type it. When the page is ready, say “continue”.`;
    emit(listener, "status", active.summary);
    return active;
  }

  resumeInputContext = { question, answer: cleanAnswer };
  active.steps.push({ at: new Date().toISOString(), action: pending, outcome: `User supplied an explicit task-scoped answer for “${question}”; the value is not stored in Orbit profile or memory.` });
  active.pendingAction = undefined;
  active.pendingKind = undefined;
  active.status = "running";
  active.summary = `Got it. Re-checking the current page and applying that answer only to “${question}” if the field still matches.`;
  cancelled = false;
  const taskId = active.id;
  emit(listener, "step", `Task-scoped input received · Step ${active.steps.length} verified`);
  void run(taskId, listener);
  return active;
}

export async function continueBrowserTask(listener: (event: BrowserTaskEvent) => void) {
  if (!active) throw new Error("There is no browser task to continue");
  if (active.status === "waiting_for_confirmation") {
    const pending = active.pendingAction;
    const question = String(pending?.label || pending?.reason || active.summary || "");
    if (careerProfileSetup) {
      active.summary = `Orbit is still setting up your reusable Career profile. ${careerProfileSetupQuestion(careerProfileSetup.currentField)}`;
      emit(listener, "status", active.summary);
      return active;
    }
    if (careerWorkflowResume?.mode === "manual" && active.pendingKind === "input") {
      const workflow = careerWorkflowResume;
      active.steps.push({ at: new Date().toISOString(), action: pending || { type: "wait", reason: "Manual Career takeover" }, outcome: "User completed the manual Career application checkpoint directly on the site; Orbit did not capture the secret, code, or CAPTCHA response." });
      active.pendingAction = undefined;
      active.pendingKind = undefined;
      resumeInputContext = null;
      careerWorkflowResume = null;
      active.status = "running";
      active.summary = "Manual Career checkpoint acknowledged. Re-inspecting the same application workflow.";
      emit(listener, "step", `Manual Career checkpoint complete · Step ${active.steps.length} verified`);
      const resumed = await handleCareerCommand(workflow.originalGoal) as DirectCareerResult;
      return applyCareerResult(resumed, workflow.originalGoal, listener);
    }
    if (active.pendingKind === "input" && manualOnlyInput.test(`${question} ${pending?.reason || ""}`)) {
      active.steps.push({ at: new Date().toISOString(), action: pending || { type: "wait", reason: "Manual browser takeover" }, outcome: "User completed the manual-only browser step; Orbit did not capture the secret, code, identifier, or CAPTCHA response." });
      active.pendingAction = undefined;
      active.pendingKind = undefined;
      resumeInputContext = null;
      active.status = "running";
      active.summary = "Manual step acknowledged. Re-inspecting the current page before continuing.";
    } else {
      active.summary = active.pendingKind === "approval"
        ? "Orbit is waiting for approval of the exact consequential action. Use APPROVE NEXT or stop the task."
        : "Orbit is still waiting for your answer to the pending question.";
      emit(listener, "status", active.summary);
      return active;
    }
  } else if (active.status === "paused") {
    active.status = "running";
    active.summary = "Continuing from the last verified Orbit Browser checkpoint and re-inspecting the current page.";
  } else if (active.status !== "running") {
    return active;
  }

  cancelled = false;
  lastPageFingerprint = "";
  stagnantPageRounds = 0;
  loopRecoveryAttempts = 0;
  await browser.showEmbeddedBrowser();
  const taskId = active.id;
  emit(listener, "status", active.summary);
  void run(taskId, listener);
  return active;
}

export function cancelBrowserTask() {
  cancelled = true;
  approvedConsequentialLabel = "";
  resumeInputContext = null;
  careerProfileSetup = null;
  careerWorkflowResume = null;
  if (active && !["completed", "failed", "cancelled"].includes(active.status)) {
    active.status = "cancelled";
    active.summary = "Browser task stopped";
    active.pendingAction = undefined;
    active.pendingKind = undefined;
  }
  browser.hideEmbeddedBrowser();
  return active;
}

export function browserTaskStatus() { return active; }

function registerPhaseThreeBrowserIpc() {
  ipcMain.removeHandler("orbit:browser:task:input");
  ipcMain.removeHandler("orbit:browser:task:continue");
  ipcMain.handle("orbit:browser:task:input", (event, answer: string) => submitBrowserTaskInput(String(answer || ""), payload => event.sender.send("orbit:browser:task:event", payload)));
  ipcMain.handle("orbit:browser:task:continue", event => continueBrowserTask(payload => event.sender.send("orbit:browser:task:event", payload)));
}

registerPhaseThreeBrowserIpc();