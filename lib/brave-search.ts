import type { BraveSearchResult } from "../types/index.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 8000;

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
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return { ok: false, reason: "no_api_key" };

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(MAX_RESULTS));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "http_error" };
  }
  clearTimeout(timer);

  if (!response.ok) {
    console.error("[brave-search] non-2xx", { status: response.status, query });
    return { ok: false, reason: "http_error", status: response.status };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "parse_error" };
  }

  return { ok: true, results: parseBraveResponse(payload) };
}
