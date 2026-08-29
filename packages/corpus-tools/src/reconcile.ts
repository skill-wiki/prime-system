/**
 * Three-way corpus reconciliation.
 *
 * Sides:
 *   legacy    `primes/{atoms,modules}/**.md`          — YAML-frontmatter source
 *   migrated  `packages/compiler/fixtures/migrated/*.prime` — derived fixture
 *   bundle    `primes-v3/sources` .prime files + `compiled-v3-final` atom.yaml files
 *
 * Verdicts are assigned from ordered evidence tiers. A unit is only `mapped`
 * when a tier fires; absence of evidence is reported as `unmapped`, never
 * smoothed over. Every verdict carries the tier that produced it plus the
 * concrete key that matched, so it is checkable by hand.
 */

import {
  canonSlug,
  kindVocabulary,
  jaccard,
  provenanceKey,
  slugOf,
  stripKindPrefix,
  textDigest,
  tokenSet,
  tokenSetKey,
  urlKey,
} from "./normalize.ts";
import type { LegacyUnit, MigratedUnit, V3Unit } from "./load.ts";

export type Verdict = "mapped" | "renamed" | "merged" | "split" | "deprecated" | "unmapped";

/**
 * Evidence tiers, strongest first. `slug-exact` is the only tier that yields a
 * bare `mapped`; every weaker tier yields `renamed`, because a weaker tier
 * matching means the identifier itself changed.
 */
export const TIERS = [
  "slug-exact",
  "slug-kindstripped-exact",
  "slug-tokenset",
  "prose-digest",
  "provenance-repo-file",
  "slug-jaccard-0.80",
] as const;
export type Tier = (typeof TIERS)[number];

/**
 * `provenance-url` was a tier on the first run and produced the largest edge
 * count (131) — and it was wrong. A legacy atom carrying
 * `source.repo = github.com/typecellos/blocknote` matched three unrelated v3
 * units that merely cite the same repo, manufacturing bogus `split` verdicts.
 * A repo URL identifies an upstream project, not an excerpt, so it is recorded
 * as a non-binding hint and never produces a verdict.
 */
export interface WeakHint {
  legacyId: string;
  v3Ids: string[];
  signal: "same-upstream-repo-url";
  key: string;
}

const MAPPED_TIERS = new Set<Tier>(["slug-exact", "slug-kindstripped-exact"]);

export interface Edge {
  legacyId: string;
  v3Id: string;
  tier: Tier;
  key: string;
}

export interface LegacyRow {
  id: string;
  ns: string;
  tree: "atoms" | "modules";
  subtype?: string;
  domain?: string;
  status?: string;
  license?: string;
  verdict: Verdict;
  basis: string;
  matches: { v3Id: string; tier: Tier; key: string }[];
}

export interface V3Row {
  id: string;
  ns: string;
  kind: string;
  domain?: string;
  verdict: Verdict;
  basis: string;
  matches: { legacyId: string; tier: Tier; key: string }[];
}

export interface MigratedRow {
  name: string;
  base: string;
  verdict: "mapped" | "unmapped";
  basis: string;
  legacyId?: string;
}

function pushIndex<T>(m: Map<string, T[]>, k: string, v: T): void {
  if (!k) return;
  const cur = m.get(k);
  if (cur) cur.push(v);
  else m.set(k, [v]);
}

/** All prose digests worth comparing for one unit, strongest field first. */
function legacyDigests(u: LegacyUnit): string[] {
  // The named fields are the reconciler's own model and stay in priority order;
  // everything else the document carried follows in sorted-key order. No corpus
  // field name appears here — see `collectProse` in load.ts for why.
  const open = Object.keys(u.prose)
    .sort()
    .map((k) => u.prose[k]!);
  return [u.claim, u.name, u.description, u.rationale, ...open]
    .map((t) => textDigest(t))
    .filter((d) => d !== "");
}

function v3Digests(u: V3Unit): string[] {
  return [u.statement, u.claim, u.label, u.description, u.rationale]
    .map((t) => textDigest(t))
    .filter((d) => d !== "");
}

/** Excerpt-identity keys only: repo + file (+ section). Never a bare repo URL. */
function legacyProvKeys(u: LegacyUnit): string[] {
  const keys = [provenanceKey(u.sourceRepo, u.sourceFile, u.sourceSection)];
  // section-insensitive fallback: v3 rarely carries a section
  keys.push(provenanceKey(u.sourceRepo, u.sourceFile, ""));
  for (const p of u.extraProvenance) {
    const [repo, file] = p.split("|");
    if (file) keys.push(provenanceKey(repo, file, ""));
  }
  return [...new Set(keys.filter((k) => k !== ""))];
}

