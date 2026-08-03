import { authenticate, jsonResponse, serviceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { MAX_SCORE_PER_SECOND } from "../_shared/rules.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** How many distinct players have a strictly higher personal-best score than this one, plus 1.
 *  Reads global_best (one row per player, their best finished run) rather than the raw `runs`
 *  ledger, so this matches exactly what the global leaderboard itself shows. */
async function computeGlobalRank(supabase: SupabaseClient, score: number): Promise<number> {
  const { count } = await supabase.from("global_best").select("*", { count: "exact", head: true }).gt("score", score);
  return (count ?? 0) + 1;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = serviceClient();
  const auth = await authenticate(req, supabase);
  if ("error" in auth) return auth.error;
  const { userId } = auth;

  let body: { runId?: string; score?: number; durationMs?: number };
  try { body = await req.json() } catch { return jsonResponse({ accepted: false, error: "invalid body" }, 400) }
  const { runId, score, durationMs } = body;
  if (!runId || typeof score !== "number" || typeof durationMs !== "number" || score < 0 || durationMs < 0) {
    return jsonResponse({ accepted: false, error: "invalid finish payload" }, 400);
  }

  const { data: run } = await supabase
    .from("active_runs")
    .select("run_id, status, latest_score, started_at, seed_date, rules_version")
    .eq("run_id", runId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!run) return jsonResponse({ accepted: false, error: "no such run" }, 404);

  // Idempotent: a retried network call for an already-finished run returns success again
  // instead of erroring or inserting a second row into `runs`.
  if (run.status === "finished") {
    return jsonResponse({ accepted: true, rank: await computeGlobalRank(supabase, run.latest_score) });
  }
  if (run.status !== "active") return jsonResponse({ accepted: false, error: `run is ${run.status}` }, 409);

  if (score < run.latest_score) {
    return jsonResponse({ accepted: false, error: "final score must not be less than the last accepted checkpoint" }, 400);
  }
  const elapsedSeconds = Math.max((Date.now() - new Date(run.started_at).getTime()) / 1000, 1);
  if (score / elapsedSeconds > MAX_SCORE_PER_SECOND) {
    return jsonResponse({ accepted: false, error: "implausible final score" }, 400);
  }

  const { error: insertError } = await supabase.from("runs").insert({
    user_id: userId,
    score,
    duration_ms: durationMs,
    seed_date: run.seed_date,
    rules_version: run.rules_version,
  });
  if (insertError) return jsonResponse({ accepted: false, error: "could not record run" }, 500);

  await supabase
    .from("active_runs")
    .update({ status: "finished", latest_score: score, finished_at: new Date().toISOString() })
    .eq("run_id", runId);

  return jsonResponse({ accepted: true, rank: await computeGlobalRank(supabase, score) });
});
