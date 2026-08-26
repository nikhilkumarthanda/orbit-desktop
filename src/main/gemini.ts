import { spawnSync } from "node:child_process";
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConversationTurn, ResearchSource } from "../shared/contracts.js";
import { finalAnswerOnly } from "./ollama.js";

const KEYCHAIN_SERVICE = "com.orbit.desktop.gemini";
// Prefer a current stable multimodal model, but keep an alias and stable fallbacks.
// Google can restrict retired models for new API projects before older projects, so
// screen understanding must not depend on a single hard-coded model identifier.
export const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"] as const;
export const GEMINI_MODEL = GEMINI_MODELS[0];
const DEFAULT_MONTHLY_BUDGET_USD = 5;
// Conservative paid-equivalent estimator for the primary Flash model. Free-tier accounts are billed $0.
const INPUT_USD_PER_MILLION = 1.50;
const OUTPUT_USD_PER_MILLION = 7.50;

type UsageFile = { month: string; requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number; monthlyBudgetUsd: number };
type GeminiResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }; error?: { message?: string } };

function monthKey() { return new Date().toISOString().slice(0, 7); }
function usagePath() { return path.join(app.getPath("userData"), "gemini-usage.json"); }
function freshUsage(): UsageFile { return { month: monthKey(), requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, monthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD }; }
function readUsage(): UsageFile {
  try {
    const stored = JSON.parse(readFileSync(usagePath(), "utf8")) as Partial<UsageFile>;
    if (stored.month !== monthKey()) return { ...freshUsage(), monthlyBudgetUsd: Number(stored.monthlyBudgetUsd) || DEFAULT_MONTHLY_BUDGET_USD };
    return { ...freshUsage(), ...stored, monthlyBudgetUsd: Number(stored.monthlyBudgetUsd) || DEFAULT_MONTHLY_BUDGET_USD };
  } catch { return freshUsage(); }
}
function writeUsage(usage: UsageFile) { writeFileSync(usagePath(), JSON.stringify(usage, null, 2), { mode: 0o600 }); }
function usageStatus() {
  const usage = readUsage();
  const cost = Number(usage.estimatedCostUsd.toFixed(4));
  return { ...usage, estimatedCostUsd: cost, remainingUsd: Number(Math.max(0, usage.monthlyBudgetUsd - cost).toFixed(4)), blocked: cost >= usage.monthlyBudgetUsd };
}

function recordUsage(data: GeminiResponse) {
  const usage = readUsage();
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
  usage.requests += 1;
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.estimatedCostUsd += (inputTokens * INPUT_USD_PER_MILLION + outputTokens * OUTPUT_USD_PER_MILLION) / 1_000_000;
  writeUsage(usage);
}

export function setGeminiBudget(value: number) {
  if (!Number.isFinite(value) || value < 0.5 || value > 100) throw new Error("Choose a monthly Gemini limit between $0.50 and $100");
  const usage = readUsage(); usage.monthlyBudgetUsd = Number(value.toFixed(2)); writeUsage(usage);
}

export function geminiKey(): string {
  if (process.platform !== "darwin") return process.env.GEMINI_API_KEY || "";
  return spawnSync("/usr/bin/security", ["find-generic-password", "-a", "Orbit", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" }).stdout.trim();
}

export async function saveGeminiKey(value: string) {
  const key = value.trim();
  if (key.length < 20 || /\s/.test(key)) throw new Error("That does not look like a complete Gemini API key");
  if (process.platform !== "darwin") throw new Error("Secure Gemini setup is currently available on macOS only");
  const check = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
  if (!check.ok) {
    const data = await check.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(data.error?.message || "Google did not accept this Gemini API key");
  }
  const result = spawnSync("/usr/bin/security", ["add-generic-password", "-a", "Orbit", "-s", KEYCHAIN_SERVICE, "-w", key, "-U"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Orbit could not save the API key in macOS Keychain");
}

export function geminiStatus() {
  const usage = usageStatus();
  return { provider: "gemini" as const, configured: Boolean(geminiKey()), available: Boolean(geminiKey()) && !usage.blocked, model: GEMINI_MODEL, cost: "$0 on Google free tier" as const, usage };
}

function modelUnavailable(status: number, message: string) {
  return status === 404 || /model.*(?:not found|not supported|no longer available|unavailable|deprecated)|not found.*model/i.test(message);
}

async function runGemini(parts: Array<Record<string, unknown>>, generationConfig: Record<string, unknown>, timeoutMs = 30_000) {
  const key = geminiKey();
  if (!key) throw new Error("Add your free Gemini API key in Orbit Settings first");
  const before = usageStatus();
  if (before.blocked) throw new Error(`Gemini's $${before.monthlyBudgetUsd.toFixed(2)} monthly safety limit has been reached. Orbit will use its local fallback.`);

  const body = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig });
  let data: GeminiResponse | undefined;
  let lastModelError = "No supported Gemini Flash model was available";
  for (const model of GEMINI_MODELS) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(timeoutMs), body,
    });
    data = await response.json() as GeminiResponse;
    if (response.ok) break;
    const message = data.error?.message || `Gemini returned status ${response.status}`;
    if (!modelUnavailable(response.status, message)) throw new Error(message);
    lastModelError = message;
    data = undefined;
  }
  if (!data) throw new Error(`Screen understanding is temporarily unavailable because Google retired or restricted Orbit's Gemini models. ${lastModelError}`);
  recordUsage(data);
  return data;
}

