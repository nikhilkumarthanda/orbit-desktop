export type LiveEntry = { id: string; name: string; score: number; distance: number; isSelf: boolean };
export type LeaderboardEntry = { rank: number; name: string; score: number; isSelf: boolean };
export type StartRunResult = { runId: string; seed: number; rulesVersion: number };
export type FinishRunResult = { accepted: boolean; rank?: number };

export const RULES_VERSION = 1;

/**
 * Shared contract for the leaderboard backend. The client never writes a score directly to
 * any store — every authoritative state change goes through these operations, so the same
 * interface can be backed locally (offline, single-player) now and by a server-authoritative
 * Supabase implementation later (Milestones E/F) without touching call sites.
 */
export interface ScoreService {
  readonly mode: "local" | "online";
  startRun(): Promise<StartRunResult>;
  submitCheckpoint(runId: string, score: number, distance: number): Promise<{ accepted: boolean }>;
  finishRun(runId: string, score: number, durationMs: number): Promise<FinishRunResult>;
  abandonRun(runId: string): Promise<void>;
  subscribeLive(callback: (entries: LiveEntry[]) => void): () => void;
  getDailyLeaderboard(): Promise<LeaderboardEntry[]>;
  getGlobalLeaderboard(): Promise<LeaderboardEntry[]>;
  getDisplayName(): string | null;
  setDisplayName(name: string): Promise<{ ok: boolean; error?: string }>;
}
