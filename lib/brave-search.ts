import type { BraveSearchResult } from "../types/index.js";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 8000;

// Retained from the prior Brave-backed implementation so existing unit tests
// (tests/brave-search.test.ts) keep compiling. Not used by the production
// search path anymore — the Gemini path uses parseGeminiGroundingResults.
export function parseBraveResponse(raw: unknown): BraveSearchResult[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { web?: { results?: unknown[] } };
  const results = r.web?.results;
  if (!Array.isArray(results)) return [];
  const out: BraveSearchResult[] = [];
  for (const item of results) {
    if (out.length >= MAX_RESULTS) break;
    if (!item || typeof item !== "object") continue;
    const it = item as { title?: unknown; description?: unknown; url?: unknown };
    if (typeof it.title !== "string" || typeof it.url !== "string") continue;
    out.push({
      title: it.title,
      snippet: typeof it.description === "string" ? it.description : "",
      url: it.url
    });
  }
  return out;
}

interface GeminiGroundingChunk {
  web?: { uri?: unknown; title?: unknown };
}

interface GeminiGroundingSupport {
  segment?: { text?: unknown };
  groundingChunkIndices?: unknown;
}

export function parseGeminiGroundingResults(raw: unknown): BraveSearchResult[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: unknown;
        groundingSupports?: unknown;
      };
    }>;
  };
  const meta = r.candidates?.[0]?.groundingMetadata;
  const chunks = meta?.groundingChunks;
  if (!Array.isArray(chunks)) return [];

  // groundingSupports map text segments back to chunk indices. Use the first
  // segment that references a chunk as that chunk's synthetic snippet so the
  // verifier still gets contextual hints.
  const supports = Array.isArray(meta?.groundingSupports) ? meta!.groundingSupports! : [];
  const snippetByChunk = new Map<number, string>();
  for (const raw of supports as GeminiGroundingSupport[]) {
    const text = typeof raw?.segment?.text === "string" ? raw.segment.text : "";
    if (!text) continue;
    const indices = Array.isArray(raw?.groundingChunkIndices) ? raw.groundingChunkIndices : [];
    for (const idx of indices) {
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) continue;
      if (!snippetByChunk.has(idx)) snippetByChunk.set(idx, text);
    }
  }

  const out: BraveSearchResult[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (out.length >= MAX_RESULTS) break;
    const c = chunks[i] as GeminiGroundingChunk | null | undefined;
    const url = typeof c?.web?.uri === "string" ? c.web.uri : "";
    const title = typeof c?.web?.title === "string" ? c.web.title : "";
    if (!url || !title) continue;
    out.push({ title, snippet: snippetByChunk.get(i) ?? "", url });
  }
  return out;
}

export interface BraveSearchSuccess {
  ok: true;
  results: BraveSearchResult[];
}
export interface BraveSearchError {
  ok: false;
  reason: "no_api_key" | "http_error" | "timeout" | "parse_error";
  status?: number;
}
export type BraveSearchOutcome = BraveSearchSuccess | BraveSearchError;

export async function searchClaim(query: string): Promise<BraveSearchOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: "no_api_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }]
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "http_error" };
  }
  clearTimeout(timer);

  if (!response.ok) {
    console.error("[gemini-search] non-2xx", { status: response.status, query });
    return { ok: false, reason: "http_error", status: response.status };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "parse_error" };
  }

  return { ok: true, results: parseGeminiGroundingResults(payload) };
}