export async function answerWithGemini(input: { query: string; history: ConversationTurn[]; sources?: ResearchSource[]; imageBase64?: string }) {
  const evidence = input.sources?.length ? `\nPublic web evidence:\n${input.sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.excerpt}\n${source.url}`).join("\n")}` : "";
  const context = input.history.slice(-8).map(turn => `${turn.role}: ${turn.content}`).join("\n");
  const parts: Array<Record<string, unknown>> = [{ text: `You are Orbit, a composed, capable, voice-first Mac companion—not a chatbot. Speak with the calm precision of a modern cinematic assistant. Address the user as Boss naturally at important acknowledgements, confirmations, or transitions, but never mechanically in every sentence. Vary short acknowledgements such as “Certainly, Boss,” “Right away,” and “On it.” Never imitate or claim to be a copyrighted character. Handle casual conversation and long dictated requests conversationally. Lead with a short answer suitable for speech; add detail only when the request needs it. Avoid headings, markdown, citations read aloud, and repetitive offers to help in spoken answers. Answer only the user-facing final answer; never reveal analysis or <think> text. Use supplied evidence for current facts and cite it with [number]. If no evidence is supplied, answer from your knowledge and admit uncertainty when needed.\nConversation:\n${context}\nUser: ${input.query}${evidence}` }];
  if (input.imageBase64) parts.push({ inline_data: { mime_type: "image/png", data: input.imageBase64 } });
  const data = await runGemini(parts, { temperature: 0.35, maxOutputTokens: 900 });
  const answer = finalAnswerOnly(data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n") || "");
  if (!answer) throw new Error("Gemini returned an empty answer");
  return answer;
}

export type VisualBrowserTarget = {
  x: number;
  y: number;
  confidence: number;
  description: string;
  reason: string;
};

export async function planVisualBrowserTarget(input: {
  goal: string;
  requestedLabel: string;
  imageBase64: string;
  page: {
    title: string;
    url: string;
    text: string;
    controls: Array<{ kind: string; label: string; x?: number; y?: number; width?: number; height?: number }>;
    viewport: { width: number; height: number; scrollX: number; scrollY: number };
  };
}): Promise<VisualBrowserTarget> {
  const { viewport } = input.page;
  if (!input.imageBase64 || viewport.width < 1 || viewport.height < 1) throw new Error("Orbit does not have a usable browser screenshot for visual targeting");

  const controlSummary = input.page.controls.slice(0, 60).map((control, index) => {
    const rect = Number.isFinite(control.x) && Number.isFinite(control.y)
      ? ` @(${Math.round(control.x || 0)},${Math.round(control.y || 0)},${Math.round(control.width || 0)}x${Math.round(control.height || 0)})`
      : "";
    return `${index + 1}. ${control.kind}: ${control.label}${rect}`;
  }).join("\n");

  const prompt = `You are Orbit's visual browser targeter. Return JSON only.\n\nGoal: ${input.goal}\nRequested control: ${input.requestedLabel}\nPage title: ${input.page.title}\nURL: ${input.page.url}\nViewport: ${viewport.width}x${viewport.height} CSS pixels; screenshot coordinates use the same viewport coordinate system.\nScroll: ${viewport.scrollX}, ${viewport.scrollY}\n\nVisible DOM controls (may be incomplete):\n${controlSummary || "No reliable DOM controls were found."}\n\nVisible page text excerpt:\n${input.page.text.slice(0, 3500)}\n\nLook at the screenshot and identify exactly one currently visible clickable target that best matches the requested control. Do not guess hidden or off-screen controls. Do not choose Submit, Send, Post, Publish, Purchase, Pay, Delete, Remove, Connect, Accept, Agree, or any other consequential action unless the requested control explicitly names that same action. If the requested target is ambiguous or not visibly identifiable, return confidence below 0.65. Coordinates must be the center of the target in CSS viewport pixels.\n\nReturn exactly: {"x":number,"y":number,"confidence":number,"description":"short visible target description","reason":"short reason"}`;

  const data = await runGemini([
    { text: prompt },
    { inline_data: { mime_type: "image/png", data: input.imageBase64 } },
  ], { temperature: 0.05, maxOutputTokens: 220, responseMimeType: "application/json" }, 35_000);

  const raw = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim() || "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: Partial<VisualBrowserTarget> = {};
  try { parsed = JSON.parse(cleaned) as Partial<VisualBrowserTarget>; }
  catch { throw new Error("Visual targeting returned an invalid response"); }

  const x = Number(parsed.x);
  const y = Number(parsed.y);
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const description = String(parsed.description || "").trim().slice(0, 180);
  const reason = String(parsed.reason || "").trim().slice(0, 240);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    throw new Error("Visual targeting returned coordinates outside the active browser viewport");
  }
  const consequential = /\b(?:submit|send|post|publish|purchase|buy|pay|delete|remove|connect|accept|agree|confirm order|place order)\b/i;
  if (consequential.test(description) && !consequential.test(input.requestedLabel)) {
    throw new Error("Visual targeting resolved to a consequential action that was not requested");
  }
  return { x: Math.round(x), y: Math.round(y), confidence, description, reason };
}
