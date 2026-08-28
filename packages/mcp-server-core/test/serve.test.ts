/**
 * The serve path, tested against a real compiled corpus and the real v1 model.
 *
 * The pre-cutover suite injected a fake `resolveProjection` and asserted on
 * `/fixture/...` strings. That could not survive the cutover and should not: the
 * new path validates every artifact path against the bundle root, so a fabricated
 * path is now correctly refused. These tests therefore run against
 * `examples/hello-world/primes/compiled`, which is the same corpus the behaviour
 * baseline in `docs/lanes/W6-B-SERVE-PATH.md` was frozen from.
 */
import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { loadCorpusSnapshot, loadAtomMeta, loadIndex } from "@skill-wiki/runtime";
import type { SnapshotRef as IrSnapshotRef } from "@skill-wiki/ir";
import type { Principal } from "@skill-wiki/query-engine";
import { buildCorpusGraph } from "../src/corpus-graph";
import { cheaperProjections, loadServeModel, resolveModelRoot } from "../src/model-context";
import { executePrimeQuery, resolvePrimeUri, type ServeOptions } from "../src/serve";
import { createPrimeQueryResponse } from "../src/query-response";

const CORPUS = resolve(join(import.meta.dir, "../../../examples/hello-world/primes/compiled"));

const PRINCIPAL: Principal = {
  id: "test",
  allowedVisibility: ["private", "shared", "public"],
  grantedPolicyLabels: [],
};

function serve(overrides: Partial<ServeOptions> = {}): ServeOptions {
  const index = loadIndex(CORPUS);
  const loaded = loadCorpusSnapshot(CORPUS, {});
  const model = loadServeModel(resolveModelRoot(CORPUS, {}));
  const snapshot: IrSnapshotRef = {
    modelRelease: model.model.manifest.version,
    modelDigest: loaded.snapshot.schemaDigest,
    corpusRelease: loaded.snapshot.release,
    corpusDigest: loaded.snapshot.contentDigest,
  };
  const corpus = buildCorpusGraph({
    atoms: index.atoms,
    loadMeta: (id) => loadAtomMeta(CORPUS, id),
    snapshot,
    corpus: loaded.snapshot.corpus,
  });
  return {
    model,
    corpus,
    bundleRoot: CORPUS,
    scope: {
      tenant: "local",
      workspace: "local",
      corpus: loaded.snapshot.corpus,
      release: loaded.snapshot.release,
      snapshot,
    },
    principal: PRINCIPAL,
    transport: "path",
    maxTokens: 8000,
    ...overrides,
  };
}

const TEA = "@example/method-make-tea";

describe("model resolution", () => {
  it("falls back to the v1 compatibility model and finds the declared policy there", () => {
    const resolution = resolveModelRoot(CORPUS, {});
    expect(resolution.origin).toBe("compatibility-default");
    const model = loadServeModel(resolution);
    // The retrieval profile is what makes the query planner usable at all; it is
    // model data, so the assertion is that it was read, not what it is called.
    expect(Object.keys(model.profiles).length).toBeGreaterThan(0);
    const profile = model.profiles[Object.keys(model.profiles)[0]!]!;
    expect(model.projections[profile.projection]).toBeDefined();
    expect(profile.candidateGenerators.length).toBeGreaterThan(0);
    expect(Object.keys(profile.features).length).toBeGreaterThan(0);
  });

  it("prefers an explicit root over the default", () => {
    expect(resolveModelRoot(CORPUS, {}, CORPUS).origin).toBe("explicit");
    expect(resolveModelRoot(CORPUS, { PRIME_MODEL_DIR: CORPUS }).origin).toBe("environment");
  });

  it("derives the degradation chain from declared targetTokens, not from level names", () => {
    const model = loadServeModel(resolveModelRoot(CORPUS, {}));
    const profile = model.profiles[Object.keys(model.profiles)[0]!]!;
    const chain = cheaperProjections(profile.projection, model.projections);
    const primary = model.projections[profile.projection]!.targetTokens;
    for (const ref of chain) {
      expect(model.projections[ref]!.targetTokens).toBeLessThan(primary);
    }
    // Descending cost: the most faithful affordable rendering is tried first.
    const costs = chain.map((ref) => model.projections[ref]!.targetTokens);
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
  });
});

