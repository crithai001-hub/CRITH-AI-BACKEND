import type { VercelRequest, VercelResponse } from "@vercel/node";
import { applyCors, handlePreflight } from "../lib/cors.js";
import { getUserFromRequest } from "../lib/auth.js";
import { supabaseService } from "../lib/supabase.js";
import { resolveFlagItems } from "../lib/flag-resolution.js";
import type {
  EventsRequestBody,
  EventType,
  Provocation,
  Validation
} from "../types/index.js";

const VALID_EVENTS: ReadonlySet<EventType> = new Set([
  "shown",
  "expanded",
  "sent_to_ai",
  "dismissed",
  "copied",
  "explained",
  "useful",
  "not_useful",
  "asked_ai"
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

    // Verify the analysis belongs to this user, and fetch both the legacy
    // provocations and the v14+ validations columns so we can denormalize
    // lens/severity onto the event row regardless of which schema produced it.
    // v24+: also fetch suppressed_validations so provocation_index resolves
    // correctly against the combined flags[] array built by buildFlags.
    const { data: analysis, error: lookupError } = await supabaseService
      .from("response_analyses")
      .select("user_id, provocations, validations, suppressed_validations")
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

    // Prefer v14+ validations; fall back to legacy provocations. Both shapes
    // expose the lens/severity fields the events table denormalizes.
    // v24+: build the same combined array as buildFlags (validations first,
    // suppressed_validations second) so provocation_index is correctly aligned.
    const validations = (analysis.validations ?? []) as Validation[];
    const suppressed = (analysis.suppressed_validations ?? []) as Validation[];
    const provocations = (analysis.provocations ?? []) as Provocation[];
    const items = resolveFlagItems(validations, suppressed, provocations);
    const item = items[body.provocation_index];
    if (!item) {
      res
        .status(400)
        .json({ error: "bad_request", message: "provocation_index out of range" });
      return;
    }

    const { error: insertError } = await supabaseService.from("provocation_events").insert({
      analysis_id: body.analysis_id,
      provocation_index: body.provocation_index,
      lens: item.lens,
      severity: item.severity,
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
