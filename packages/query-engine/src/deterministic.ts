/**
 * @module deterministic
 *
 * A SelectionPlanIR is a contract, not a report: the same snapshot plus the same
 * request must serialize to the same bytes on every machine and every run. Two
 * things break that if left to chance — IEEE-754 tails that differ by 1e-17 and
 * flip a comparison, and `Record` key order that follows insertion (which for a
 * `Map`-driven build follows discovery order). Everything here exists to remove
 * those two degrees of freedom, so callers never sort ad hoc at the call site.
 */

/** Decimal places retained on every score and feature value that leaves the engine. */
export const SCORE_PRECISION = 6;

const SCALE = 10 ** SCORE_PRECISION;

/**
 * Round to a fixed grid so that float tails cannot decide an ordering, and so
 * that a plan built from the same inputs on a different CPU serializes equally.
 * `-0` is normalized to `0` because `JSON.stringify` renders them differently.
 */
export function quantize(value: number): number {
  const rounded = Math.round(value * SCALE) / SCALE;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Byte-order string comparison. `localeCompare` is deliberately avoided: its
 * result depends on the host ICU data, which is exactly the kind of ambient
 * input a deterministic plan must not read.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted key list, so iteration never inherits insertion order. */
export function sortedKeys<T>(record: Readonly<Record<string, T>>): readonly string[] {
  return Object.keys(record).sort(compareStrings);
}

/**
 * Build a record whose key insertion order is sorted, making `JSON.stringify`
 * output stable regardless of how the entries were discovered.
 */
export function orderedRecord<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [key, value] of [...entries].sort((a, b) => compareStrings(a[0], b[0]))) out[key] = value;
  return out;
}

/**
 * Rank by descending quantized score with the unit id as the sole tie-break.
 * Comparing quantized values means near-ties resolve by id rather than by noise.
 */
export function compareByScoreThenId(
  a: { readonly score: number; readonly unitId: string },
  b: { readonly score: number; readonly unitId: string },
): number {
  const delta = quantize(b.score) - quantize(a.score);
  if (delta !== 0) return delta > 0 ? 1 : -1;
  return compareStrings(a.unitId, b.unitId);
}

/** Deduplicate and sort, so a reason list is a set with a canonical rendering. */
export function canonicalStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}
