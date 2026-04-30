import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { supabaseService } from "../lib/supabase.js";
import type { EventsRequestBody, EventType, Provocation } from "../types/index.js";

const VALID_EVENTS: ReadonlySet<EventType> = new Set([
  "shown",
  "expanded",
  "sent_to_ai",
  "dismissed",
  "copied"
]);

function isValidBody(raw: unknown): raw is EventsRequestBody {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Record<string, unknown>;
  return (
    typeof b.analysis_id === "string" &&
    typeof b.provocation_index === "number" &&
    Number.isInteger(b.provocation_index) &&
    b.provocation_index >= 0 &&
    typeof b.event_type === "string" &&
    VALID_EVENTS.has(b.event_type as EventType)
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;

  if (req.method !== "POST") {
    res.status(405).json({ error: "bad_request", message: "POST only" });
    return;
  }

  try {
    if (!isValidBody(req.body)) {
      res.status(400).json({ error: "bad_request", message: "invalid request body" });
      return;
    }
    const body = req.body;

    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // Verify the analysis belongs to this user, and fetch the provocations
    // array so we can denormalize lens/severity onto the event row.
    const { data: analysis, error: lookupError } = await supabaseService
      .from("response_analyses")
      .select("user_id, provocations")
      .eq("id", body.analysis_id)
      .maybeSingle();

    if (lookupError) {
      console.error("[events] analysis lookup failed", lookupError);
      res.status(500).json({ error: "internal" });
      return;
    }
    if (!analysis || analysis.user_id !== user.user_id) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const provocations = (analysis.provocations ?? []) as Provocation[];
    const provocation = provocations[body.provocation_index];
    if (!provocation) {
      res
        .status(400)
        .json({ error: "bad_request", message: "provocation_index out of range" });
      return;
    }

    const { error: insertError } = await supabaseService.from("provocation_events").insert({
      analysis_id: body.analysis_id,
      provocation_index: body.provocation_index,
      lens: provocation.lens,
      severity: provocation.severity,
      event_type: body.event_type
    });

    if (insertError) {
      console.error("[events] insert failed", insertError);
      res.status(500).json({ error: "internal" });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[events] unhandled", err);
    res.status(500).json({ error: "internal" });
  }
}
