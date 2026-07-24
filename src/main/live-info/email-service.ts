import type { LiveInfoService, ServiceOutcome } from "./types.js";

// Same status as calendar-service.ts: not wired to a real backend yet pending
// an Apple Mail vs Gmail decision. Registered for graceful multi-service
// degradation now.
export function createEmailService(): LiveInfoService {
  return {
    name: "email",
    appliesTo: query => /\b(emails?|inbox)\b/i.test(query),
    async fetch(): Promise<ServiceOutcome> {
      return { ok: false, error: "Email isn't connected yet" };
    },
  };
}
