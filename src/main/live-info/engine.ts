import { summarizeWithAI } from "../ai-summarize.js";
import type { LiveInfoService } from "./types.js";
import type { LiveBrief, ResearchSource } from "../../shared/contracts.js";

// Per-service phrasing so a single-topic request still gets a tailored
// instruction (e.g. news wants "pick the 3 most important, distinct
// headlines"), while a multi-service request gets one combined instruction
// covering everything that succeeded.
const SERVICE_INSTRUCTIONS: Record<string, string> = {
  weather: "Turn the weather evidence below into one natural, conversational spoken answer.",
  news: "From the evidence below, pick the 3 most important, distinct headlines (skip near-duplicates and minor stories) and summarize each in one short, natural spoken sentence.",
  sports: "Turn the sports result evidence below into one natural spoken sentence stating the result.",
  finance: "Turn the stock quote evidence below into one natural spoken sentence.",
  calendar: "Turn the calendar evidence below into one natural spoken summary of the day's schedule.",
  email: "Turn the email evidence below into one natural spoken summary of what needs attention.",
};

export function createLiveInformationEngine(services: LiveInfoService[]) {
  function resolveServices(query: string, hint?: string[]): LiveInfoService[] {
    if (hint?.length) {
      const byName = new Map(services.map(service => [service.name, service]));
      const resolved = hint.map(name => byName.get(name)).filter((service): service is LiveInfoService => Boolean(service));
      if (resolved.length) return resolved;
    }
    return services.filter(service => service.appliesTo(query));
  }

  async function handle(query: string, hint?: string[]): Promise<LiveBrief> {
    const applicable = resolveServices(query, hint);
    if (!applicable.length) throw new Error("Orbit couldn't determine which live information to check for that request");

    const outcomes = await Promise.allSettled(applicable.map(service => service.fetch(query)));
    const sources: ResearchSource[] = [];
    const succeeded: string[] = [];
    const failed: string[] = [];
    const sourceLabels: string[] = [];
    let updatedAt = new Date().toISOString();

    outcomes.forEach((outcome, index) => {
      const service = applicable[index];
      if (outcome.status === "fulfilled" && outcome.value.ok) {
        sources.push(...outcome.value.sources);
        succeeded.push(service.name);
        sourceLabels.push(outcome.value.source);
        updatedAt = outcome.value.updatedAt;
      } else {
        failed.push(service.name);
      }
    });

    if (!sources.length) {
      const reason = outcomes.find(outcome => outcome.status === "fulfilled" && !outcome.value.ok) as PromiseFulfilledResult<{ ok: false; error: string }> | undefined;
      throw new Error(reason?.value.error || `Orbit couldn't retrieve live ${applicable.map(service => service.name).join(" or ")} information right now`);
    }

    const instructionParts = succeeded.length > 1
      ? [`Combine the ${succeeded.join(", ")} evidence below into one natural, conversational spoken briefing - a sentence or two per topic, in the order given.`]
      : [SERVICE_INSTRUCTIONS[succeeded[0]] || "Turn the evidence below into one natural spoken answer."];
    if (failed.length) instructionParts.push(`Also mention briefly and naturally that ${failed.join(" and ")} couldn't be checked right now.`);
    instructionParts.push("Do not use citation numbers or brackets.");

    const summary = await summarizeWithAI(instructionParts.join(" "), sources, () => sources.map(source => source.excerpt).join(" "));
    return { summary, source: sourceLabels.join(", "), updatedAt };
  }

  return { handle };
}
