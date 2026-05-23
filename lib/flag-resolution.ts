import type { Provocation, Validation } from "../types/index.js";

// Resolve the array used to look up an item by provocation_index in the legacy
// /api/events and /api/explain-provocation flows. Mirrors the indexing used by
// buildFlags in api/analyze-response.ts (validations first, then suppressed).
// The modern path is taken whenever EITHER column has content; legacy
// provocations are only consulted for pre-v14 rows where both modern columns
// are empty.
export function resolveFlagItems(
  validations: readonly Validation[],
  suppressed: readonly Validation[],
  legacyProvocations: readonly Provocation[]
): Array<Validation | Provocation> {
  if (validations.length > 0 || suppressed.length > 0) {
    return [...validations, ...suppressed];
  }
  return [...legacyProvocations];
}
