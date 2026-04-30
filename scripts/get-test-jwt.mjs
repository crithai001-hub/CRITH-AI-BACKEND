#!/usr/bin/env node
// Sign a test user into Supabase and print their JWT to stdout.
//
// Usage:
//   node --env-file=.env.local scripts/get-test-jwt.mjs <email> <password>
//
// Quick clipboard:
//   node --env-file=.env.local scripts/get-test-jwt.mjs me@x.com pass | pbcopy
//
// Then:
//   export TEST_TOKEN=$(pbpaste)
//   ./test-curl.sh
//
// Requires Node 20.6+ for --env-file. The .env.local file must contain:
//   SUPABASE_URL=...
//   SUPABASE_ANON_KEY=...
//
// Diagnostic info (token expiry, etc.) goes to stderr so stdout stays clean
// for piping.

import { createClient } from "@supabase/supabase-js";

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error("Usage: node --env-file=.env.local scripts/get-test-jwt.mjs <email> <password>");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env.");
  console.error("Run with: node --env-file=.env.local scripts/get-test-jwt.mjs <email> <password>");
  process.exit(1);
}

const supabase = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const { data, error } = await supabase.auth.signInWithPassword({ email, password });

if (error || !data.session) {
  console.error(`Sign-in failed: ${error?.message ?? "no session"}`);
  process.exit(1);
}

const expiresAt = data.session.expires_at
  ? new Date(data.session.expires_at * 1000).toISOString()
  : "unknown";

console.error(`Signed in as ${data.user?.email}. Token expires at ${expiresAt}.`);
process.stdout.write(data.session.access_token);
