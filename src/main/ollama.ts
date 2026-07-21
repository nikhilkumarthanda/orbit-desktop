import type { AIStatus, CommandPlan, ConversationTurn } from "../shared/contracts.js";

export const OLLAMA_MODEL = "qwen3:4b";
const OLLAMA_URL = "http://127.0.0.1:11434";
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["system", "recent", "knowledge", "git", "cleanup", "audit", "launch", "answer", "clarify"] },
    confidence: { type: "number" }, explanation: { type: "string" }, reply: { type: "string" },
    query: { type: "string" }, application: { type: "string" }, requiresConfirmation: { type: "boolean" },
  },
  required: ["intent", "confidence", "explanation", "reply", "query", "application", "requiresConfirmation"],
} as const;

export async function ollamaStatus(fetcher: typeof fetch = fetch): Promise<AIStatus> {
  try {
    const response = await fetcher(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error("Ollama unavailable");
    const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const models = (data.models ?? []).map(item => item.name ?? item.model ?? "");
    const installed = models.some(name => name === OLLAMA_MODEL || name.startsWith(`${OLLAMA_MODEL}:`));
    return { provider: "ollama", configured: installed, available: installed, running: true, model: OLLAMA_MODEL, cost: "$0", installCommand: `ollama pull ${OLLAMA_MODEL}` };
  } catch {
    return { provider: "ollama", configured: false, available: false, running: false, model: OLLAMA_MODEL, cost: "$0", installCommand: `ollama pull ${OLLAMA_MODEL}` };
  }
}

export async function planWithOllama(args: { command: string; history: ConversationTurn[]; installedApplications: string[]; fetcher?: typeof fetch }): Promise<CommandPlan> {
  const fetcher = args.fetcher ?? fetch;
  const apps = args.installedApplications.slice(0, 120).join(", ");
  const system = `You are Orbit, a concise, confident, voice-first local Mac assistant with a composed cinematic presence. Address the user as Boss naturally, especially in acknowledgements such as "Yes, boss" and "Okay, boss," but do not overuse it. Choose exactly one intent. Use answer for conversation, clarify for ambiguous or unsafe requests, and a desktop intent only when it matches. Never claim an action happened. Never invent local data. Launch only from: ${apps || "none"}. Cleanup is preview-only and requires confirmation. Keep reply under four sentences.`;
  const response = await fetcher(`${OLLAMA_URL}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, format: PLAN_SCHEMA, options: { temperature: 0 }, messages: [
      { role: "system", content: system }, ...args.history.slice(-10), { role: "user", content: args.command.slice(0, 1000) },
    ] }),
  });
  if (!response.ok) throw new Error(`Local AI returned ${response.status}`);
  const data = await response.json() as { message?: { content?: string } };
  if (!data.message?.content) throw new Error("Local AI returned no response");
  return { ...(JSON.parse(data.message.content) as CommandPlan), source: "ollama", model: OLLAMA_MODEL };
}
