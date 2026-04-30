import type { VercelRequest, VercelResponse } from "@vercel/node";

// Bare-minimum function: no imports beyond Vercel types, no env reads.
// If this returns 500, the deploy itself is broken at the platform level
// (not env vars, not application code).
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown",
    deployedAt: new Date().toISOString()
  });
}
