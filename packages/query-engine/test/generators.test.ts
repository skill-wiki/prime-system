import { describe, expect, test } from "bun:test";
import type { DiagnosticIR } from "@skill-wiki/ir";
import {
  CandidateGeneratorRegistry,
  QueryEngineError,
  buildAdjacency,
  createFacetGenerator,
  createGraphGenerator,
  createLexicalGenerator,
  createUnimplementedGenerator,
  type GeneratorContext,
  type QueryRequest,
} from "../src/index.ts";
import { domainA } from "./support/model.ts";
import { anyPrincipal, corpusA } from "./support/harness.ts";

function generatorContext(diagnostics: DiagnosticIR[]): GeneratorContext {
  const adjacency = buildAdjacency(corpusA());
  return {
    profile: domainA.profile,
    relations: domainA.relations,
    unitsById: adjacency.unitsById,
    outgoing: adjacency.outgoing,
    incoming: adjacency.incoming,
    report: d => diagnostics.push(d),
  };
}

function request(overrides: Partial<QueryRequest>): QueryRequest {
  return {
    requestId: "r1",
    profile: domainA.profile.name,
    principal: anyPrincipal,
    maxTokens: 1000,
    ...overrides,
  };
}

describe("lexical generator", () => {
  const generator = createLexicalGenerator({ name: "lexical", featureAxis: "textMatch" });

  test("ranks the unit whose text carries the rarer query term higher", () => {
    const diagnostics: DiagnosticIR[] = [];
    const candidates = generator.generate(
      request({ text: "database rollback" }),
      corpusA(),
      generatorContext(diagnostics),
    );
    expect(candidates.map(c => c.unitId)).toEqual(["I3"]);
    expect(candidates[0]!.featureValues.textMatch).toBe(1);
    expect(candidates[0]!.reasons[0]).toContain("matched terms");
  });

  test("normalises the best match to 1 so the axis is comparable with other axes", () => {
    const candidates = generator.generate(request({ text: "login submit" }), corpusA(), generatorContext([]));
    const values = candidates.map(c => c.featureValues.textMatch!);
    expect(Math.max(...values)).toBe(1);
    for (const value of values) expect(value).toBeLessThanOrEqual(1);
  });

  test("reports an info diagnostic and yields nothing when no term matches", () => {
    const diagnostics: DiagnosticIR[] = [];
    const candidates = generator.generate(
      request({ text: "quantum chromodynamics" }),
      corpusA(),
      generatorContext(diagnostics),
    );
    expect(candidates).toEqual([]);
    expect(diagnostics.map(d => d.code)).toEqual(["LEXICAL_NO_MATCH"]);
  });

  test("yields nothing for an empty query rather than ranking the whole corpus", () => {
    expect(generator.generate(request({}), corpusA(), generatorContext([]))).toEqual([]);
    expect(generator.generate(request({ text: "  " }), corpusA(), generatorContext([]))).toEqual([]);
  });

  test("indexes only the configured field paths when they are given", () => {
    const titled = createLexicalGenerator({
      name: "lexical",
      featureAxis: "textMatch",
      fields: [["title"]],
    });
    // "backend" lives in `labels`, not `title`, so a title-only index must miss it.
    expect(titled.generate(request({ text: "backend" }), corpusA(), generatorContext([]))).toEqual([]);
    expect(
      createLexicalGenerator({ name: "lexical", featureAxis: "textMatch", fields: [["labels"]] })
        .generate(request({ text: "backend" }), corpusA(), generatorContext([]))
        .map(c => c.unitId),
    ).toEqual(["I3"]);
  });

  test("honours stop words on both the document and the query side", () => {
    const stopped = createLexicalGenerator({
      name: "lexical",
      featureAxis: "textMatch",
      stopWords: ["login"],
    });
    expect(stopped.generate(request({ text: "login" }), corpusA(), generatorContext([]))).toEqual([]);
  });
});

describe("facet generator", () => {
  const generator = createFacetGenerator({ name: "facet", featureAxis: "facetMatch" });

  test("yields nothing when the request carries no facet", () => {
    expect(generator.generate(request({}), corpusA(), generatorContext([]))).toEqual([]);
  });

  test("scores the satisfied fraction, not a boolean", () => {
    const candidates = generator.generate(
      request({
        facets: [
          { kind: "typeRef", anyOf: ["Issue"] },
          { kind: "field", path: ["labels"], anyOf: ["frontend"] },
        ],
      }),
      corpusA(),
      generatorContext([]),
    );
    const byId = new Map(candidates.map(c => [c.unitId, c.featureValues.facetMatch]));
    expect(byId.get("I1")).toBe(1);
    expect(byId.get("I3")).toBe(0.5);
    expect(byId.has("N1")).toBe(false);
  });

  test("matches a scalar field value", () => {
    const candidates = generator.generate(
      request({ facets: [{ kind: "field", path: ["priority"], anyOf: [1] }] }),
      corpusA(),
      generatorContext([]),
    );
    expect(candidates.map(c => c.unitId)).toEqual(["I1"]);
  });

  test("descends a path through an array of objects", () => {
    const candidates = generator.generate(
      request({ facets: [{ kind: "field", path: ["history", "actor"], anyOf: ["bob"] }] }),
      corpusA(),
      generatorContext([]),
    );
    expect(candidates.map(c => c.unitId)).toEqual(["I2"]);
  });

  test("a path into a field the unit lacks is a non-match, not a fault", () => {
    const candidates = generator.generate(
      request({ facets: [{ kind: "field", path: ["nonexistent", "deep"], anyOf: ["x"] }] }),
      corpusA(),
      generatorContext([]),
    );
    expect(candidates).toEqual([]);
  });
});

