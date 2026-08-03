import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "./cors.ts";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/** A client authenticated as service_role, which bypasses RLS -- this is the only thing in the
 *  system permitted to write to active_runs/runs, and this key must never reach the client. */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set for this function");
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Verifies the caller's bearer JWT (the client's own anon-signed session token, forwarded in
 *  the Authorization header) and returns the authenticated user id, without trusting anything
 *  else the client claims about who it is. */
export async function authenticate(req: Request, supabase: SupabaseClient): Promise<{ userId: string } | { error: Response }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: jsonResponse({ error: "missing bearer token" }, 401) };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { error: jsonResponse({ error: "invalid or expired session" }, 401) };
  return { userId: data.user.id };
}
