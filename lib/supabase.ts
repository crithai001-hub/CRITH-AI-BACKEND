import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Lazy clients — env vars are read on first use, not at module import time.
// Keeps the function loadable on Vercel even when env is misconfigured, so
// errors surface as clean 500s with a logged reason instead of
// FUNCTION_INVOCATION_FAILED with no stack trace.

let _supabaseAnon: SupabaseClient | null = null;
let _supabaseService: SupabaseClient | null = null;

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function getSupabaseAnon(): SupabaseClient {
  if (!_supabaseAnon) {
    _supabaseAnon = createClient(readEnv("SUPABASE_URL"), readEnv("SUPABASE_ANON_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _supabaseAnon;
}

export function getSupabaseService(): SupabaseClient {
  if (!_supabaseService) {
    _supabaseService = createClient(readEnv("SUPABASE_URL"), readEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _supabaseService;
}

// Backward-compatible proxies for code that still imports the old names.
// Each access goes through the lazy getter.
export const supabaseAnon: SupabaseClient = new Proxy({} as SupabaseClient, {
  get: (_target, prop) => Reflect.get(getSupabaseAnon(), prop)
});
export const supabaseService: SupabaseClient = new Proxy({} as SupabaseClient, {
  get: (_target, prop) => Reflect.get(getSupabaseService(), prop)
});
