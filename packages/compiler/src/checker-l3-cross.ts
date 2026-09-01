/**
 * @module checker-l3-cross
 * Level 3 — cross-atom consistency checks across a full corpus.
 *
 * This is the "global" layer the per-atom L1/L2 passes can't see. It takes
 * an array of parsed .prime ASTs and finds issues that only make sense at
 * the graph/set level:
 *
 *   C1  Duplicate name     — two primes declare the same `name` field
 *   C2  Dead reference     — a `requires` / `validates_with` / `enhances` link
 *                            target is not in the corpus
 *   C3  Tag-Jaccard near-duplicate pairs — candidates for dedup review
 *                            (J ≥ 0.85 over tag sets of size ≥ 3)
 *   C4  Orphan (info only) — an atom is neither required, enhanced, nor
 *                            validated by any other atom; may be a root.
 *
 * All checks are deterministic — zero LLM, zero network. The C3 threshold
 * is conservative to avoid false positives; tune via options.
 */

import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  ArrayNode,
  StringNode,
  LinkShorthandNode,
  ObjectNode,
  ValueNode,
} from "@aoe/types";
import type { Diagnostic } from "./types";
import { defaultRelationIndex, type RelationIndex } from "./relation-semantics";

type AnyAST = PrimeAST | AtomDeclaration;

export interface L3CrossOptions {
  /** Minimum tag-Jaccard similarity for C3 pair reports. Default 0.85. */
  jaccardThreshold?: number;
  /** Minimum tag-set size for C3 eligibility. Default 3. */
  minTagsForDupCheck?: number;
  /** Maximum pairs to report per sweep (for large corpora). Default 200. */
  maxDuplicatePairs?: number;
  /**
   * Minimum description word-Jaccard to corroborate a tag match. Tag-only
   * similarity produces many false positives where two atoms share topic
   * tags (e.g. [a11y, keyboard, navigation]) but cover unrelated concerns
   * (e.g. skip-link vs accesskeys). Default 0.3.
   */
  descriptionOverlapThreshold?: number;
  /**
   * C4 only fires when at least this fraction of the corpus has any outgoing
   * link — otherwise it's almost certainly an un-linked migration corpus and
   * every atom looks like an orphan. Default 0.05 (5%).
   */
  c4MinLinkDensity?: number;
  /**
   * Tags that mark an atom as an intentional root node — C4 skips them.
   * Scout catalogs, design references, and other one-off lookup atoms are
   * legitimately isolated: they're unique external pointers, not network
   * citizens. Default includes: scout-catalog, design-ref, reference-gallery.
   */
  rootNodeTags?: string[];
}

export interface L3CrossFinding extends Diagnostic {
  /** Primary atom name the finding is attached to. */
  atom: string;
  /** Code matching the rule family (C1..C4). */
  code: "C1" | "C2" | "C3" | "C4";
  /** For C3, the paired atom's name. */
  peer?: string;
  /** Optional numeric signal (Jaccard, etc). */
  score?: number;
}

function fieldAsString(ast: AnyAST, key: string): string | undefined {
  const f = ast.body.find((x) => x.key === key);
  if (!f) return undefined;
  if (f.value.type !== "String") return undefined;
  return (f.value as StringNode).value;
}

function arrayItems(ast: AnyAST, key: string): ValueNode[] {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items;
}

function extractTagSet(ast: AnyAST): Set<string> {
  const set = new Set<string>();
  for (const v of arrayItems(ast, "tags")) {
    if (v.type === "String") set.add((v as StringNode).value.toLowerCase());
  }
  return set;
}

/**
 * Collect link edges (requires / enhances / validates_with / supplies_to /
 * contradicts / specializes) from the AST.
 *
 * Only TOP-LEVEL fields named after a link verb count. Nested fields with
 * the same name inside arbitrary structures (e.g. a taxonomy item whose
 * `requires` field carries natural-language prose) are NOT links — treating
 * them as such creates spurious "dead reference" reports.
 *
 * LinkShorthand nodes appearing anywhere still count because the parser
 * only emits them in link-declaration contexts (e.g. `links: [...]`).
 *
 * Which field keys name a link is `relations.keys` — every canonical relation
 * name the model declares plus its declared `aliases`. The hand-written
 * `LINK_VERBS` set this replaces listed six of them, so `related`, `includes`,
 * `see-also`, `conflicts`, `compatible`, `derived-from`, `relationships` and
 * `extends` edges were invisible to C2 and C4: a dead `includes` target was not
 * reported, and an atom reachable only by `related` still counted as an orphan.
 */
