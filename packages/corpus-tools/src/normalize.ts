/**
 * Reproducible normalizers for corpus reconciliation.
 *
 * Every signal used to justify a `mapped` / `renamed` verdict must be derivable
 * from these functions alone, so a third party can re-run the reconciliation and
 * get byte-identical verdicts. Nothing here may consult a hand-written mapping
 * table — that is the whole point of the exercise.
 */

import { createHash } from "node:crypto";

/**
 * Build the kind-prefix vocabulary from the corpus itself: every `kind` value
 * that actually occurs in the units being reconciled. Longest-first, so a
 * compound kind wins over a kind that is a suffix of it (`anti-pattern` before
 * `pattern`) — otherwise the shorter one would strip first and leave `anti-`.
 *
 * There is deliberately NO built-in list. An engine-side list of kind names
 * would be a copy of vocabulary the model owns (ZDS-CORE-CLOSED-SETS), and it
 * would also go stale silently: the first run of this reconciler mis-tiered
 * `principle-*` precisely because a hardcoded list was consulted instead of the
 * corpus. Callers pass the kinds they loaded; an empty vocabulary strips
 * nothing, which is the correct behaviour for a corpus that declares no kinds.
 */
export function kindVocabulary(kinds: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const k of kinds) {
    const c = canonSlug(k);
    if (c) set.add(c);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * Structural filler tokens. Dropped only for token-SET comparison, never for
 * the exact-slug tier. Negations (`no`, `not`, `never`, `only`, `without`) are
 * deliberately NOT in this list: dropping them would equate a rule with its
 * inverse.
 */
const FILLER = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "in",
  "on",
  "at",
  "to",
  "and",
  "or",
  "is",
  "are",
  "be",
  "with",
  "by",
  "vs",
  "via",
  "using",
  "use",
]);

/** `@community/check-contrast-aa` -> `community` */
export function namespaceOf(id: string): string {
  const m = /^@([^/]+)\//.exec(id);
  return m ? m[1] : "";
}

/** `@community/check-contrast-aa` -> `check-contrast-aa` */
export function slugOf(id: string): string {
  const i = id.indexOf("/");
  return i === -1 ? id.replace(/^@/, "") : id.slice(i + 1);
}

/**
 * Strip a leading kind prefix. `check-contrast-aa` -> `contrast-aa`.
 * Longest prefix wins so `anti-pattern-x` is not read as `pattern`-less.
 * Returns the slug unchanged when no prefix matches.
 */
export function stripKindPrefix(slug: string, vocab: readonly string[]): string {
  let best = "";
  for (const k of vocab) {
    if (slug.startsWith(k + "-") && k.length > best.length) best = k;
  }
  return best ? slug.slice(best.length + 1) : slug;
}

/** Lowercase, collapse every non-alphanumeric run to a single `-`. */
export function canonSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Crude singularisation, applied only to tokens longer than 3 chars. */
function stem(tok: string): string {
  if (tok.length > 3 && tok.endsWith("ies")) return tok.slice(0, -3) + "y";
  if (tok.length > 3 && tok.endsWith("es")) return tok.slice(0, -2);
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1);
  return tok;
}

/** Sorted, de-duplicated, filler-free, stemmed token set of a slug. */
export function tokenSet(slug: string): string[] {
  const toks = canonSlug(slug)
    .split("-")
    .filter((t) => t.length > 0 && !FILLER.has(t))
    .map(stem);
  return [...new Set(toks)].sort();
}

export function tokenSetKey(slug: string): string {
  return tokenSet(slug).join("+");
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bs = new Set(b);
  let inter = 0;
  for (const t of a) if (bs.has(t)) inter += 1;
  return inter / (a.length + b.length - inter);
}

/**
 * Normalise free prose (a title, a claim, a statement) to a comparable form:
 * lowercase, strip markdown emphasis and code fences, unify unicode dashes and
 * quotes, drop all punctuation, collapse whitespace.
 */
export function canonText(input: string): string {
  return input
    .replace(/`+/g, " ")
    .replace(/[*_~]+/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Digest of normalised prose. Empty / near-empty input yields "" (never matches). */
export function textDigest(input: string | undefined | null, minWords = 4): string {
  if (!input) return "";
  const c = canonText(String(input));
  if (c.length === 0) return "";
  if (c.split(" ").length < minWords) return "";
  return "t:" + createHash("sha256").update(c).digest("hex").slice(0, 16);
}

/**
 * Provenance key: a repo+file(+section) triple identifies the exact upstream
 * excerpt an atom was extracted from. Two atoms sharing it are the same excerpt
 * regardless of id or title.
 */
export function provenanceKey(
  repo?: string | null,
  file?: string | null,
  section?: string | null
): string {
  const r = canonText(String(repo ?? ""));
  const f = canonText(String(file ?? ""));
  if (!r && !f) return "";
  const s = canonText(String(section ?? ""));
  return `p:${r}|${f}|${s}`;
}

/** URL key: host+path, protocol/query/fragment/trailing-slash insensitive. */
export function urlKey(url?: string | null): string {
  if (!url) return "";
  const m = /^[a-z]+:\/\/([^?#]+)/i.exec(String(url).trim());
  if (!m) return "";
  const hostPath = m[1].replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
  if (!hostPath.includes("/")) return ""; // bare host is not identifying
  return "u:" + hostPath;
}
