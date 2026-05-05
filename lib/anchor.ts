// Anchor recovery: when the model emits an anchored_to that isn't a verbatim
// substring of the response (paraphrased, concatenated list items, dash/quote
// mismatches), find the closest verbatim substring of the response that does
// match and return that. The frontend renders underlines via
// `response.includes(anchored_to)` — the recovered string is always a real
// substring of the response, so the underline always renders correctly.
//
// Algorithm:
//   1. If the anchor is already a verbatim substring → return as-is.
//   2. Normalize both (collapse whitespace, fold en/em-dash → '-', curly quotes
//      → straight, nbsp → space). Try a normalized direct match.
//   3. Otherwise, find the longest contiguous substring of the normalized
//      anchor that appears in the normalized response.
//   4. Map the normalized match back to the original response slice (the
//      slice carries the response's own punctuation and whitespace).
//   5. Return null if nothing of length >= ANCHOR_MIN_LEN can be recovered.

export const ANCHOR_MIN_LEN = 30;

interface NormalizedWithMap {
  norm: string;
  // map[i] = index in original string of the i-th character of `norm`
  map: number[];
}

function buildNormalizedWithMap(s: string): NormalizedWithMap {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    let replaced: string;
    // Whitespace (incl. nbsp) collapses to a single space.
    if (/\s/.test(ch) || ch === "\u00A0") {
      if (out.length > 0 && out[out.length - 1] === " ") continue;
      replaced = " ";
    } else if (ch === "\u2013" || ch === "\u2014" || ch === "\u2212") {
      replaced = "-";
    } else if (ch === "\u2018" || ch === "\u2019") {
      replaced = "'";
    } else if (ch === "\u201C" || ch === "\u201D") {
      replaced = '"';
    } else {
      replaced = ch;
    }
    out.push(replaced);
    map.push(i);
  }
  return { norm: out.join(""), map };
}

function sliceFromNormalized(
  resp: string,
  respMap: number[],
  startNorm: number,
  lenNorm: number
): string | null {
  if (lenNorm <= 0) return null;
  const endNorm = startNorm + lenNorm - 1;
  const startOrig = respMap[startNorm];
  const endOrig = respMap[endNorm];
  if (startOrig === undefined || endOrig === undefined) return null;
  return resp.slice(startOrig, endOrig + 1);
}

export function recoverAnchor(anchor: string, response: string): string | null {
  if (response.includes(anchor)) return anchor;

  const { norm: nResp, map: respMap } = buildNormalizedWithMap(response);
  const { norm: nAnchor } = buildNormalizedWithMap(anchor);

  // Full normalized match.
  const fullIdx = nResp.indexOf(nAnchor);
  if (fullIdx !== -1) {
    const recovered = sliceFromNormalized(response, respMap, fullIdx, nAnchor.length);
    if (recovered && recovered.length >= ANCHOR_MIN_LEN) return recovered;
  }

  // Longest contiguous substring of nAnchor present in nResp.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < nAnchor.length; i++) {
    if (nAnchor.length - i <= bestLen) break;
    for (let j = nAnchor.length; j - i > bestLen; j--) {
      const candidate = nAnchor.slice(i, j);
      if (nResp.includes(candidate)) {
        bestStart = i;
        bestLen = j - i;
        break;
      }
    }
  }

  if (bestLen < ANCHOR_MIN_LEN || bestStart < 0) return null;

  const candidate = nAnchor.slice(bestStart, bestStart + bestLen);
  const matchInResp = nResp.indexOf(candidate);
  if (matchInResp === -1) return null;

  const recovered = sliceFromNormalized(response, respMap, matchInResp, bestLen);
  if (!recovered || recovered.length < ANCHOR_MIN_LEN) return null;
  return recovered;
}

// Anchors are verbatim substrings of the response. Two anchors "overlap" if
// their character spans in the response intersect. This is used to dedup
// validations against verifiable_claims — when a validator and the claim
// extractor both flag the same span, the claim wins (factual wrongness is
// more specific than a reasoning gap on the same content).
export function anchorsOverlap(response: string, a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const aStart = response.indexOf(a);
  if (aStart === -1) return false;
  const bStart = response.indexOf(b);
  if (bStart === -1) return false;
  const aEnd = aStart + a.length;
  const bEnd = bStart + b.length;
  return aStart < bEnd && bStart < aEnd;
}