describe("corpus adapter", () => {
  it("builds one unit per active index atom with model-resolvable relation names", () => {
    const options = serve();
    const index = loadIndex(CORPUS);
    expect(options.corpus.graph.units).toHaveLength(index.atoms.length);
    expect(options.corpus.graph.edges.length).toBeGreaterThan(0);
    for (const edge of options.corpus.graph.edges) {
      expect(options.model.relations[edge.relationRef]).toBeDefined();
    }
  });

  it("carries every unit type into a projection level the model declares", () => {
    const options = serve();
    for (const unit of options.corpus.graph.units) {
      const level = options.model.catalog
        .levels(options.model.profiles[Object.keys(options.model.profiles)[0]!]!.projection)
        .at(0);
      expect(level).toBeDefined();
      expect(options.corpus.artifacts.get(unit.identity.id)).toBeDefined();
    }
  });

  it("makes the artifact path bundle-relative so containment can actually be checked", () => {
    const options = serve();
    for (const [unitId, byLevel] of options.corpus.artifacts) {
      for (const path of Object.values(byLevel)) {
        expect(path.startsWith(`${unitId}/`)).toBe(true);
      }
    }
  });

  it("drops a dangling edge with a reported reason instead of silently", () => {
    const index = loadIndex(CORPUS);
    const built = buildCorpusGraph({
      atoms: index.atoms,
      loadMeta: (id) => {
        const meta = loadAtomMeta(CORPUS, id);
        return id === TEA
          ? { ...meta, relations: [...meta.relations, { type: "related", target: "@example/nope" }] }
          : meta;
      },
      snapshot: serve().scope.snapshot,
      corpus: "legacy",
    });
    const dangling = built.diagnostics.filter((d) => d.code === "CORPUS_EDGE_DANGLING");
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!.message).toContain("@example/nope");
    expect(built.graph.edges.some((edge) => edge.to === "@example/nope")).toBe(false);
  });
});

describe("preserved external semantics", () => {
  it("keeps the missing-id and unknown-id error text verbatim", () => {
    const options = serve();
    expect(executePrimeQuery({ scope: "show" }, options)).toEqual({ error: "scope=show requires `id`." });
    expect(executePrimeQuery({ scope: "related" }, options)).toEqual({ error: "scope=related requires `id`." });
    expect(executePrimeQuery({ scope: "show", id: "@nope/nope" }, options)).toEqual({
      error: "Atom not found: @nope/nope",
    });
    expect(executePrimeQuery({ scope: "related", id: "@nope/nope" }, options)).toEqual({
      error: "Atom not found: @nope/nope",
    });
  });

  it("keeps related traversal order, duplicate suppression, the relation prefix and limit", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "related", id: TEA, limit: 10 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    // The frozen baseline for this exact call.
    expect(outcome.results.map((r) => r.id)).toEqual([
      "@example/term-celsius",
      "@example/fact-water-boils-at-100c",
      "@example/rule-altitude-affects-boiling",
    ]);
    expect(outcome.results[0]!.description.startsWith("[related] ")).toBe(true);
    const limited = executePrimeQuery({ scope: "related", id: TEA, limit: 1 }, options);
    if ("error" in limited) throw new Error(limited.error);
    expect(limited.results).toHaveLength(1);
  });

  it("keeps the kind filter on related", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "related", id: TEA, kind: "term", limit: 10 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results.map((r) => r.kind)).toEqual(["term"]);
  });

  it("keeps enumeration order and limit when no query and no seeds are given", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "atoms", limit: 3 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results.map((r) => r.id)).toEqual([
      TEA,
      "@example/collection-tea-basics",
      "@example/fact-water-boils-at-100c",
    ]);
  });

  it("keeps the kind filter on enumeration, and reports what it excluded", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "atoms", kind: "fact", limit: 10 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results.map((r) => r.kind)).toEqual(["fact"]);
    expect(outcome.diagnostics.some((d) => d.code === "ENUMERATION_UNIT_FILTERED")).toBe(true);
  });

  it("still honours a caller-requested projection level", () => {
    const options = serve();
    const model = options.model;
    const cheapest = Object.values(model.projections).sort((a, b) => a.targetTokens - b.targetTokens)[0]!;
    const outcome = executePrimeQuery({ scope: "show", id: TEA, level: cheapest.name }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results[0]!.level).toBe(cheapest.name);
  });
});

