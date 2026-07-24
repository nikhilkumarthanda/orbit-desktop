import type { LiveInfoService, ServiceOutcome } from "./types.js";

// Not wired to a real calendar backend yet (Apple Calendar vs Google Calendar
// is a real fork - AppleScript automation vs OAuth - that needs a decision
// before building it for real). Registered now so the engine's multi-service
// composition (e.g. "what's happening today") already degrades gracefully
// around it instead of needing special-casing later.
export function createCalendarService(): LiveInfoService {
  return {
    name: "calendar",
    appliesTo: query => /\b(calendar|meetings?|schedule|agenda|appointments?)\b/i.test(query),
    async fetch(): Promise<ServiceOutcome> {
      return { ok: false, error: "Calendar isn't connected yet" };
    },
  };
}
