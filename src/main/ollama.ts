import type { AIStatus, CommandPlan, ConversationTurn } from "../shared/contracts.js";

export const OLLAMA_MODEL = "qwen3:4b";
const OLLAMA_URL = "http://127.0.0.1:11434";
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["system", "recent", "knowledge", "git", "github", "cleanup", "audit", "launch", "answer", "clarify"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string", maxLength: 100 }, reply: { type: "string", maxLength: 500 },
    query: { type: "string", maxLength: 200 }, application: { type: "string", maxLength: 100 }, repository: { type: "string", maxLength: 120 }, url: { type: "string", maxLength: 300 }, requiresConfirmation: { type: "boolean" },
  },
  required: ["intent", "confidence", "explanation", "reply", "query", "application", "repository", "url", "requiresConfirmation"],
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
  const system = `You are Orbit, a concise, confident, voice-first local Mac assistant with a composed cinematic presence. Address the user as Boss naturally. Choose exactly one intent. Greetings and conversation ALWAYS use answer, never git. Use github when asked to open GitHub, inspect Actions, workflows, deployment, CI, or build status; default repository to nikhilkumarthanda/orbit-desktop when Orbit is implied. Use launch only for installed desktop apps. Return every required JSON field. Keep explanation under 12 words and spoken reply under 2 short sentences. Use empty strings for unused query, application, repository, and url. Never read raw technical errors aloud. Never claim an action happened. Never invent local data. Launch only from: ${apps || "none"}. Cleanup is preview-only and requires confirmation.`;
  const response = await fetcher(`${OLLAMA_URL}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, think: false, keep_alive: "10m", format: PLAN_SCHEMA, options: { temperature: 0, num_predict: 1000 }, messages: [
      { role: "system", content: system }, ...args.history.slice(-10), { role: "user", content: args.command.slice(0, 1000) },
    ] }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${detail.slice(0, 180)}`);
  }
  const data = await response.json() as { message?: { content?: string } };
  if (!data.message?.content) throw new Error("Local AI returned no response");
  const content = data.message.content.trim();
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error(`Ollama returned invalid structured output: ${content.slice(0, 120)}`);
  try { return { ...(JSON.parse(content.slice(first, last + 1)) as CommandPlan), source: "ollama", model: OLLAMA_MODEL }; }
  catch { throw new Error(`Ollama returned invalid JSON: ${content.slice(0, 120)}`); }
}
