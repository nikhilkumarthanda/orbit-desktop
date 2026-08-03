// The Supabase project URL and publishable (anon) key are not secrets -- Supabase's security
// model relies on Row Level Security, not on hiding this key. It is safe as plain client-side
// config. The service_role key must NEVER appear here, in Orbit, in Settings, in logs, or in
// the packaged app -- it lives only as a Supabase Edge Function secret.
export const SUPABASE_URL = "https://aueccpajpbwqxnhozezg.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable__-fdEl3izJFybNyvLWauaw_h1Osq7O9";
export const CLIENT_VERSION = "1.0.0";
