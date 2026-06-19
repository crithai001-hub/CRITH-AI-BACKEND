// lib/quota.ts
import { isProUser } from "./plan.js";
import { supabaseService } from "./supabase.js";

export function monthKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function getMonthlyLimit(): number {
  const raw = process.env.FREE_RESPONSE_ANALYSES_MONTHLY_LIMIT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export interface QuotaIncrementResult {
  used: number;
  limit: number;
  exceeded: boolean;
}

// Atomically upsert the user_usage row for the current month and increment
// the counter by 1. Returns the post-increment count.
//
// In the fact-checker MVP, ONLY successful verifications consume quota.
// Extraction (/api/fact-check, /api/fact-check-selection) does not call this.
// Parse / Gemini errors do not call this — we eat the cost rather than
// charging the user for our infra failures.
//
// KNOWN LIMITATION: this upsert+check pattern is not strictly atomic across
// truly concurrent requests from the same user. Under heavy concurrency a
// user could exceed the limit by 1–2 calls before enforcement kicks in.
// Acceptable for V2 launch volume. Fix path: wrap in a SQL function with
// SELECT ... FOR UPDATE or use a Postgres advisory lock keyed on user_id.
export async function incrementVerificationQuota(
  userId: string
): Promise<QuotaIncrementResult> {
  const limit = getMonthlyLimit();
  const key = monthKey();

  const { data: existing } = await supabaseService
    .from("user_usage")
    .select("response_analyses")
    .eq("user_id", userId)
    .eq("month_key", key)
    .maybeSingle();

  const nextCount = (existing?.response_analyses ?? 0) + 1;

  const { error } = await supabaseService.from("user_usage").upsert(
    {
      user_id: userId,
      month_key: key,
      response_analyses: nextCount,
      updated_at: new Date().toISOString()
    },
    { onConflict: "user_id,month_key" }
  );

  if (error) {
    throw new Error(`quota upsert failed: ${error.message}`);
  }

  const isPro = await isProUser(userId);
  return { used: nextCount, limit, exceeded: !isPro && nextCount > limit };
}
