/**
 * @module edge-resolver
 *
 * Source `.prime` files often reference other atoms by bare slug:
 *
 *   @example/widget-alpha {
 *     conflicts: ["beta", "gamma-variant"]
 *   }
 *
 * The compiler emits these targets verbatim, so the resulting graph is full
 * of dangling refs (84% of conflicts edges in the 2026-05 audit). This
 * module post-processes a compiled corpus and resolves bare slugs to full
 * atom ids by consulting an index built from all known atoms.
 *
 * Resolution strategy (in order):
 *   1. Target already contains "/" → assumed full id, kept as-is.
 *   2. Target matches a known atom's tail (e.g. "widget-beta") → expand.
 *   3. Source atom kind is known and target matches `<kind>-<slug>` for some
 *      atom → expand (preferred so a conflicts edge declared by one kind
 *      resolves to another atom of that same kind).
 *   4. Target matches a slug-only key uniquely → expand.
 *   5. Otherwise: leave dangling, record in unresolved list for caller to
 *      surface as a warning.
 */

import type { AtomMeta } from "./global-index-emitter.ts";

export interface SlugIndex {
  /** "widget-beta" → "@example/widget-beta" */
  byTail: Map<string, string>;
  /** "beta" + kind="widget" → "@example/widget-beta" */
  bySlugAndKind: Map<string, Map<string, string>>;
  /** "beta" → unique full id when only one atom has that slug-suffix */
  bySlugUnique: Map<string, string>;
  /** Slugs that map ambiguously to multiple full ids (skip auto-resolution). */
  ambiguous: Set<string>;
}

export function buildSlugIndex(metas: AtomMeta[]): SlugIndex {
  const byTail = new Map<string, string>();
  const bySlugAndKind = new Map<string, Map<string, string>>();
  const slugCounts = new Map<string, Set<string>>();

  for (const m of metas) {
    if (m.deprecated_at) continue;
    // m.id like "@example/widget-beta"
    const slash = m.id.lastIndexOf("/");
    const tail = slash >= 0 ? m.id.slice(slash + 1) : m.id; // widget-beta
    byTail.set(tail, m.id);

    // Split kind prefix (everything up to first dash) from slug
    const dashIdx = tail.indexOf("-");
    if (dashIdx <= 0) continue;
    const kind = tail.slice(0, dashIdx);
    const slug = tail.slice(dashIdx + 1);

    // bySlugAndKind: kind → slug → fullId
    let kindMap = bySlugAndKind.get(kind);
    if (!kindMap) {
      kindMap = new Map();
      bySlugAndKind.set(kind, kindMap);
    }
    if (!kindMap.has(slug)) kindMap.set(slug, m.id);

    // Track whether slug is unique across kinds
    let set = slugCounts.get(slug);
    if (!set) {
      set = new Set();
      slugCounts.set(slug, set);
    }
    set.add(m.id);
  }

  const bySlugUnique = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [slug, ids] of slugCounts) {
    if (ids.size === 1) bySlugUnique.set(slug, [...ids][0]);
    else ambiguous.add(slug);
  }

  return { byTail, bySlugAndKind, bySlugUnique, ambiguous };
}

/**
 * Resolve a single edge target. `sourceId` provides kind context so we can
 * prefer same-kind matches. Returns the original target unchanged when the
 * resolution cannot be made unambiguously.
 */
export function resolveEdgeTarget(
  target: string,
  sourceId: string,
  index: SlugIndex,
): { resolved: string; changed: boolean; reason?: string } {
  if (target.includes("/")) return { resolved: target, changed: false };
  if (target.startsWith("@")) return { resolved: target, changed: false };

  // Step 2: tail match (e.g. target = "widget-beta")
  const tailHit = index.byTail.get(target);
  if (tailHit) return { resolved: tailHit, changed: tailHit !== target, reason: "tail-match" };

  // Step 3: same-kind match — derive source kind from sourceId
  const sourceTail = sourceId.split("/").pop() ?? "";
  const sourceDash = sourceTail.indexOf("-");
  if (sourceDash > 0) {
    const sourceKind = sourceTail.slice(0, sourceDash);
    const kindMap = index.bySlugAndKind.get(sourceKind);
    if (kindMap?.has(target)) {
      return { resolved: kindMap.get(target)!, changed: true, reason: "same-kind" };
    }
  }

  // Step 4: unique slug match across all kinds
  if (index.bySlugUnique.has(target)) {
    return { resolved: index.bySlugUnique.get(target)!, changed: true, reason: "unique-slug" };
  }

  return { resolved: target, changed: false, reason: "unresolved" };
}

