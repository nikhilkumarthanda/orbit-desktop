import { seedFromLocalDate } from "./seededRandom.ts";
import { RULES_VERSION, type FinishRunResult, type LeaderboardEntry, type LiveEntry, type ScoreService, type StartRunResult } from "./scoreService.ts";

type StoredRun = { score: number; durationMs: number; seedDate: string; finishedAt: number };
type Store = Pick<Storage, "getItem" | "setItem">;

const RUNS_KEY = "orbit-escape-local-runs";
const NAME_KEY = "orbit-escape-display-name";
const MAX_STORED_RUNS = 200;

function createMemoryStore(): Store {
  const map = new Map<string, string>();
  return { getItem: (k) => (map.has(k) ? map.get(k)! : null), setItem: (k, v) => { map.set(k, v) } };
}

const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` };

/**
 * Fully offline ScoreService: local-date seed (practice-only — a real competitive daily seed
 * must come from the server, per the backend plan), everything persisted in localStorage (or
 * an injected in-memory store for tests), single local player only.
 *
 * Local runs never migrate into an online leaderboard, on reconnection or ever — that is the
 * permanent trust boundary, not a temporary limitation. Every entry this service produces is
 * `isSelf: true` and the UI is expected to label it "Local / Offline" accordingly.
 */
export class LocalScoreService implements ScoreService {
  readonly mode = "local" as const;
  private store: Store;
  private activeRun: { runId: string; score: number; distance: number } | null = null;
  private liveSubscribers = new Set<(entries: LiveEntry[]) => void>();

  constructor(store?: Store) {
    this.store = store ?? (typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : createMemoryStore());
  }

  private readRuns(): StoredRun[] {
    try { return JSON.parse(this.store.getItem(RUNS_KEY) ?? "[]") } catch { return [] }
  }

  private writeRuns(runs: StoredRun[]) {
    this.store.setItem(RUNS_KEY, JSON.stringify(runs.slice(-MAX_STORED_RUNS)));
  }

  private liveEntries(): LiveEntry[] {
    if (!this.activeRun) return [];
    return [{ id: "local", name: this.getDisplayName() ?? "You", score: Math.floor(this.activeRun.score), distance: this.activeRun.distance, isSelf: true }];
  }

  private notifyLive() {
    const entries = this.liveEntries();
    this.liveSubscribers.forEach((cb) => cb(entries));
  }

  async startRun(): Promise<StartRunResult> {
    const runId = `local-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.activeRun = { runId, score: 0, distance: 0 };
    this.notifyLive();
    return { runId, seed: seedFromLocalDate(), rulesVersion: RULES_VERSION };
  }

  async submitCheckpoint(runId: string, score: number, distance: number): Promise<{ accepted: boolean }> {
    if (!this.activeRun || this.activeRun.runId !== runId) return { accepted: false };
    if (score < this.activeRun.score || distance < this.activeRun.distance) return { accepted: false };
    this.activeRun.score = score;
    this.activeRun.distance = distance;
    this.notifyLive();
    return { accepted: true };
  }

  async finishRun(runId: string, score: number, durationMs: number): Promise<FinishRunResult> {
    if (!this.activeRun || this.activeRun.runId !== runId) return { accepted: false };
    const finalScore = Math.max(score, this.activeRun.score);
    const runs = this.readRuns();
    runs.push({ score: finalScore, durationMs, seedDate: todayKey(), finishedAt: Date.now() });
    this.writeRuns(runs);
    this.activeRun = null;
    this.notifyLive();
    const globalBest = runs.reduce((max, r) => Math.max(max, r.score), 0);
    return { accepted: true, rank: finalScore >= globalBest ? 1 : undefined };
  }

  async abandonRun(runId: string): Promise<void> {
    if (this.activeRun?.runId === runId) { this.activeRun = null; this.notifyLive() }
  }

  subscribeLive(callback: (entries: LiveEntry[]) => void): () => void {
    this.liveSubscribers.add(callback);
    callback(this.liveEntries());
    return () => { this.liveSubscribers.delete(callback) };
  }

  async getDailyLeaderboard(): Promise<LeaderboardEntry[]> {
    const today = todayKey();
    const best = this.readRuns().filter((r) => r.seedDate === today).reduce((max, r) => Math.max(max, r.score), 0);
    if (best === 0) return [];
    return [{ rank: 1, name: this.getDisplayName() ?? "You", score: best, isSelf: true }];
  }

  async getGlobalLeaderboard(): Promise<LeaderboardEntry[]> {
    const best = this.readRuns().reduce((max, r) => Math.max(max, r.score), 0);
    if (best === 0) return [];
    return [{ rank: 1, name: this.getDisplayName() ?? "You", score: best, isSelf: true }];
  }

  getDisplayName(): string | null {
    return this.store.getItem(NAME_KEY);
  }

  async setDisplayName(name: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = name.trim();
    if (normalized.length < 2) return { ok: false, error: "Name must be at least 2 characters." };
    if (normalized.length > 20) return { ok: false, error: "Name must be 20 characters or fewer." };
    this.store.setItem(NAME_KEY, normalized);
    return { ok: true };
  }
}
