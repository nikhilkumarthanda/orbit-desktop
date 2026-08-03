import { authenticate, jsonResponse, serviceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = serviceClient();
  const auth = await authenticate(req, supabase);
  if ("error" in auth) return auth.error;
  const { userId } = auth;

  let body: { runId?: string };
  try { body = await req.json() } catch { return jsonResponse({ error: "invalid body" }, 400) }
  const { runId } = body;
  if (!runId) return jsonResponse({ error: "missing runId" }, 400);

  const { data: run } = await supabase
    .from("active_runs")
    .select("run_id, status")
    .eq("run_id", runId)
    .eq("user_id", userId)
    .maybeSingle();

  // Already gone, or already finished/abandoned -- idempotent no-op either way.
  if (!run || run.status !== "active") return jsonResponse({ ok: true });

  const { error } = await supabase.from("active_runs").update({ status: "abandoned" }).eq("run_id", runId);
  if (error) return jsonResponse({ ok: false, error: "could not abandon run" }, 500);
  return jsonResponse({ ok: true });
});
