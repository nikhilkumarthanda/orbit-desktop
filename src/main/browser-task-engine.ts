import { randomUUID } from "node:crypto";
import * as browser from "./browser-agent.js";
import { answerWithGemini, geminiStatus } from "./gemini.js";
import type { BrowserTask, BrowserTaskAction, BrowserTaskEvent } from "../shared/contracts.js";

const riskyLabels = /\b(?:send|submit|apply|purchase|buy|pay|book|publish|post|delete|remove|confirm order|place order|accept|agree)\b/i;
let active: BrowserTask | null = null;
let cancelled = false;
const cleanJson = (value: string) => value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

async function nextAction(goal: string, steps: BrowserTask["steps"]): Promise<BrowserTaskAction> {
  const page = await browser.actionSnapshot();
  const history = steps.slice(-6).map(step => `${step.action.type}: ${step.action.label || step.action.url || ""} -> ${step.outcome}`).join("\n");
  const prompt = `You are Orbit's browser controller. Choose exactly one safe next browser action to advance the user's goal.\nGoal: ${goal}\nCurrent page: ${page.title} (${page.url})\nRecent steps:\n${history || "none"}\nVisible controls: ${JSON.stringify(page.controls.slice(0, 60))}\nVisible text: ${page.text.slice(0, 7000)}\nReturn JSON only: {"type":"navigate|click|fill|select|scroll|wait|complete|ask_user","url":"","label":"","value":"","direction":"down|up","reason":"short explanation"}. Use labels exactly as shown. Never choose send, submit, apply, purchase, pay, book, publish, post, delete, accept, or agree; use ask_user immediately before such an action. Use complete only when the goal is visibly satisfied. Never enter passwords, payment data, government IDs, or authentication codes.`;
  const parsed = JSON.parse(cleanJson(await answerWithGemini({ query: prompt, history: [] }))) as BrowserTaskAction;
  if (!["navigate","click","fill","select","scroll","wait","complete","ask_user"].includes(parsed.type)) throw new Error("Orbit's browser planner returned an unsupported action");
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

async function run(listener: (event: BrowserTaskEvent) => void) {
  if (!active) throw new Error("No browser task is active");
  active.status = "running"; listener({ type: "status", task: active });
  for (let round = active.steps.length; round < 20 && !cancelled; round++) {
    const action = await nextAction(active.goal, active.steps);
    if (action.type === "complete") { active.status = "completed"; active.summary = action.reason || "Browser task completed"; listener({ type: "status", task: active }); return active; }
    const result = await act(action);
    active.steps.push({ at: new Date().toISOString(), action, outcome: result.outcome });
    active.url = await browser.currentUrl(); active.title = await browser.pageTitle();
    if (result.pause) { active.status = "waiting_for_confirmation"; active.pendingAction = action; active.summary = result.outcome; listener({ type: "status", task: active }); return active; }
    listener({ type: "step", task: active, message: result.outcome });
  }
  active.status = cancelled ? "cancelled" : "paused";
  active.summary = cancelled ? "Browser task stopped" : "Orbit reached the 20-step safety limit. Review the page before continuing.";
  listener({ type: "status", task: active }); return active;
}

export async function startBrowserTask(goal: string, listener: (event: BrowserTaskEvent) => void) {
  if (!goal.trim()) throw new Error("Tell Orbit what you want the browser to accomplish");
  if (!geminiStatus().available) throw new Error("Connect Gemini in Settings before starting an autonomous browser task");
  cancelled = false; active = { id: randomUUID(), goal: goal.trim(), status: "running", steps: [], summary: "Starting a private Orbit browser", url: "", title: "" };
  return run(listener);
}

export async function resumeBrowserTask(confirmed: boolean, listener: (event: BrowserTaskEvent) => void) {
  if (!active) throw new Error("No browser task is waiting");
  if (active.status === "waiting_for_confirmation" && confirmed) {
    const pending = active.pendingAction;
    if (!pending || !pending.label || !["click", "ask_user"].includes(pending.type)) throw new Error("Orbit needs you to take over for this step");
    await browser.clickByLabel(pending.label || "");
    active.steps.push({ at: new Date().toISOString(), action: pending, outcome: "Confirmed by user and completed" }); active.pendingAction = undefined;
  }
  cancelled = false; return run(listener);
}

export function cancelBrowserTask() { cancelled = true; if (active) { active.status = "cancelled"; active.summary = "Browser task stopped"; } return active; }
export function browserTaskStatus() { return active; }
