import type { CommandPlan, ConversationTurn } from "../shared/contracts.js";

const MODEL = "gpt-5.6-terra";
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["system", "recent", "knowledge", "git", "cleanup", "audit", "launch", "answer", "clarify"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    explanation: { type: "string", maxLength: 180 },
    reply: { type: "string", maxLength: 900 },
    query: { type: "string", maxLength: 300 },
    application: { type: "string", maxLength: 120 },
    requiresConfirmation: { type: "boolean" },
  },
  required: ["intent", "confidence", "explanation", "reply", "query", "application", "requiresConfirmation"],
} as const;

export async function planWithOpenAI(args: {
  apiKey: string;
  command: string;
  history: ConversationTurn[];
  installedApplications: string[];
  fetcher?: typeof fetch;
}): Promise<CommandPlan> {
  const fetcher = args.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const applications = args.installedApplications.slice(0, 120).join(", ");
  const instructions = `You are Orbit, a concise voice-first desktop assistant. Be warm, direct, and conversational.\n
Choose exactly one intent. Use answer for general knowledge or conversation. Use clarify when a request is ambiguous, unsupported, dangerous, or needs missing information. Desktop intents are system, recent, knowledge, git, cleanup, audit, and launch.\n
Never claim an action already happened. Never invent files, system readings, or applications. Launch only an application from this exact installed list: ${applications || "none detected"}. Cleanup is a preview only and always requires confirmation. Do not request or reveal secrets. Keep reply suitable for speech and under four sentences.`;
  const input = [
    ...args.history.slice(-10).map(turn => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: args.command.slice(0, 1000) },
  ];
  try {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        reasoning: { effort: "low" },
        instructions,
        input,
        max_output_tokens: 1200,
        text: { format: { type: "json_schema", name: "orbit_plan", strict: true, schema: PLAN_SCHEMA } },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 401) throw new Error("The OpenAI API key was rejected. Update it in Settings.");
      if (response.status === 429) throw new Error("OpenAI usage or rate limit reached. Check API billing and limits.");
      throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 160)}`);
    }
    const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    const outputText = payload.output_text ?? payload.output?.flatMap(item => item.content ?? []).find(item => item.type === "output_text")?.text;
    if (!outputText) throw new Error("OpenAI returned no usable response.");
    const plan = JSON.parse(outputText) as CommandPlan;
    return { ...plan, source: "openai", model: MODEL };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("OpenAI took too long to respond. Orbit stayed in local mode.");
    throw error;
  } finally { clearTimeout(timeout); }
}
