import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModelOrThrow, type LoadedModel } from "@skill-wiki/model-schema";
import { canonicalJson, computeContentDigest, computeUnitDigest, loadCorpus, type CorpusPackage, type CorpusUnitRecord } from "../src/corpus.ts";
import { runCorpusConformance } from "../src/corpus-conformance.ts";

const MODEL_ROOT = join(import.meta.dir, "..", "fixtures", "security-model");
const CORPUS_PATH = join(MODEL_ROOT, "corpus", "units.yaml");

const model: LoadedModel = loadModelOrThrow(MODEL_ROOT);

function baseCorpus(): CorpusPackage {
  const loaded = loadCorpus(CORPUS_PATH);
  if (!loaded.ok) throw new Error(`fixture corpus failed to load: ${loaded.diagnostics.map(d => d.message).join("; ")}`);
  return structuredClone(loaded.value);
}

function unit(corpus: CorpusPackage, id: string): CorpusUnitRecord {
  const found = corpus.units.find(u => u.id === id);
  if (found === undefined) throw new Error(`fixture changed: no unit ${id}`);
  return found;
}

function codes(corpus: CorpusPackage, checkId: string, options: Parameters<typeof runCorpusConformance>[2] = {}): readonly string[] {
  const r = runCorpusConformance(corpus, model, options);
  return (r.checks.find(c => c.id === checkId)?.findings ?? []).map(f => f.code);
}

test("canonical json sorts keys so a digest is producer-independent", () => {
  expect(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] })).toBe('{"a":[3,{"c":5,"d":4}],"b":1}');
  expect(canonicalJson(null)).toBe("null");
});

test("the second-domain corpus passes every runnable check", () => {
  const r = runCorpusConformance(baseCorpus(), model, { allowedLicenses: ["Apache-2.0"] });
  expect(r.errorCount).toBe(0);
  expect(r.status).toBe("pass");
  // Golden queries have no engine to run against yet; that must read as a skip.
  expect(r.checks.filter(c => c.status === "skip").map(c => c.id)).toEqual(["CC-GOLDEN-QUERY"]);
});

test("a corpus compiled against another model is rejected", () => {
  const corpus = baseCorpus();
  corpus.model = "some-other-model";
  expect(codes(corpus, "CC-MODEL-BINDING")).toEqual(["CORPUS_MODEL_MISMATCH"]);
});

test("digest integrity is verified by recomputation, not trusted", () => {
  const corpus = baseCorpus();
  const target = unit(corpus, "@sec/control-multi-factor");
  target.digest = computeUnitDigest(target);
  expect(codes(corpus, "CC-IDENTITY")).toEqual([]);
  target.fields["strength"] = 1;
  expect(codes(corpus, "CC-IDENTITY")).toEqual(["DIGEST_MISMATCH"]);
});

test("an identity digest hashes the id, a content digest does not", () => {
  const corpus = baseCorpus();
  const a = unit(corpus, "@sec/asset-public-website");
  const b = structuredClone(a);
  b.id = "@sec/asset-public-website-copy";
  expect(computeUnitDigest(a)).not.toBe(computeUnitDigest(b));
  expect(computeContentDigest(a)).toBe(computeContentDigest(b));
});

test("duplicate identities and duplicated content are both reported", () => {
  const corpus = baseCorpus();
  const clone = structuredClone(unit(corpus, "@sec/asset-public-website"));
  corpus.units.push(clone);
  expect(codes(corpus, "CC-IDENTITY")).toEqual(["DUPLICATE_UNIT_VERSION"]);
  const renamed = structuredClone(clone);
  renamed.id = "@sec/asset-public-website-copy";
  corpus.units.splice(corpus.units.length - 1, 1, renamed);
  expect(codes(corpus, "CC-IDENTITY")).toEqual(["DIGEST_COLLISION"]);
});

test("dangling and undeclared relations are reported separately from endpoint typing", () => {
  const corpus = baseCorpus();
  unit(corpus, "@sec/control-request-filter").relations.push({ relation: "mitigates", to: "@sec/threat-nonexistent" });
  expect(codes(corpus, "CC-DANGLING-RELATIONS")).toEqual(["DANGLING_RELATION_TARGET"]);
  expect(codes(corpus, "CC-DANGLING-RELATIONS", { externalIds: ["@sec/threat-nonexistent"] })).toEqual([]);

  const other = baseCorpus();
  unit(other, "@sec/control-request-filter").relations.push({ relation: "invented-by", to: "@sec/asset-public-website" });
  expect(codes(other, "CC-DANGLING-RELATIONS")).toEqual(["UNKNOWN_RELATION"]);
});