/** Non-binding: shared upstream project, not shared excerpt. */
function legacyWeakKeys(u: LegacyUnit): string[] {
  return [...new Set([urlKey(u.sourceUrl), urlKey(u.sourceRepo)].filter((k) => k !== ""))];
}

function v3ProvKeys(u: V3Unit): string[] {
  const keys = [
    provenanceKey(u.sourceRepo, u.sourceFile, u.sourceSection),
    provenanceKey(u.sourceRepo, u.sourceFile, ""),
  ];
  return [...new Set(keys.filter((k) => k !== ""))];
}

function v3WeakKeys(u: V3Unit): string[] {
  return [...new Set(u.urls.map(urlKey).filter((k) => k !== ""))];
}

export interface ReconcileResult {
  legacy: LegacyRow[];
  v3: V3Row[];
  migrated: MigratedRow[];
  edges: Edge[];
  weakHints: WeakHint[];
  migratedCoverage: {
    legacyTotal: number;
    migratedTotal: number;
    matchedPairs: number;
    legacyWithoutMigrated: string[];
    migratedWithoutLegacy: string[];
    nameCollisions: { key: string; legacyIds: string[] }[];
  };
}

export function reconcile(
  legacy: LegacyUnit[],
  migrated: MigratedUnit[],
  v3: V3Unit[]
): ReconcileResult {
  // ---- build v3 indices -------------------------------------------------
  const vocab = kindVocabulary(v3.map((u) => u.kind));
  const byV3Slug = new Map<string, V3Unit[]>();
  const byV3Stripped = new Map<string, V3Unit[]>();
  const byV3Tokens = new Map<string, V3Unit[]>();
  const byV3Digest = new Map<string, V3Unit[]>();
  const byV3Prov = new Map<string, V3Unit[]>();
  const byV3Weak = new Map<string, V3Unit[]>();
  const v3Tokens = new Map<string, string[]>();

  for (const u of v3) {
    const slug = canonSlug(u.slug);
    // strip the unit's own declared kind first, then fall back to the vocabulary
    const ownStripped = u.kind ? stripKindPrefix(slug, [canonSlug(u.kind)]) : slug;
    const stripped = canonSlug(stripKindPrefix(ownStripped, vocab));
    pushIndex(byV3Slug, slug, u);
    pushIndex(byV3Stripped, stripped, u);
    if (ownStripped !== stripped) pushIndex(byV3Stripped, canonSlug(ownStripped), u);
    const toks = tokenSet(stripped);
    v3Tokens.set(u.id, toks);
    pushIndex(byV3Tokens, toks.join("+"), u);
    for (const d of v3Digests(u)) pushIndex(byV3Digest, d, u);
    for (const p of v3ProvKeys(u)) pushIndex(byV3Prov, p, u);
    for (const p of v3WeakKeys(u)) pushIndex(byV3Weak, p, u);
  }

  // ---- match legacy -> v3 ----------------------------------------------
  const edges: Edge[] = [];
  const weakHints: WeakHint[] = [];
  const seen = new Set<string>();
  const addEdge = (legacyId: string, u: V3Unit, tier: Tier, key: string): void => {
    const k = `${legacyId}\u0000${u.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ legacyId, v3Id: u.id, tier, key });
  };

  for (const l of legacy) {
    const slug = canonSlug(l.slug);
    const toks = tokenSet(slug);
    let fired = false;

    for (const u of byV3Slug.get(slug) ?? []) {
      addEdge(l.id, u, "slug-exact", slug);
      fired = true;
    }
    if (!fired) {
      for (const u of byV3Stripped.get(slug) ?? []) {
        addEdge(l.id, u, "slug-kindstripped-exact", slug);
        fired = true;
      }
    }
    if (!fired) {
      for (const u of byV3Tokens.get(toks.join("+")) ?? []) {
        addEdge(l.id, u, "slug-tokenset", toks.join("+"));
        fired = true;
      }
    }
    if (!fired) {
      for (const d of legacyDigests(l)) {
        for (const u of byV3Digest.get(d) ?? []) {
          addEdge(l.id, u, "prose-digest", d);
          fired = true;
        }
        if (fired) break;
      }
    }
    if (!fired) {
      for (const p of legacyProvKeys(l)) {
        const hits = byV3Prov.get(p) ?? [];
        // A provenance key shared by a huge number of v3 units is a repo-level
        // key, not an excerpt identity — it proves nothing about this unit.
        if (hits.length === 0 || hits.length > 3) continue;
        for (const u of hits) addEdge(l.id, u, "provenance-repo-file", p);
        fired = true;
        break;
      }
    }
    if (!fired) {
      // record, but do not act on, shared-upstream-repo overlap
      for (const p of legacyWeakKeys(l)) {
        const hits = byV3Weak.get(p) ?? [];
        if (hits.length === 0) continue;
        weakHints.push({
          legacyId: l.id,
          v3Ids: hits.map((u) => u.id),
          signal: "same-upstream-repo-url",
          key: p,
        });
        break;
      }
    }
    if (!fired && toks.length >= 3) {
      // Last resort: fuzzy token overlap, restricted to same-namespace-or-@community
      // candidates that share at least one rare token, to keep this O(n) in practice.
      let best: { u: V3Unit; s: number } | null = null;
      for (const u of v3) {
        const s = jaccard(toks, v3Tokens.get(u.id) ?? []);
        if (s >= 0.8 && (!best || s > best.s)) best = { u, s };
      }
      if (best) addEdge(l.id, best.u, "slug-jaccard-0.80", `j=${best.s.toFixed(3)}`);
    }
  }

  // ---- fan-in / fan-out -------------------------------------------------
  const byLegacy = new Map<string, Edge[]>();
  const byV3 = new Map<string, Edge[]>();
  for (const e of edges) {
    pushIndex(byLegacy, e.legacyId, e);
    pushIndex(byV3, e.v3Id, e);
  }

  const tierRank = (t: Tier): number => TIERS.indexOf(t);
  const strongest = (es: Edge[]): Edge =>
    es.reduce((a, b) => (tierRank(b.tier) < tierRank(a.tier) ? b : a));

  // ---- legacy verdicts --------------------------------------------------
  const legacyRows: LegacyRow[] = legacy.map((l) => {
    const es = byLegacy.get(l.id) ?? [];
    const matches = es.map((e) => ({ v3Id: e.v3Id, tier: e.tier, key: e.key }));
    const archived =
      l.status === "archived" ||
      l.status === "deprecated" ||
      (l.deprecatedAt !== null && l.deprecatedAt !== undefined);

    if (es.length === 0) {
      if (l.supersededBy) {
        return {
          ...base(l),
          verdict: "deprecated" as Verdict,
          basis: `lifecycle.superseded_by=${l.supersededBy}; no v3 evidence`,
          matches,
        };
      }
      if (archived) {
        return {
          ...base(l),
          verdict: "deprecated" as Verdict,
          basis: `status=${l.status ?? "?"}${l.deprecatedAt ? ` deprecated_at=${l.deprecatedAt}` : ""}; no v3 evidence`,
          matches,
        };
      }
      return {
        ...base(l),
        verdict: "unmapped" as Verdict,
        basis: "no tier fired: no slug, token-set, prose-digest, provenance or 0.80-jaccard evidence",
        matches,
      };
    }

    if (es.length > 1) {
      const s = strongest(es);
      return {
        ...base(l),
        verdict: "split" as Verdict,
        basis: `1 legacy -> ${es.length} v3 via ${[...new Set(es.map((e) => e.tier))].join(",")} (strongest ${s.tier})`,
        matches,
      };
    }

    const e = es[0];
    const fanIn = byV3.get(e.v3Id) ?? [];
    if (fanIn.length > 1) {
      return {
        ...base(l),
        verdict: "merged" as Verdict,
        basis: `${fanIn.length} legacy -> 1 v3 (${e.v3Id}) via ${e.tier}; siblings ${fanIn
          .filter((x) => x.legacyId !== l.id)
          .map((x) => x.legacyId)
          .join(",")}`,
        matches,
      };
    }
    return {
      ...base(l),
      verdict: MAPPED_TIERS.has(e.tier) ? ("mapped" as Verdict) : ("renamed" as Verdict),
      basis: `${e.tier} key=${e.key}`,
      matches,
    };
  });

  // ---- v3 verdicts ------------------------------------------------------
  const v3Rows: V3Row[] = v3.map((u) => {
    const es = byV3.get(u.id) ?? [];
    const matches = es.map((e) => ({ legacyId: e.legacyId, tier: e.tier, key: e.key }));
    if (es.length === 0) {
      return {
        id: u.id,
        ns: u.ns,
        kind: u.kind,
        domain: u.domain,
        verdict: "unmapped" as Verdict,
        basis: "v3-only: no legacy unit matched under any tier",
        matches,
      };
    }
    if (es.length > 1) {
      const s = strongest(es);
      return {
        id: u.id,
        ns: u.ns,
        kind: u.kind,
        domain: u.domain,
        verdict: "merged" as Verdict,
        basis: `${es.length} legacy -> this unit (strongest ${s.tier})`,
        matches,
      };
    }
    const e = es[0];
    const fanOut = byLegacy.get(e.legacyId) ?? [];
    if (fanOut.length > 1) {
      return {
        id: u.id,
        ns: u.ns,
        kind: u.kind,
        domain: u.domain,
        verdict: "split" as Verdict,
        basis: `legacy ${e.legacyId} -> ${fanOut.length} v3 units via ${e.tier}`,
        matches,
      };
    }
    return {
      id: u.id,
      ns: u.ns,
      kind: u.kind,
      domain: u.domain,
      verdict: MAPPED_TIERS.has(e.tier) ? ("mapped" as Verdict) : ("renamed" as Verdict),
      basis: `${e.tier} key=${e.key}`,
      matches,
    };
  });

  // ---- migrated <-> legacy (proves the fixture is a derivation, not a stage)
  const legacyByToken = new Map<string, LegacyUnit[]>();
  for (const l of legacy) {
    pushIndex(legacyByToken, tokenSetKey(l.slug), l);
    // the generator prefixes module atoms with the lowercased module id
    if (l.module) pushIndex(legacyByToken, tokenSetKey(`${l.module}-${l.slug}`), l);
  }
  const collisions = new Map<string, string[]>();
  // The generator truncates long names and appends `--<7 hex>`; index legacy
  // slugs by canonical-prefix so those still resolve instead of being called
  // unmapped, which would overstate the fixture's drift.
  const legacyCanon = legacy.map((l) => ({
    u: l,
    canon: canonSlug(l.slug),
    canonMod: l.module ? canonSlug(`${l.module}-${l.slug}`) : "",
  }));
  const migratedRows: MigratedRow[] = migrated.map((m) => {
    const key = tokenSetKey(m.name);
    let hits = legacyByToken.get(key) ?? [];
    if (hits.length === 0) {
      // NB: run the regex on the raw name — canonSlug collapses `--` to `-`.
      const trunc = /^(.*?)-*-[0-9a-f]{7}$/.exec(m.name);
      if (trunc) {
        const stem2 = canonSlug(trunc[1]);
        const pre = legacyCanon.filter(
          (c) => c.canon.startsWith(stem2) || (c.canonMod !== "" && c.canonMod.startsWith(stem2))
        );
        if (pre.length > 0) {
          return {
            name: m.name,
            base: m.base,
            verdict: "mapped" as const,
            basis: `generator truncated+hashed name; canonical prefix "${stem2}" matches ${pre.length} legacy slug(s)`,
            legacyId: pre[0].u.id,
          };
        }
      }
    }
    if (hits.length === 1) {
      return {
        name: m.name,
        base: m.base,
        verdict: "mapped" as const,
        basis: `token-set of migrated name == token-set of legacy slug (key=${key})`,
        legacyId: hits[0].id,
      };
    }
    if (hits.length > 1) {
      collisions.set(
        key,
        hits.map((h) => h.id)
      );
      return {
        name: m.name,
        base: m.base,
        verdict: "mapped" as const,
        basis: `token-set matched ${hits.length} legacy slugs (leaf-name collision across modules), key=${key}`,
        legacyId: hits[0].id,
      };
    }
    return {
      name: m.name,
      base: m.base,
      verdict: "unmapped" as const,
      basis: `no legacy slug shares this token set (key=${key})`,
    };
  });

  const matchedLegacyIds = new Set(migratedRows.map((r) => r.legacyId).filter(Boolean) as string[]);

  return {
    legacy: legacyRows,
    v3: v3Rows,
    migrated: migratedRows,
    edges,
    weakHints,
    migratedCoverage: {
      legacyTotal: legacy.length,
      migratedTotal: migrated.length,
      matchedPairs: migratedRows.filter((r) => r.verdict === "mapped").length,
      legacyWithoutMigrated: legacy.filter((l) => !matchedLegacyIds.has(l.id)).map((l) => l.id),
      migratedWithoutLegacy: migratedRows
        .filter((r) => r.verdict === "unmapped")
        .map((r) => r.name),
      nameCollisions: [...collisions.entries()].map(([key, legacyIds]) => ({ key, legacyIds })),
    },
  };

  function base(l: LegacyUnit): Omit<LegacyRow, "verdict" | "basis" | "matches"> {
    return {
      id: l.id,
      ns: l.ns,
      tree: l.tree,
      subtype: l.subtype,
      domain: l.domain,
      status: l.status,
      license: l.license,
    };
  }
}

export function tally<T extends { verdict: string }>(rows: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.verdict] = (out[r.verdict] ?? 0) + 1;
  return out;
}
