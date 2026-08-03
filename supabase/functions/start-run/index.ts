import { authenticate, jsonResponse, serviceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { ACCEPTED_CLIENT_VERSIONS, ACCEPTED_RULES_VERSIONS, START_RUN_GRACE_MS } from "../_shared/rules.ts";

const RULES_VERSION = 1;
// Fixed function-local salt -- combined with the UTC date so every player gets the identical
// seed for a given day, without the seed being trivially guessable from the date alone.
const SEED_SALT = 0x9e3779b9;

function seedFromUtcDate(date: Date): number {
  const key = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash ^ SEED_SALT) >>> 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = serviceClient();
  const auth = await authenticate(req, supabase);
  if ("error" in auth) return auth.error;
  const { userId } = auth;

  let body: { rulesVersion?: number; clientVersion?: string } = {};
  try { body = await req.json() } catch { /* handled by the validation below */ }

  if (!body.clientVersion || !ACCEPTED_CLIENT_VERSIONS.includes(body.clientVersion)) {
    return jsonResponse({ error: "unsupported client_version -- please update the app" }, 400);
  }
  const rulesVersion = body.rulesVersion ?? RULES_VERSION;
  if (!ACCEPTED_RULES_VERSIONS.includes(rulesVersion)) {
    return jsonResponse({ error: "unsupported rules_version -- please update the app" }, 400);
  }

  // Ensure a profile row exists (first anonymous sign-in never gets one otherwise).
  await supabase.from("profiles").upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });

  // One active run per player, enforced again here (in addition to the DB's own unique index)
  // so we can give a clear signal: a stale run (no checkpoint in the grace window) is reclaimed
  // silently, but a genuinely concurrent session is rejected instead of having its progress
  // silently discarded.
  const { data: existing } = await supabase
    .from("active_runs")
    .select("run_id, last_checkpoint_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (existing) {
    const ageMs = Date.now() - new Date(existing.last_checkpoint_at).getTime();
    if (ageMs < START_RUN_GRACE_MS) {
      return jsonResponse({ error: "a run is already active for this account" }, 409);
    }
    await supabase.from("active_runs").update({ status: "abandoned" }).eq("run_id", existing.run_id);
  }

  const now = new Date();
  const seed = seedFromUtcDate(now);
  const serverDate = now.toISOString().slice(0, 10);

  const { data: inserted, error } = await supabase
    .from("active_runs")
    .insert({ user_id: userId, seed, seed_date: serverDate, rules_version: rulesVersion })
    .select("run_id")
    .single();

  if (error || !inserted) return jsonResponse({ error: "could not start run" }, 500);

  return jsonResponse({ runId: inserted.run_id, seed, rulesVersion, serverDate });
});