test("relation aliases declared by the model are accepted", () => {
  const corpus = baseCorpus();
  const edge = unit(corpus, "@sec/control-request-filter").relations.find(r => r.relation === "incompatible-with");
  if (edge === undefined) throw new Error("fixture changed");
  edge.relation = "incompatible_with";
  expect(codes(corpus, "CC-DANGLING-RELATIONS")).toEqual([]);
});

test("endpoint types are enforced against the relation declaration", () => {
  const corpus = baseCorpus();
  unit(corpus, "@sec/control-request-filter").relations.push({ relation: "mitigates", to: "@sec/asset-public-website" });
  expect(codes(corpus, "CC-RELATION-ENDPOINTS")).toEqual(["RELATION_TARGET_TYPE_MISMATCH"]);
  const other = baseCorpus();
  unit(other, "@sec/asset-public-website").relations.push({ relation: "guards", to: "@sec/asset-customer-database" });
  expect(codes(other, "CC-RELATION-ENDPOINTS")).toEqual(["RELATION_SOURCE_TYPE_MISMATCH"]);
});

test("a cycle is only rejected on relations whose model says cyclePolicy=reject", () => {
  const corpus = baseCorpus();
  unit(corpus, "@sec/control-identity-provider").relations.push({ relation: "depends-on", to: "@sec/control-multi-factor" });
  const findings = runCorpusConformance(corpus, model).checks.find(c => c.id === "CC-CYCLE-POLICY")?.findings ?? [];
  expect(findings.map(f => f.code)).toEqual(["CYCLE_POLICY_VIOLATION"]);
  expect(findings[0]?.message).toContain("depends-on");

  // `guards` declares cyclePolicy=allow, so a loop there is the model's business.
  const allowed = baseCorpus();
  unit(allowed, "@sec/control-multi-factor").relations.push({ relation: "guards", to: "@sec/asset-public-website" });
  expect(codes(allowed, "CC-CYCLE-POLICY")).toEqual([]);
});

test("instance validation enforces required fields, unknown fields and scalar types", () => {
  const missing = baseCorpus();
  delete unit(missing, "@sec/threat-injected-query").fields["vector"];
  expect(codes(missing, "CC-INSTANCE-SCHEMA")).toEqual(["MISSING_REQUIRED_FIELD"]);

  const extra = baseCorpus();
  unit(extra, "@sec/threat-injected-query").fields["improvised"] = true;
  expect(codes(extra, "CC-INSTANCE-SCHEMA")).toEqual(["UNDECLARED_FIELD"]);

  const wrong = baseCorpus();
  unit(wrong, "@sec/threat-injected-query").fields["severity"] = 2.5;
  expect(codes(wrong, "CC-INSTANCE-SCHEMA")).toEqual(["FIELD_TYPE_MISMATCH"]);

  const badType = baseCorpus();
  unit(badType, "@sec/control-multi-factor").fields["automated"] = "yes";
  expect(codes(badType, "CC-INSTANCE-SCHEMA")).toEqual(["FIELD_TYPE_MISMATCH"]);
});

test("a field whose type is another type must hold a unit id of that type", () => {
  const notAnId = baseCorpus();
  unit(notAnId, "@sec/control-multi-factor").fields["guardedAsset"] = 42;
  expect(codes(notAnId, "CC-INSTANCE-SCHEMA")).toEqual(["FIELD_REFERENCE_NOT_AN_ID"]);

  const wrongTarget = baseCorpus();
  unit(wrongTarget, "@sec/control-multi-factor").fields["guardedAsset"] = "@sec/threat-injected-query";
  expect(codes(wrongTarget, "CC-INSTANCE-SCHEMA")).toEqual(["FIELD_REFERENCE_UNRESOLVED"]);
});

test("a unit of an unknown type is reported once, not cascaded", () => {
  const corpus = baseCorpus();
  // Nothing points a typed field at the assessment, so exactly one finding is expected.
  unit(corpus, "@sec/assessment-multi-factor-q3").typeRef = "Gadget";
  expect(codes(corpus, "CC-INSTANCE-SCHEMA")).toEqual(["UNKNOWN_UNIT_TYPE"]);
});

test("retyping a referenced unit is reported by both the type check and the reference check", () => {
  const corpus = baseCorpus();
  unit(corpus, "@sec/asset-public-website").typeRef = "Gadget";
  expect(codes(corpus, "CC-INSTANCE-SCHEMA")).toEqual(["UNKNOWN_UNIT_TYPE", "FIELD_REFERENCE_UNRESOLVED"]);
});

