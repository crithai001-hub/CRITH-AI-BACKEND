// Stable, deterministic IDs for flags and claims. The same (lens, anchor) on
// the same response produces the same flag_id across refires — the extension
// dedupes hosts by provocation_id, so refire stability is what stops the
// teardown + re-render flicker the frontend brief calls out.
//
// We truncate anchors to 60 chars before hashing so the ID survives the
// frontend's refire scenario where the response grows and the extracted
// anchor extends beyond the original 30-80 char window.

const ANCHOR_PREFIX_LEN = 40;

export function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + char
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Force unsigned 32-bit, zero-pad to 8 hex chars.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function flagId(lens: string, anchoredTo: string): string {
  const key = `${lens}:${anchoredTo.slice(0, ANCHOR_PREFIX_LEN)}`;
  return `flag_${djb2(key)}`;
}

export function claimId(claimType: string, anchoredTo: string): string {
  const key = `${claimType}:${anchoredTo.slice(0, ANCHOR_PREFIX_LEN)}`;
  return `claim_${djb2(key)}`;
}

// Collisions at the per-analysis scale (max ~10 items) are unlikely but not
// impossible. Suffix duplicates with -1, -2, ... in insertion order so the
// suffix is stable across refires (refire returns same items in same order).
export function disambiguate(ids: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return ids.map((id) => {
    const n = counts.get(id) ?? 0;
    counts.set(id, n + 1);
    return n === 0 ? id : `${id}-${n}`;
  });
}
