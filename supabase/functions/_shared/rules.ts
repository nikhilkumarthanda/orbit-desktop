// Accepted client rule sets. Bump this (and add the new version here) whenever a gameplay
// change affects fairness (obstacle generation, scoring formula, collision geometry) -- clients
// running an unlisted version are rejected at start-run rather than silently scored unfairly.
export const ACCEPTED_RULES_VERSIONS = [1];

// Accepted app build versions. Distinct from rules_version: this gates on the client build
// itself (so a known-buggy or known-cheatable old installed copy can be refused even if its
// gameplay rules haven't changed), while rules_version gates on gameplay-fairness compatibility.
export const ACCEPTED_CLIENT_VERSIONS = ["1.0.0"];

// A run that hasn't checkpointed in this long is treated as abandoned/dead rather than a
// genuine concurrent session, so start-run can reclaim it and let the player begin fresh.
export const START_RUN_GRACE_MS = 15_000;

// Client checkpoints on a ~1.2s cadence (see orbit-play.tsx); tolerate jitter but reject a
// client hammering the endpoint far faster than any real client would.
export const CHECKPOINT_MIN_INTERVAL_MS = 900;

// Legitimate worst case: score accrues at speed*125*multiplier per tick (max speed 0.018,
// multiplier capped at 8) at ~60 ticks/sec, plus near-miss bonuses (capped combo, obstacle
// spacing bounds their frequency) -- worst-case legitimate rate is roughly 1900/sec. This
// ceiling is a generous ~2x margin above that, so it only catches clearly-impossible growth.
export const MAX_SCORE_PER_SECOND = 4000;

// Legitimate max travel speed is ~1.08 distance-units/sec (max `speed` field * 60 ticks).
export const MAX_DISTANCE_PER_SECOND = 3;