test("citation requirements come from the model, not from the engine", () => {
  const corpus = baseCorpus();
  unit(corpus, "@sec/evidence-factor-enrolment-export").citations = [];
  expect(codes(corpus, "CC-CITATION")).toEqual(["MISSING_CITATION"]);
  // A draft is exempt: it has not been published yet.
  unit(corpus, "@sec/evidence-factor-enrolment-export").lifecycle = "draft";
  expect(codes(corpus, "CC-CITATION")).toEqual([]);
});

test("lifecycle enforcement distinguishes deleted targets from deprecated ones", () => {
  const deleted = baseCorpus();
  unit(deleted, "@sec/control-identity-provider").lifecycle = "deleted";
  expect(codes(deleted, "CC-LIFECYCLE")).toEqual(["REFERENCES_DELETED_UNIT"]);

  const deprecated = baseCorpus();
  unit(deprecated, "@sec/control-identity-provider").lifecycle = "deprecated";
  unit(deprecated, "@sec/control-identity-provider").supersededBy = "@sec/control-multi-factor";
  // depends-on has selection=closure, so a deprecated target is load-bearing.
  expect(codes(deprecated, "CC-LIFECYCLE")).toEqual(["LOAD_BEARING_DEPRECATED_TARGET"]);

  const orphanSuccessor = baseCorpus();
  unit(orphanSuccessor, "@sec/control-inline-proxy").supersededBy = "@sec/control-ghost";
  expect(codes(orphanSuccessor, "CC-LIFECYCLE")).toEqual(["SUCCESSOR_NOT_FOUND"]);

  const noSuccessor = baseCorpus();
  delete unit(noSuccessor, "@sec/control-inline-proxy").supersededBy;
  expect(codes(noSuccessor, "CC-LIFECYCLE")).toEqual(["DEPRECATED_WITHOUT_SUCCESSOR"]);
});

test("license policy only applies when a policy is supplied", () => {
  const corpus = baseCorpus();
  const r = runCorpusConformance(corpus, model);
  expect(r.checks.find(c => c.id === "CC-LICENSE")?.status).toBe("skip");
  expect(codes(corpus, "CC-LICENSE", { allowedLicenses: ["MIT"] }).slice(0, 1)).toEqual(["LICENSE_NOT_ALLOWED"]);
  delete unit(corpus, "@sec/asset-public-website").license;
  expect(codes(corpus, "CC-LICENSE", { allowedLicenses: ["Apache-2.0"] })).toEqual(["LICENSE_MISSING"]);
});

test("projection budgets come from the model's targetTokens", () => {
  const corpus = baseCorpus();
  unit(corpus, "@sec/asset-public-website").tokens["core"] = 10_000;
  expect(codes(corpus, "CC-PROJECTION-BUDGET")).toEqual(["PROJECTION_BUDGET_EXCEEDED"]);
  const unknown = baseCorpus();
  unit(unknown, "@sec/asset-public-website").tokens["mobile"] = 1;
  expect(codes(unknown, "CC-PROJECTION-BUDGET")).toEqual(["TOKENS_FOR_UNKNOWN_PROJECTION"]);
  const unmeasured = baseCorpus();
  for (const u of unmeasured.units) u.tokens = {};
  expect(runCorpusConformance(unmeasured, model).checks.find(c => c.id === "CC-PROJECTION-BUDGET")?.status).toBe("skip");
});

test("golden queries skip without an engine and compare rank order with one", () => {
  const corpus = baseCorpus();
  const goldenQueries = [{ name: "top-controls", request: { text: "factor" }, expectedUnitIds: ["@sec/control-multi-factor"] }];
  expect(runCorpusConformance(corpus, model, { goldenQueries }).checks.find(c => c.id === "CC-GOLDEN-QUERY")?.skipReason).toContain("no query implementation");
  expect(codes(corpus, "CC-GOLDEN-QUERY", { goldenQueries, runQuery: () => ["@sec/control-multi-factor"] })).toEqual([]);
  expect(codes(corpus, "CC-GOLDEN-QUERY", { goldenQueries, runQuery: () => ["@sec/control-request-filter"] })).toEqual(["GOLDEN_QUERY_MISMATCH"]);
});

test("corpus loading reports rather than throws", () => {
  expect(loadCorpus(join(import.meta.dir, "nope.yaml"))).toEqual({ ok: false, diagnostics: [{ code: "CORPUS_FILE_INVALID", message: "corpus path must name an existing regular file", path: join(import.meta.dir, "nope.yaml") }] });
  const bad = loadCorpus(join(MODEL_ROOT, "prime-model.yaml"));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.diagnostics[0]?.code).toBe("INVALID_CORPUS");
});
