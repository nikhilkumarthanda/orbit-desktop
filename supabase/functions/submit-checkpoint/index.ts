import { authenticate, jsonResponse, serviceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { CHECKPOINT_MIN_INTERVAL_MS, MAX_DISTANCE_PER_SECOND, MAX_SCORE_PER_SECOND } from "../_shared/rules.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = serviceClient();
  const auth = await authenticate(req, supabase);
  if ("error" in auth) return auth.error;
  const { userId } = auth;

  let body: { runId?: string; score?: number; distance?: number };
  try { body = await req.json() } catch { return jsonResponse({ accepted: false, error: "invalid body" }, 400) }
  const { runId, score, distance } = body;
  if (!runId || typeof score !== "number" || typeof distance !== "number" || score < 0 || distance < 0) {
    return jsonResponse({ accepted: false, error: "invalid checkpoint payload" }, 400);
  }

  const { data: run } = await supabase
    .from("active_runs")
    .select("run_id, latest_score, latest_distance, last_checkpoint_at")
    .eq("run_id", runId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!run) return jsonResponse({ accepted: false, error: "no such active run" }, 404);

  const nowMs = Date.now();
  const elapsedMs = nowMs - new Date(run.last_checkpoint_at).getTime();

  if (elapsedMs < CHECKPOINT_MIN_INTERVAL_MS) {
    return jsonResponse({ accepted: false, error: "checkpoint rate limit" }, 429);
  }
  if (score < run.latest_score || distance < run.latest_distance) {
    return jsonResponse({ accepted: false, error: "score/distance must not decrease" }, 400);
  }

  const elapsedSeconds = Math.max(elapsedMs / 1000, 0.1);
  const scoreRate = (score - run.latest_score) / elapsedSeconds;
  const distanceRate = (distance - run.latest_distance) / elapsedSeconds;
  if (scoreRate > MAX_SCORE_PER_SECOND || distanceRate > MAX_DISTANCE_PER_SECOND) {
    return jsonResponse({ accepted: false, error: "implausible growth rate" }, 400);
  }

  const { error } = await supabase
    .from("active_runs")
    .update({ latest_score: score, latest_distance: distance, last_checkpoint_at: new Date().toISOString() })
    .eq("run_id", runId);

  if (error) return jsonResponse({ accepted: false, error: "could not record checkpoint" }, 500);
  return jsonResponse({ accepted: true });
});
