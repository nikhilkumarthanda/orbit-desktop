import { answerWithGemini, geminiStatus } from "./gemini.js";
import { answerWithOllama, ollamaStatus } from "./ollama.js";
import type { ResearchSource } from "../shared/contracts.js";

// The one place that turns (instruction, evidence) into natural spoken text
// via whichever AI backend is configured, falling back to a plain-text
// concatenation if neither is available. Every live-information service and
// the page-intelligence summarizer route through this instead of each
// re-implementing the same Gemini-then-Ollama-then-fallback branching.
export async function summarizeWithAI(instruction: string, sources: ResearchSource[], fallback: () => string): Promise<string> {
  let answer: string;
  if (geminiStatus().available) answer = await answerWithGemini({ query: instruction, sources, history: [] });
  else {
    const status = await ollamaStatus();
    if (status.available) answer = await answerWithOllama({ query: instruction, sources, history: [] });
    else answer = fallback();
  }
  return answer.replace(/\s*\[\d+\]/g, "").trim();
}