function extractLinkTargets(
  ast: AnyAST,
  relations: RelationIndex
): Array<{ verb: string; target: string }> {
  const out: Array<{ verb: string; target: string }> = [];
  const isLinkVerb = (verb: string): boolean => relations.definition(verb) !== undefined;

  function push(verb: string, target: unknown): void {
    if (!isLinkVerb(verb)) return;
    if (typeof target !== "string" || target.length === 0) return;
    out.push({ verb, target });
  }

  // Top-level fields only.
  for (const field of ast.body) {
    if (isLinkVerb(field.key)) {
      if (field.value.type === "String") {
        push(field.key, (field.value as StringNode).value);
      } else if (field.value.type === "Array") {
        for (const item of (field.value as ArrayNode).items) {
          if (item.type === "String") push(field.key, (item as StringNode).value);
          else if (item.type === "LinkShorthand") {
            const l = item as LinkShorthandNode;
            push(l.verb, l.target);
          }
        }
      }
      continue;
    }
    // LinkShorthand nodes anywhere in the body still count — the parser
    // only emits them in link declaration contexts.
    if (field.value.type === "Array") {
      for (const item of (field.value as ArrayNode).items) {
        if (item.type === "LinkShorthand") {
          const l = item as LinkShorthandNode;
          push(l.verb, l.target);
        }
      }
    }
  }

  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function mk(
  atom: string,
  level: Diagnostic["level"],
  code: L3CrossFinding["code"],
  message: string,
  suggestion?: string,
  extras: Partial<L3CrossFinding> = {}
): L3CrossFinding {
  return {
    level,
    line: 0,
    message,
    suggestion,
    source: `L3:cross:${code}`,
    atom,
    code,
    ...extras,
  };
}

/**
 * Run every cross-atom check over an indexed corpus.
 *
 * Duration is linear in the corpus for C1/C2/C4, O(n²) for C3 (tag-Jaccard
 * over all pairs). On the 2873-atom test corpus a full sweep completes in
 * under 2s on modern hardware; for larger corpora raise minTagsForDupCheck
 * or cap maxDuplicatePairs.
 */
/** Tokenize a free-form description into a lowercase word set, ignoring stop words. */
function descWordSet(s: string | undefined): Set<string> {
  if (!s) return new Set();
  const STOP = new Set([
    "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "is", "are",
    "be", "by", "with", "from", "at", "as", "it", "this", "that", "must",
    "should", "when", "if",
    // NOT stopping "not"/"but"/"no" — these are polarity markers that
    // distinguish pattern atoms from their anti-pattern siblings. Treating
    // them as stop words made "do X" and "don't X" look identical to the
    // dedup heuristic.
  ]);
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  );
}