describe("graph generator", () => {
  const generator = createGraphGenerator({ name: "graph", featureAxis: "graphProximity" });

  test("yields nothing without seeds", () => {
    expect(generator.generate(request({}), corpusA(), generatorContext([]))).toEqual([]);
  });

  test("decays with hop count and chains only through transitive relations", () => {
    const candidates = generator.generate(request({ seeds: ["I1"] }), corpusA(), generatorContext([]));
    const byId = new Map(candidates.map(c => [c.unitId, c.featureValues.graphProximity]));
    expect(byId.get("I1")).toBe(1);
    expect(byId.get("I5")).toBe(0.5);
    // I3 is two `blocked-by` hops away and `blocked-by` is transitive.
    expect(byId.get("I3")).toBe(quantizedThird());
    // I2 is one `superseded-by` hop away, and that relation declares traversal
    // `none` — it must not be a retrieval path even though selection is `expand`.
    expect(byId.has("I2")).toBe(false);
  });

  test("respects a hop ceiling", () => {
    const shallow = createGraphGenerator({ name: "graph", featureAxis: "graphProximity", maxDepth: 1 });
    const reached = shallow
      .generate(request({ seeds: ["I1"] }), corpusA(), generatorContext([]))
      .map(c => c.unitId);
    expect(reached).toContain("I5");
    expect(reached).not.toContain("I3");
  });

  test("warns without confirming existence when a seed is not in the admitted graph", () => {
    const diagnostics: DiagnosticIR[] = [];
    generator.generate(request({ seeds: ["nope"] }), corpusA(), generatorContext(diagnostics));
    expect(diagnostics.map(d => d.code)).toEqual(["SEED_NOT_AVAILABLE"]);
    expect(diagnostics[0]!.message).not.toContain("visibility");
  });

  test("warns once per undeclared relation reference", () => {
    const diagnostics: DiagnosticIR[] = [];
    const adjacency = buildAdjacency(corpusA());
    generator.generate(request({ seeds: ["I1"] }), corpusA(), {
      profile: domainA.profile,
      relations: {},
      unitsById: adjacency.unitsById,
      outgoing: adjacency.outgoing,
      incoming: adjacency.incoming,
      report: d => diagnostics.push(d),
    });
    expect(new Set(diagnostics.map(d => d.code))).toEqual(new Set(["RELATION_NOT_DECLARED"]));
    expect(diagnostics.length).toBe(new Set(diagnostics.map(d => d.message)).size);
  });
});

function quantizedThird(): number {
  return Math.round((1 / 3) * 1e6) / 1e6;
}

describe("registry", () => {
  test("rejects duplicate registration", () => {
    const registry = new CandidateGeneratorRegistry().register(
      createFacetGenerator({ name: "facet", featureAxis: "facetMatch" }),
    );
    expect(() => registry.register(createFacetGenerator({ name: "facet", featureAxis: "other" }))).toThrow(
      QueryEngineError,
    );
  });

  test("rejects a generator that declares no axis, because it could never be weighted", () => {
    const registry = new CandidateGeneratorRegistry();
    expect(() =>
      registry.register({ name: "mute", featureAxes: [], generate: () => [] }),
    ).toThrow(/GENERATOR_NO_AXES/);
  });

  test("reports every unknown generator name at once", () => {
    const registry = new CandidateGeneratorRegistry();
    try {
      registry.resolve(["a", "b"]);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryEngineError);
      expect((error as QueryEngineError).diagnostics.length).toBe(2);
    }
  });

  test("a reserved slot throws instead of silently returning zero candidates", () => {
    const reserved = createUnimplementedGenerator({
      name: "vector",
      featureAxes: ["embeddingSimilarity"],
      reason: "vector retrieval is a later plugin, not an engine concept",
    });
    new CandidateGeneratorRegistry().register(reserved);
    expect(() => reserved.generate(request({}), corpusA(), generatorContext([]))).toThrow(
      /GENERATOR_NOT_IMPLEMENTED/,
    );
  });
});