describe("changed external semantics (each one deliberate)", () => {
  it("reports the token cost of the delivered level, not of the whole unit", () => {
    const options = serve();
    const model = options.model;
    const levels = Object.values(model.projections).sort((a, b) => a.targetTokens - b.targetTokens);
    const cheap = executePrimeQuery({ scope: "show", id: TEA, level: levels[0]!.name }, options);
    const dear = executePrimeQuery({ scope: "show", id: TEA, level: levels.at(-1)!.name }, options);
    if ("error" in cheap || "error" in dear) throw new Error("unexpected error");
    // The pre-cutover implementation reported the same number for both.
    expect(cheap.results[0]!.tokens).toBeLessThan(dear.results[0]!.tokens);
  });

  it("returns only units a generator actually matched, instead of padding to limit", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "atoms", query: "zzzznomatch", limit: 3 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results).toHaveLength(0);
  });

  it("lets a declared closure exceed limit rather than truncating it", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "atoms", query: "water tea altitude", limit: 1 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    // `limit` bounds ranked candidates; relation expansion then completes the
    // closure the model declared. Truncating here would hand back a context that
    // looks complete and is missing its dependencies (D-2).
    expect(outcome.results.length).toBeGreaterThan(1);
  });

  it("surfaces the declared-but-unimplemented reranker instead of staying silent", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "atoms", query: "tea", limit: 3 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.diagnostics.some((d) => d.code === "RERANKER_NOT_IMPLEMENTED")).toBe(true);
  });

  it("emits a §11.3 resource URI that the projection engine can parse back", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "atoms", limit: 1 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    const response = createPrimeQueryResponse(
      loadCorpusSnapshot(CORPUS, {}).snapshot,
      { tenant: "local", corpus: options.scope.corpus, release: options.scope.release },
      outcome.results,
      0,
    );
    const uri = response.results[0]!.resource_uri;
    expect(uri.startsWith("prime://local/")).toBe(true);
    const back = resolvePrimeUri(uri, options);
    if ("error" in back) throw new Error(back.error);
    expect(back.unitId).toBe(TEA);
    expect(back.content.length).toBeGreaterThan(0);
  });
});

describe("transport (§9.5)", () => {
  it("delivers a path for a local consumer and content for one that cannot read paths", () => {
    const asPath = executePrimeQuery({ scope: "show", id: TEA }, serve({ transport: "path" }));
    const asInline = executePrimeQuery({ scope: "show", id: TEA }, serve({ transport: "inline" }));
    const asUri = executePrimeQuery({ scope: "show", id: TEA }, serve({ transport: "uri" }));
    if ("error" in asPath || "error" in asInline || "error" in asUri) throw new Error("unexpected error");
    expect(asPath.results[0]!.path).toBeDefined();
    expect(asPath.results[0]!.content).toBeUndefined();
    expect(asInline.results[0]!.content!.length).toBeGreaterThan(0);
    // A remote consumer must not receive a server-local path.
    expect(asInline.results[0]!.path).toBeUndefined();
    expect(asUri.results[0]!.path).toBeUndefined();
    expect(asUri.results[0]!.content).toBeUndefined();
    // Same bytes, whichever way they are described.
    expect(asInline.results[0]!.digest).toBe(asPath.results[0]!.digest);
    expect(asUri.results[0]!.digest).toBe(asPath.results[0]!.digest);
  });

  it("refuses a resource URI for another tenant or corpus without saying which", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "atoms", limit: 1 }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    const response = createPrimeQueryResponse(
      loadCorpusSnapshot(CORPUS, {}).snapshot,
      { tenant: "local", corpus: options.scope.corpus, release: options.scope.release },
      outcome.results,
      0,
    );
    const foreign = response.results[0]!.resource_uri.replace("prime://local/", "prime://other/");
    expect(resolvePrimeUri(foreign, options)).toEqual({ error: `Atom not found: ${TEA}` });
  });

  it("rejects a malformed URI rather than resolving part of it", () => {
    const options = serve();
    const rejected = resolvePrimeUri("prime://local/legacy/units/x/projections/a/b", options);
    expect("error" in rejected).toBe(true);
    expect("error" in resolvePrimeUri("http://example.com", options)).toBe(true);
  });
});

