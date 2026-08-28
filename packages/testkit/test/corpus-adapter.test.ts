import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import { corpusFromV1Sources } from "../src/corpus-adapter.ts";
import { runCorpusConformance } from "../src/corpus-conformance.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const COMPAT = join(REPO_ROOT, "compat", "prime-v1-model");
const sources = (name: string): string => join(REPO_ROOT, "examples", name, "primes", "sources");

const model = loadModelOrThrow(COMPAT);

function adapt(name: string) {
  return corpusFromV1Sources({ sourcesDir: sources(name), model, name, citationFields: ["source"] });
}

test("real .prime corpora adapt without rejects and pass the runnable corpus checks", () => {
  for (const name of ["hello-world", "coding-style", "recipes"] as const) {
    const { corpus, rejected } = adapt(name);
    expect(rejected).toEqual([]);
    expect(corpus.units.length).toBeGreaterThan(0);
    expect(corpus.model).toBe(model.manifest.name);
    const r = runCorpusConformance(corpus, model);
    expect(r.errorCount).toBe(0);
    expect(r.status).toBe("pass");
  }
});

test("relation fields are recognised from the model, not from a hardcoded list", () => {
  const declared = new Set(model.definitions.flatMap(d => (d.kind === "relation" ? [d.name, ...(d.aliases ?? [])] : [])));
  const { corpus } = adapt("hello-world");
  const used = new Set(corpus.units.flatMap(u => u.relations.map(r => r.relation)));
  expect(used.size).toBeGreaterThan(0);
  // Every edge the adapter produced came from a relation the model declares...
  for (const relation of used) expect(declared.has(relation)).toBe(true);
  // ...and no declared relation name leaked into `fields`.
  for (const u of corpus.units) for (const key of Object.keys(u.fields)) expect(declared.has(key)).toBe(false);
});

test("a dangling relation target in a real corpus is caught", () => {
  const { corpus } = adapt("hello-world");
  const broken = structuredClone(corpus);
  broken.units[0]!.relations.push({ relation: "related", to: "@example/does-not-exist" });
  const findings = runCorpusConformance(broken, model).checks.find(c => c.id === "CC-DANGLING-RELATIONS")?.findings ?? [];
  expect(findings.map(f => f.code)).toEqual(["DANGLING_RELATION_TARGET"]);
});

/**
 * The instrument must be honest about when it cannot measure: a model of empty
 * type shells with `additionalFields: unknown` makes instance validation a
 * no-op, and CC-INSTANCE-SCHEMA passing under it carries no information.
 */
test("instance validation is vacuous against empty type shells and informative against a real schema", () => {
  const { corpus } = adapt("hello-world");
  const hollowTypes = model.definitions.filter(d => d.kind === "type" && d.fields.length === 0 && d.additionalFields === "unknown");
  const usedTypes = new Set(corpus.units.map(u => u.typeRef));
  const allHollow = [...usedTypes].every(t => hollowTypes.some(h => h.name === t));

  const mutated = structuredClone(corpus);
  mutated.units[0]!.fields["totallyInventedField"] = 1;
  const codes = (runCorpusConformance(mutated, model).checks.find(c => c.id === "CC-INSTANCE-SCHEMA")?.findings ?? []).map(f => f.code);

  if (allHollow) expect(codes).toEqual([]);
  else expect(codes).toContain("UNDECLARED_FIELD");

  // The same check against a type that declares a schema does fire, which is
  // what proves the emptiness above is the model's state and not a dead check.
  const strict = loadModelOrThrow(join(import.meta.dir, "..", "fixtures", "security-model"));
  const secure = { kind: "corpus" as const, name: "probe", version: "1.0.0", model: strict.manifest.name, units: [{
    id: "@p/a", version: "1.0.0", typeRef: "Asset",
    fields: { name: "A", classification: "public", totallyInventedField: 1 },
    relations: [], citations: [], lifecycle: "active" as const, visibility: "shared" as const, tokens: {},
  }] };
  expect((runCorpusConformance(secure, strict).checks.find(c => c.id === "CC-INSTANCE-SCHEMA")?.findings ?? []).map(f => f.code)).toEqual(["UNDECLARED_FIELD"]);
});