export function checkL3Cross(
  asts: AnyAST[],
  options: L3CrossOptions = {},
  relations: RelationIndex = defaultRelationIndex()
): L3CrossFinding[] {
  const jaccardThreshold = options.jaccardThreshold ?? 0.85;
  const minTagsForDupCheck = options.minTagsForDupCheck ?? 3;
  const maxDuplicatePairs = options.maxDuplicatePairs ?? 200;
  const descriptionOverlapThreshold = options.descriptionOverlapThreshold ?? 0.3;
  const c4MinLinkDensity = options.c4MinLinkDensity ?? 0.05;
  const rootNodeTags = new Set(
    (options.rootNodeTags ?? [
      "scout-catalog",
      "design-ref",
      "reference-gallery",
      "template-excerpt",
      "index",
    ]).map((t) => t.toLowerCase())
  );

  const findings: L3CrossFinding[] = [];

  // Build name → ast and id → ast indexes. Atoms reference each other via
  // full id (`@scope/kind-slug`) more often than by short `name` field, so
  // dead-ref detection must check both lookups before flagging.
  const byName = new Map<string, AnyAST[]>();
  const byId = new Map<string, AnyAST>();
  for (const ast of asts) {
    const name = fieldAsString(ast, "name") ?? ast.name;
    if (name) {
      const list = byName.get(name) ?? [];
      list.push(ast);
      byName.set(name, list);
    }
    const id = fieldAsString(ast, "id");
    if (id) byId.set(id, ast);
  }

  // C1: Duplicate names. Same-kind same-name is an error (clear ambiguity).
  // Cross-kind same-name is a *suggestion* — e.g. fact-X and pattern-X
  // describing the same concept at different layers is legitimate, but
  // distinguishing names makes graph traversal less surprising.
  for (const [name, group] of byName) {
    if (group.length <= 1) continue;
    const kinds = new Set(
      group.map((a) => fieldAsString(a, "kind") ?? (a as any).kind ?? "?"),
    );
    if (kinds.size === 1) {
      findings.push(
        mk(name, "error", "C1", `${group.length} primes declare name "${name}" with same kind — names must be globally unique within kind`,
          `rename one or mark deprecated; collapsing to one canonical prime is preferred`)
      );
    } else {
      findings.push(
        mk(name, "suggestion", "C1", `${group.length} primes share name "${name}" across kinds [${[...kinds].join(", ")}] — consider distinguishing names`,
          `e.g. SkeletonLoader (pattern) → SkeletonLoaderPattern; SkeletonLoader (template) → SkeletonLoaderTemplate`)
      );
    }
  }

  // Incoming-edge counter for C4 and outgoing counter for C4 density gate
  const incomingCount = new Map<string, number>();
  let atomsWithOutgoing = 0;
  for (const ast of asts) {
    const name = fieldAsString(ast, "name") ?? ast.name;
    if (!name) continue;
    const links = extractLinkTargets(ast, relations);
    if (links.length > 0) atomsWithOutgoing++;
    for (const { verb, target } of links) {
      // Targets can be either short names (legacy AST `name` field) or
      // full atom ids (`@scope/kind-slug`). Check both indexes before
      // declaring a dead reference.
      const found = byName.has(target) || byId.has(target);
      if (!found) {
        findings.push(
          mk(
            name,
            "error",
            "C2",
            `${verb} → "${target}" — target prime not in corpus`,
            `either add the missing prime, or remove/rename the reference`,
            { peer: target }
          )
        );
      } else if (!relations.excludes(verb)) {
        // An incoming edge only counts as "someone endorses this atom" when the
        // relation is not an exclusion: being contradicted is not being cited.
        // Reading `semantics.selection: exclude` instead of testing the single
        // spelling `contradicts` is why `conflicts` now behaves the same way.
        incomingCount.set(target, (incomingCount.get(target) ?? 0) + 1);
      }
    }
  }

  // C4: Orphans — only fire if the corpus actually has link data. A corpus
  // where <5% of atoms declare outgoing links is almost certainly a bulk
  // migration snapshot where every atom would flag, which is noise, not signal.
  const linkDensity = asts.length > 0 ? atomsWithOutgoing / asts.length : 0;
  if (linkDensity >= c4MinLinkDensity) {
    for (const ast of asts) {
      const name = fieldAsString(ast, "name") ?? ast.name;
      if (!name) continue;
      const hasOutgoing = extractLinkTargets(ast, relations).length > 0;
      const incoming = incomingCount.get(name) ?? 0;
      if (incoming !== 0 || hasOutgoing) continue;

      // 1. Explicit declaration: atoms that set `root: true` declare they're
      //    intentionally standalone (platform quirks, scout catalogs, lookup
      //    references, module-level philosophical principles). Honor it.
      const rootField = ast.body.find((f) => f.key === "root");
      if (rootField && rootField.value.type === "Boolean" && (rootField.value as { value: boolean }).value === true) {
        continue;
      }

      // 2. Tag-based allowlist: legacy convention for the same idea. Keep
      //    accepting it so existing corpora don't need a migration.
      const tags = extractTagSet(ast);
      const isRootNode = [...tags].some((t) => rootNodeTags.has(t));
      if (isRootNode) continue;

      findings.push(
        mk(name, "suggestion", "C4",
          `atom "${name}" has no graph connections (no references in or out) — may be a root, or may be unreachable`,
          `add at least one requires/validates_with/enhances link, OR declare \`root: true\` if this atom is intentionally standalone`)
      );
    }
  }

  // C3: Near-duplicate pairs — require BOTH tag-Jaccard AND description
  // word-Jaccard above threshold. Tag-only matching produced ~500 hits on
  // the test corpus where 80%+ were peer-topic atoms, not duplicates; adding
  // the description signal eliminates that class of false positive.
  //
  // Two more suppressions:
  //   - pairs sharing a `specializes` parent → known split siblings
  //   - pairs already directly linked by `enhances` or `specializes` in
  //     either direction → explicitly declared peers, not accidental dups
  type Eligible = {
    name: string;
    tags: Set<string>;
    words: Set<string>;
    parents: Set<string>;
    outgoing: Map<string, Set<string>>; // verb → targets
  };
  const eligible: Eligible[] = [];
  for (const ast of asts) {
    const name = fieldAsString(ast, "name") ?? ast.name;
    if (!name) continue;
    const tags = extractTagSet(ast);
    if (tags.size < minTagsForDupCheck) continue;
    const description = fieldAsString(ast, "description");
    const parents = new Set<string>();
    const outgoing = new Map<string, Set<string>>();
    for (const { verb, target } of extractLinkTargets(ast, relations)) {
      // "Shares a parent" needs to know which relations point at an ancestor.
      // `cardinality: many-to-one` on a directional relation IS that shape, and
      // it is declared; the previous test was the single spelling `specializes`,
      // which silently excluded `extends` and `derived-from`.
      if (relations.parentward(verb)) parents.add(target);
      const set = outgoing.get(verb) ?? new Set<string>();
      set.add(target);
      outgoing.set(verb, set);
    }
    eligible.push({ name, tags, words: descWordSet(description), parents, outgoing });
  }
  eligible.sort((a, b) => a.name.localeCompare(b.name));

  function sharesParent(a: Eligible, b: Eligible): boolean {
    if (a.parents.size === 0 || b.parents.size === 0) return false;
    for (const p of a.parents) if (b.parents.has(p)) return true;
    return false;
  }

  function alreadyLinked(a: Eligible, b: Eligible): boolean {
    // "Already peered" has to mean the declared relation ACCOUNTS for the
    // similarity, not merely that some edge exists. A relation that brings the
    // target into the selection (`closure`/`expand`) or points at an ancestor
    // (`many-to-one` + directional) does; a bare association does not — and
    // `related` is 88 of the 136 edges in the example corpora, so suppressing on
    // it would silence C3 wherever it matters most.
    //
    // On the v1 model this admits requires, enhances, extends, supplies-to,
    // includes, specializes and derived-from — a superset of the hardcoded
    // ["enhances", "specializes", "requires"] that contains no verb the model
    // does not declare as selection-bearing or parentward.
    const accountsFor = (verb: string): boolean =>
      relations.required(verb) || relations.expands(verb) || relations.parentward(verb);
    for (const [verb, targets] of a.outgoing) if (accountsFor(verb) && targets.has(b.name)) return true;
    for (const [verb, targets] of b.outgoing) if (accountsFor(verb) && targets.has(a.name)) return true;
    return false;
  }

  let pairsReported = 0;
  outer: for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const tagJ = jaccard(eligible[i].tags, eligible[j].tags);
      if (tagJ < jaccardThreshold) continue;
      const wordJ = jaccard(eligible[i].words, eligible[j].words);
      if (wordJ < descriptionOverlapThreshold) continue;
      if (sharesParent(eligible[i], eligible[j])) continue; // known sibling
      if (alreadyLinked(eligible[i], eligible[j])) continue; // explicitly peered
      findings.push(
        mk(
          eligible[i].name,
          "suggestion",
          "C3",
          `tag sim ${(tagJ * 100).toFixed(0)}% / description sim ${(wordJ * 100).toFixed(0)}% with "${eligible[j].name}" — dedup candidate`,
          `manually review; if truly duplicate, archive one and add derived_from`,
          { peer: eligible[j].name, score: tagJ }
        )
      );
      pairsReported++;
      if (pairsReported >= maxDuplicatePairs) break outer;
    }
  }

  return findings;
}