describe("security invariants that must survive the cutover", () => {
  it("filters an unreadable unit before anything observes it, and does not name it", () => {
    const base = serve();
    const hidden = base.corpus.graph.units.find((unit) => unit.identity.id === TEA)!;
    const options: ServeOptions = {
      ...base,
      corpus: {
        ...base.corpus,
        graph: {
          ...base.corpus.graph,
          units: base.corpus.graph.units.map((unit) =>
            unit.identity.id === hidden.identity.id ? { ...unit, visibility: "private" as const } : unit,
          ),
        },
      },
      principal: { id: "restricted", allowedVisibility: ["public"], grantedPolicyLabels: [] },
    };
    const listed = executePrimeQuery({ scope: "atoms", limit: 10 }, options);
    if ("error" in listed) throw new Error(listed.error);
    expect(listed.results.some((r) => r.id === TEA)).toBe(false);
    // Not merely absent from the results: absent from the whole response, so no
    // diagnostic or rejection reason discloses that it exists.
    expect(JSON.stringify(listed)).not.toContain(TEA);

    // A denied unit is indistinguishable from a missing one.
    expect(executePrimeQuery({ scope: "show", id: TEA }, options)).toEqual({
      error: `Atom not found: ${TEA}`,
    });
    // And it cannot be reached by walking an edge that pointed at it.
    const viaEdge = executePrimeQuery(
      { scope: "related", id: "@example/collection-tea-basics", limit: 10 },
      options,
    );
    if ("error" in viaEdge) throw new Error(viaEdge.error);
    expect(JSON.stringify(viaEdge)).not.toContain(TEA);
    // Nor by presenting its resource URI.
    const response = createPrimeQueryResponse(
      loadCorpusSnapshot(CORPUS, {}).snapshot,
      { tenant: "local", corpus: options.scope.corpus, release: options.scope.release },
      [{ ...listed.results[0]!, id: TEA }],
      0,
    );
    expect(resolvePrimeUri(response.results[0]!.resource_uri, options)).toEqual({
      error: `Atom not found: ${TEA}`,
    });
  });

  it("refuses an artifact path that escapes the bundle, which the old loader honoured", () => {
    const base = serve();
    const options: ServeOptions = {
      ...base,
      corpus: {
        ...base.corpus,
        artifacts: new Map([[TEA, { core: "../../../../../../etc/passwd" }]]),
      },
    };
    const outcome = executePrimeQuery({ scope: "show", id: TEA, level: "core" }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results).toHaveLength(0);
    const refused = outcome.diagnostics.find((d) => d.code === "PROJECTION_DELIVERY_REFUSED");
    expect(refused).toBeDefined();
    expect(refused!.severity).toBe("error");
    // `runtime/src/atom-loader.ts` `resolveProjection` returns this path
    // unchecked; going through projection-engine is what closes it.
    expect(refused!.message).not.toContain("/etc/passwd\0");
  });

  it("refuses a NUL byte in an artifact path", () => {
    const base = serve();
    const options: ServeOptions = {
      ...base,
      corpus: { ...base.corpus, artifacts: new Map([[TEA, { core: "chunks/core.md\u0000.png" }]]) },
    };
    const outcome = executePrimeQuery({ scope: "show", id: TEA, level: "core" }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results).toHaveLength(0);
    expect(outcome.diagnostics.some((d) => d.code === "PROJECTION_DELIVERY_REFUSED")).toBe(true);
  });
});

describe("failures are loud", () => {
  it("names an unknown projection level instead of returning an empty result", () => {
    const options = serve();
    const outcome = executePrimeQuery({ scope: "show", id: TEA, level: "nope" }, options);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.results).toHaveLength(0);
    expect(outcome.diagnostics.some((d) => d.code === "PROJECTION_LEVEL_UNKNOWN")).toBe(true);
  });

  it("fails a query whose profile names a generator the host cannot bind", () => {
    const options = serve({ generatorBindings: {} });
    const withoutBinding: ServeOptions = {
      ...options,
      model: {
        ...options.model,
        profiles: Object.fromEntries(
          Object.entries(options.model.profiles).map(([name, profile]) => [
            name,
            { ...profile, candidateGenerators: [{ name: "no-such-generator", weight: 1 }] },
          ]),
        ),
      },
    };
    const outcome = executePrimeQuery({ scope: "atoms", query: "tea" }, withoutBinding);
    expect("error" in outcome).toBe(true);
    if ("error" in outcome) expect(outcome.error).toContain("GENERATOR_NOT_IMPLEMENTED");
  });
});
