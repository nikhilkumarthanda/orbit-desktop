import { spawnSync } from "node:child_process";
import type { ConversationTurn, ResearchSource } from "../shared/contracts.js";
import { finalAnswerOnly } from "./ollama.js";

const KEYCHAIN_SERVICE = "com.orbit.desktop.gemini";
export const GEMINI_MODEL = "gemini-2.5-flash";

export function geminiKey(): string {
  if (process.platform !== "darwin") return process.env.GEMINI_API_KEY || "";
  return spawnSync("/usr/bin/security", ["find-generic-password", "-a", "Orbit", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" }).stdout.trim();
}

export function saveGeminiKey(value: string) {
  const key = value.trim();
  if (!/^AIza[\w-]{20,}$/.test(key)) throw new Error("That does not look like a valid Gemini API key");
  if (process.platform !== "darwin") throw new Error("Secure Gemini setup is currently available on macOS only");
  const result = spawnSync("/usr/bin/security", ["add-generic-password", "-a", "Orbit", "-s", KEYCHAIN_SERVICE, "-w", key, "-U"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Orbit could not save the API key in macOS Keychain");
}

export function geminiStatus() {
  return { provider: "gemini" as const, configured: Boolean(geminiKey()), available: Boolean(geminiKey()), model: GEMINI_MODEL, cost: "$0 free tier" as const };
}

export async function answerWithGemini(input: { query: string; history: ConversationTurn[]; sources?: ResearchSource[]; imageBase64?: string }) {
  const key = geminiKey();
  if (!key) throw new Error("Add your free Gemini API key in Orbit Settings first");
  const evidence = input.sources?.length ? `\nPublic web evidence:\n${input.sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.excerpt}\n${source.url}`).join("\n")}` : "";
  const context = input.history.slice(-8).map(turn => `${turn.role}: ${turn.content}`).join("\n");
  const parts: Array<Record<string, unknown>> = [{ text: `You are Orbit, a concise Mac assistant. Address the user as Boss naturally. Answer only the user-facing final answer; never reveal analysis or <think> text. Use supplied evidence for current facts and cite it with [number]. If no evidence is supplied, answer from your knowledge and admit uncertainty when needed.\nConversation:\n${context}\nUser: ${input.query}${evidence}` }];
  if (input.imageBase64) parts.push({ inline_data: { mime_type: "image/png", data: input.imageBase64 } });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.35, maxOutputTokens: 900 } }),
  });
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `Gemini returned status ${response.status}`);
  const answer = finalAnswerOnly(data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n") || "");
  if (!answer) throw new Error("Gemini returned an empty answer");
  return answer;
}
