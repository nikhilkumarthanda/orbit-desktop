import type { ResearchSource } from "../../shared/contracts.js";

// Every service normalizes into the same shape: a set of ResearchSource
// evidence entries, which is exactly what Orbit's existing AI summarizer
// (ai-summarize.ts) already consumes - so the engine never needs bespoke
// per-domain summarization logic, only per-domain data retrieval.
export type ServiceOutcome =
  | { ok: true; sources: ResearchSource[]; source: string; updatedAt: string }
  | { ok: false; error: string };

export interface LiveInfoService {
  name: string;
  // Does this service apply to a free-form query? Used when the caller
  // doesn't already know which services are needed (e.g. a query that didn't
  // match a specific local intent).
  appliesTo(query: string): boolean;
  fetch(query: string): Promise<ServiceOutcome>;
}
