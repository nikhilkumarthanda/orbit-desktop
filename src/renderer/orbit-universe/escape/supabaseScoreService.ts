import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CLIENT_VERSION, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabaseConfig";
import type { FinishRunResult, LeaderboardEntry, LiveEntry, ScoreService, StartRunResult } from "./scoreService";

const RULES_VERSION = 1;
const LIVE_POLL_MS = 2000;

/**
 * Server-authoritative ScoreService: every write goes through a protected Edge Function
 * (start-run/submit-checkpoint/finish-run/abandon-run), never a direct table write. Reads go
 * through the read-only live_board/daily_best/global_best views. See supabase/schema.sql and
 * supabase/functions/ for the server side of this contract.
 */
export class SupabaseScoreService implements ScoreService {
  readonly mode = "online" as const;
  private client: SupabaseClient;
  private userId: string | null = null;
  private cachedDisplayName: string | null = null;
  private ready: Promise<void>;

  constructor() {
    this.client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    this.ready = this.initSession();
    // Attach a silent catch so a failed init doesn't surface as an unhandled-rejection console
    // warning before anything has had a chance to await `ready` -- ensureReady() below still
    // independently awaits (and reports) the same rejection to real callers.
    this.ready.catch(() => {});
  }

  private async initSession(): Promise<void> {
    const { data: { session } } = await this.client.auth.getSession();
    if (session?.user) {
      this.userId = session.user.id;
    } else {
      const { data, error } = await this.client.auth.signInAnonymously();
      if (error || !data.user) throw new Error(`Supabase anonymous sign-in failed: ${error?.message ?? "unknown error"}`);
      this.userId = data.user.id;
    }
    const { data: profile } = await this.client.from("profiles").select("display_name").eq("id", this.userId).maybeSingle();
    this.cachedDisplayName = (profile?.display_name as string | null) ?? null;
  }

  private async ensureReady(): Promise<string> {
    await this.ready;
    if (!this.userId) throw new Error("Supabase session not established");
    return this.userId;
  }

  async startRun(): Promise<StartRunResult> {
    await this.ensureReady();
    const { data, error } = await this.client.functions.invoke("start-run", {
      body: { clientVersion: CLIENT_VERSION, rulesVersion: RULES_VERSION },
    });
    if (error || !data) throw new Error(`start-run failed: ${error?.message ?? "no data returned"}`);
    return { runId: data.runId, seed: data.seed, rulesVersion: data.rulesVersion };
  }

  async submitCheckpoint(runId: string, score: number, distance: number): Promise<{ accepted: boolean }> {
    await this.ensureReady();
    const { data, error } = await this.client.functions.invoke("submit-checkpoint", { body: { runId, score, distance } });
    if (error) return { accepted: false };
    return { accepted: Boolean(data?.accepted) };
  }

  async finishRun(runId: string, score: number, durationMs: number): Promise<FinishRunResult> {
    await this.ensureReady();
    const { data, error } = await this.client.functions.invoke("finish-run", { body: { runId, score, durationMs } });
    if (error || !data) return { accepted: false };
    return { accepted: Boolean(data.accepted), rank: data.rank };
  }

  async abandonRun(runId: string): Promise<void> {
    await this.ensureReady();
    await this.client.functions.invoke("abandon-run", { body: { runId } });
  }

  subscribeLive(callback: (entries: LiveEntry[]) => void): () => void {
    let cancelled = false;
    const poll = async () => {
      await this.ready.catch(() => {});
      if (cancelled || !this.userId) return;
      const { data } = await this.client
        .from("live_board")
        .select("run_id,user_id,name,score,distance")
        .order("score", { ascending: false })
        .limit(50);
      if (!cancelled && data) {
        callback(data.map((row) => ({
          id: row.run_id as string,
          name: row.name as string,
          score: row.score as number,
          distance: row.distance as number,
          isSelf: row.user_id === this.userId,
        })));
      }
    };
    void poll();
    const id = setInterval(() => void poll(), LIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(id) };
  }

  private async fetchBoard(view: "daily_best" | "global_best"): Promise<LeaderboardEntry[]> {
    await this.ensureReady();
    const { data } = await this.client.from(view).select("user_id,name,score").order("score", { ascending: false }).limit(20);
    return (data ?? []).map((row, i) => ({
      rank: i + 1,
      name: row.name as string,
      score: row.score as number,
      isSelf: row.user_id === this.userId,
    }));
  }

  getDailyLeaderboard(): Promise<LeaderboardEntry[]> {
    return this.fetchBoard("daily_best");
  }

  getGlobalLeaderboard(): Promise<LeaderboardEntry[]> {
    return this.fetchBoard("global_best");
  }

  getDisplayName(): string | null {
    return this.cachedDisplayName;
  }

  async setDisplayName(name: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = name.trim();
    if (normalized.length < 2) return { ok: false, error: "Name must be at least 2 characters." };
    if (normalized.length > 20) return { ok: false, error: "Name must be 20 characters or fewer." };
    const userId = await this.ensureReady();
    const { error } = await this.client.from("profiles").upsert({ id: userId, display_name: normalized }, { onConflict: "id" });
    if (error) {
      if (error.code === "23505") return { ok: false, error: "That name is already taken." };
      return { ok: false, error: "Could not save display name." };
    }
    this.cachedDisplayName = normalized;
    return { ok: true };
  }
}
