import type { VercelRequest, VercelResponse } from "@vercel/node";

// TODO: tighten to specific ALLOWED_EXTENSION_ID env var before public Chrome
// Web Store launch. Auth (Supabase JWT) is doing the real security work — wide-open
// CORS just means random origins waste preflights and get rejected at the auth layer.
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-z]{32}$/;

export function applyCors(req: VercelRequest, res: VercelResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && EXTENSION_ORIGIN_RE.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
    // Dev fallback: unpacked extensions during development have arbitrary IDs.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// Returns true if the request was a preflight and the response has been ended.
export function handlePreflight(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}
