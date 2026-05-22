import { supabaseService } from "./supabase.js";

// Single source of truth for "is this user on the pro tier?". Reads from
// public.profiles.is_pro, which is written by the Stripe webhook
// (api/stripe-webhook.ts) on checkout.session.completed /
// customer.subscription.deleted. Used by /api/user-plan and by
// incrementResponseAnalysesQuota (pro users never see exceeded:true).
//
// Fails closed: any error or missing row → treat as free. Conservative
// because the profile row is auto-created on signup via the
// on_auth_user_created trigger, so a missing row indicates either a brand-new
// account before the trigger ran or a real anomaly — neither should
// accidentally grant pro.
export async function isProUser(userId: string): Promise<boolean> {
  const { data, error } = await supabaseService
    .from("profiles")
    .select("is_pro")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[plan] isProUser lookup failed", error);
    return false;
  }
  return data?.is_pro === true;
}
