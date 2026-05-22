import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { isProUser } from "../lib/plan.js";
import { getMonthlyLimit, monthKey } from "../lib/quota.js";
import { supabaseService } from "../lib/supabase.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(req, res);
  // Override the shared helper's POST-only methods header — this endpoint is GET.
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (handlePreflight(req, res)) return;

  if (req.method !== "GET") {
    res.status(405).json({ error: "bad_request", message: "GET only" });
    return;
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const { data, error } = await supabaseService
      .from("user_usage")
      .select("response_analyses")
      .eq("user_id", user.user_id)
      .eq("month_key", monthKey())
      .maybeSingle();

    if (error) {
      console.error("[user-plan] usage lookup failed", error);
      res.status(500).json({ error: "internal" });
      return;
    }

    const is_pro = await isProUser(user.user_id);
    res.status(200).json({
      is_pro,
      flags_used: data?.response_analyses ?? 0,
      flags_limit: is_pro ? null : getMonthlyLimit()
    });
  } catch (err) {
    console.error("[user-plan] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
