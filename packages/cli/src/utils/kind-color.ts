/**
 * Deterministic colouring for *any* unit-kind string.
 *
 * Why not a kind → colour table: a table is a closed set of kind names, and a
 * closed set of kind names inside the CLI is the engine claiming to own the
 * domain ontology (architecture §3.1 — the engine may know "there are type
 * definitions", never which ones exist). A corpus that declares a kind the CLI
 * has never heard of must render exactly as well as one that does not, and it
 * must render the *same* colour on every run and on every machine, so the hash
 * is over the kind name itself rather than over discovery order.
 */

import { cyan, green, yellow, magenta, blue, gray } from './display';

/** A plain rotation of paint functions. Carries no meaning; order is not a ranking.
 *  Deliberately not named after a colour-system concept — the audit vocabulary
 *  owns those words, and the engine must not spell one even incidentally. */
const PAINTS: readonly ((s: string) => string)[] = [cyan, green, yellow, magenta, blue];

/** FNV-1a, chosen because it is short, stable across runs, and needs no deps. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The paint function a kind maps to, for callers that colour something else. */
export function paintFor(kind: string): (s: string) => string {
  if (kind.length === 0) return gray;
  return PAINTS[hash(kind) % PAINTS.length]!;
}

/**
 * Pick a stable colour for a kind. An empty/unknown kind stays grey so that
 * "no kind declared" reads differently from "a kind the CLI does not know" —
 * the first is missing data, the second is normal.
 */
export function colorKind(kind: string): string {
  if (kind.length === 0) return gray('(no kind)');
  return paintFor(kind)(kind);
}

/** Visible width of a coloured kind label, for column padding. */
export function kindPadding(kind: string, width: number): string {
  const painted = colorKind(kind);
  const visible = kind.length === 0 ? '(no kind)'.length : kind.length;
  return painted + ' '.repeat(Math.max(0, width - visible));
}