export interface ResolveStats {
  scanned: number;
  resolved: number;
  unresolved: Array<{ source: string; target: string; type: string }>;
  ambiguous: Array<{ source: string; target: string; candidates: string[] }>;
}

/**
 * Mutate every meta's `edges` array in place: replace bare-slug targets with
 * resolved full ids. Returns stats so the caller can warn or fail.
 *
 * NOTE: Only the in-memory `metas` array is updated. Per-atom yaml files on
 * disk are rewritten by `rewriteAtomYamlEdges` below so the next emit is
 * stable.
 */
export function resolveCorpusEdges(metas: AtomMeta[]): ResolveStats {
  const index = buildSlugIndex(metas);
  const stats: ResolveStats = { scanned: 0, resolved: 0, unresolved: [], ambiguous: [] };

  for (const m of metas) {
    if (!m.edges) continue;
    for (const e of m.edges) {
      stats.scanned++;
      const r = resolveEdgeTarget(e.target, m.id, index);
      if (r.changed) {
        e.target = r.resolved;
        stats.resolved++;
      } else if (r.reason === "unresolved") {
        // Record only when ambiguity is the cause (so callers can dedupe noise)
        if (index.ambiguous.has(e.target)) {
          const sourceKind = m.id.split("/").pop()?.split("-")[0] ?? "";
          const candidates: string[] = [];
          for (const [kind, slugMap] of index.bySlugAndKind) {
            if (slugMap.has(e.target)) candidates.push(`${kind}: ${slugMap.get(e.target)}`);
          }
          stats.ambiguous.push({ source: m.id, target: e.target, candidates });
        } else {
          stats.unresolved.push({ source: m.id, target: e.target, type: e.type });
        }
      }
    }
  }

  return stats;
}

/**
 * Rewrite the relations: section in every atom.yaml so the on-disk file
 * matches the in-memory resolution. Idempotent.
 *
 * Strategy: find lines `  - { type: <type>, target: "<bare>" }` and replace
 * the target string. Skip files that have no relations.
 */
export async function rewriteAtomYamlEdges(
  metas: AtomMeta[],
  compiledRoot: string,
): Promise<{ files_changed: number }> {
  const { readFile, writeFile } = await import("fs/promises");
  const { join } = await import("path");
  let changed = 0;

  for (const m of metas) {
    if (!m.edges || m.edges.length === 0) continue;
    const yamlPath = join(compiledRoot, m.id, "atom.yaml");
    let raw: string;
    try {
      raw = await readFile(yamlPath, "utf-8");
    } catch {
      continue;
    }
    let next = raw;
    for (const e of m.edges) {
      // Only rewrite if the resolved target actually differs from a bare slug
      // version. We construct the line shape produced by buildAtomYaml.
      // We can't know the original bare slug from `e` alone (already mutated
      // in resolveCorpusEdges), so instead grep all candidate bare slugs and
      // replace them with the canonical target. Two-step: find every
      // `target: "<bareSlug>"` line whose target is a known bare slug, swap.
      // Since we don't have the original here, this function relies on being
      // called BEFORE resolveCorpusEdges is run on disk. In practice it is
      // called from build-atom-dirs which writes yaml then resolves — so we
      // do the replace by building a regex from the resolved id's tail.
      const tail = e.target.split("/").pop();
      if (!tail || !e.target.includes("/")) continue;
      // Replace `target: "<tail>"` (without slash) with full id
      const re = new RegExp(`(target:\\s*)"${escapeRegex(tail)}"`, "g");
      next = next.replace(re, `$1${JSON.stringify(e.target)}`);
      // Also handle the slug-only case (e.g. "brutalist" with no kind prefix)
      const dashIdx = tail.indexOf("-");
      if (dashIdx > 0) {
        const slugOnly = tail.slice(dashIdx + 1);
        const re2 = new RegExp(`(target:\\s*)"${escapeRegex(slugOnly)}"`, "g");
        next = next.replace(re2, `$1${JSON.stringify(e.target)}`);
      }
    }
    if (next !== raw) {
      await writeFile(yamlPath, next, "utf-8");
      changed++;
    }
  }

  return { files_changed: changed };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
