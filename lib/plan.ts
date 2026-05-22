// Single source of truth for "is this user on the pro tier?".
// Used by /api/user-plan (to report is_pro + flags_limit=null) and by
// incrementResponseAnalysesQuota (to never exceed for pro users).
//
// No billing system exists yet — every user is free. When pro tier ships,
// flip this function to read from whatever source becomes authoritative:
//   - auth.users.raw_app_meta_data->>'plan' = 'pro' (managed via Supabase)
//   - a dedicated public.user_plans table joined on user_id
//   - an external billing webhook (Stripe, Lemon Squeezy, etc.) writing the
//     above on subscription events
//
// The userId param is unused for now but kept so callers don't have to change
// when the real check lands.
export async function isProUser(_userId: string): Promise<boolean> {
  return false;
}
