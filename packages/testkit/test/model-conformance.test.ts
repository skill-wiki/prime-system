import { expect, test } from "bun:test";
import { join } from "node:path";
import { runModelConformance } from "../src/model-conformance.ts";
import { minimalModelFiles, PROBE_PROJECTION, PROBE_TYPE, removeTree, writeModel } from "./helpers.ts";

const SECURITY_MODEL = join(import.meta.dir, "..", "fixtures", "security-model");

function codes(root: string, checkId: string): readonly string[] {
  const r = runModelConformance(root);
  return (r.checks.find(c => c.id === checkId)?.findings ?? []).map(f => f.code);
}

function withModel<T>(definitions: string, body: (root: string) => T): T {
  const root = writeModel(minimalModelFiles(definitions));
  try { return body(root); } finally { removeTree(root); }
}

test("the second-domain fixture passes every runnable check without engine changes", () => {
  const r = runModelConformance(SECURITY_MODEL);
  expect(r.status).toBe("pass");
  expect(r.errorCount).toBe(0);
  expect(r.warningCount).toBe(0);
  expect(r.checks.filter(c => c.status === "skip")).toEqual([]);
  expect(r.counts).toEqual({ pass: 11, fail: 0, skip: 0 });
});

test("an unloadable model reports manifest failure and skips the deeper checks", () => {
  const root = writeModel({ "prime-model.yaml": "protocol: prime/model/v1\nname: broken\n" });
  try {
    const r = runModelConformance(root);
    expect(r.checks.find(c => c.id === "MC-MANIFEST")?.status).toBe("fail");
    expect(r.checks.find(c => c.id === "MC-TYPE-SUBSTANCE")?.status).toBe("skip");
    expect(r.checks.find(c => c.id === "MC-PROJ-SELECTORS")?.skipReason).toContain("did not load");
  } finally { removeTree(root); }
});

test("a missing model root is reported, not thrown", () => {
  const r = runModelConformance(join(import.meta.dir, "does-not-exist"));
  expect(r.checks.find(c => c.id === "MC-MANIFEST")?.findings.map(f => f.code)).toEqual(["MODEL_ROOT_INVALID"]);
});

test("dangling references land in MC-REFS", () => {
  withModel('  - {kind: type, name: A, version: 1.0.0, fields: [{name: b, typeRef: Missing}]}\n', root => {
    expect(codes(root, "MC-REFS")).toEqual(["DANGLING_TYPE_REF"]);
  });
});

test("empty type shells are an error, and the opt-out is recorded not hidden", () => {
  const root = writeModel(minimalModelFiles('  - {kind: type, name: Hollow, version: 1.0.0, additionalFields: unknown}\n  - {kind: projection, name: summary, version: 1.0.0, targetTokens: 10, rules: [{typeRef: Hollow, include: [anything]}]}\n'));
  try {
    expect(codes(root, "MC-TYPE-SUBSTANCE")).toEqual(["TYPE_DECLARES_NO_FIELDS"]);
    const relaxed = runModelConformance(root, { allowEmptyTypeShells: true });
    const substance = relaxed.checks.find(c => c.id === "MC-TYPE-SUBSTANCE");
    expect(substance?.status).toBe("pass");
    expect(substance?.findings.map(f => f.severity)).toEqual(["warning"]);
    // Relaxing type substance must not silence projection unverifiability.
    expect(relaxed.checks.find(c => c.id === "MC-PROJ-SELECTORS")?.findings.map(f => f.code)).toEqual(["PROJECTION_TARGET_HAS_NO_FIELDS"]);
  } finally { removeTree(root); }
});

test("duplicate field names are rejected", () => {
  withModel('  - {kind: type, name: A, version: 1.0.0, fields: [{name: x, typeRef: string}, {name: x, typeRef: string}]}\n', root => {
    expect(codes(root, "MC-TYPE-SUBSTANCE")).toContain("DUPLICATE_FIELD_NAME");
  });
});

test("contradictory relation semantics are caught", () => {
  const base = PROBE_TYPE + PROBE_PROJECTION;
  withModel(base + '  - {kind: relation, name: r, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: true, semantics: {traversal: one-hop, selection: closure, loadOrder: none, cyclePolicy: allow, conflictSeverity: none}}\n', root => {
    expect(codes(root, "MC-RELATION-SEMANTICS")).toEqual(["RELATION_CLOSURE_WITHOUT_TRANSITIVE"]);
  });
  withModel(base + '  - {kind: relation, name: r, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: true, semantics: {traversal: none, selection: expand, loadOrder: before, cyclePolicy: reject, conflictSeverity: none}}\n', root => {
    expect(codes(root, "MC-RELATION-SEMANTICS")).toEqual(["RELATION_EXPAND_WITHOUT_TRAVERSAL", "RELATION_CYCLE_POLICY_UNREACHABLE", "RELATION_LOAD_ORDER_UNREACHABLE"]);
  });
  withModel(base + '  - {kind: relation, name: r, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: false, semantics: {traversal: one-hop, selection: informational, loadOrder: none, cyclePolicy: allow, conflictSeverity: error}}\n', root => {
    expect(codes(root, "MC-RELATION-SEMANTICS")).toEqual(["RELATION_CONFLICT_NOT_ENFORCED"]);
  });
});

test("asymmetric inverse declarations are caught", () => {
  const semantics = "{traversal: one-hop, selection: expand, loadOrder: none, cyclePolicy: allow, conflictSeverity: none}";
  withModel(PROBE_TYPE + PROBE_PROJECTION
    + `  - {kind: relation, name: a, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: true, inverse: b, semantics: ${semantics}}\n`
    + `  - {kind: relation, name: b, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: true, inverse: a, semantics: ${semantics}}\n`, root => {
      expect(codes(root, "MC-RELATION-SEMANTICS")).toEqual([]);
    });
  withModel(PROBE_TYPE + PROBE_PROJECTION
    + `  - {kind: relation, name: a, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: true, inverse: b, semantics: ${semantics}}\n`
    + `  - {kind: relation, name: b, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: true, inverse: c, semantics: ${semantics}}\n`
    + `  - {kind: relation, name: c, version: 1.0.0, from: Widget, to: Widget, cardinality: many-to-many, directional: true, semantics: ${semantics}}\n`, root => {
      expect(codes(root, "MC-RELATION-SEMANTICS")).toEqual(["RELATION_INVERSE_ASYMMETRIC"]);
    });
});

test("an ungoverned writing action is an error", () => {
  withModel(PROBE_TYPE + PROBE_PROJECTION
    + '  - {kind: action, name: W, version: 1.0.0, inputs: [], output: boolean, capabilities: [], sideEffects: write, idempotency: unknown, approval: never}\n', root => {
      expect(codes(root, "MC-ACTION-IO")).toEqual(["ACTION_WRITE_WITHOUT_CAPABILITY", "ACTION_WRITE_IDEMPOTENCY_UNKNOWN", "ACTION_EFFECT_WITHOUT_PROVIDER"]);
    });
});

test("a pure but non-deterministic function is an error", () => {
  withModel(PROBE_TYPE + PROBE_PROJECTION
    + '  - {kind: function, name: F, version: 1.0.0, inputs: [{name: a, typeRef: string}, {name: a, typeRef: string}], output: string, purity: pure, deterministic: false, provider: p}\n', root => {
      expect(codes(root, "MC-ACTION-IO")).toEqual(["DUPLICATE_INPUT_NAME", "FUNCTION_PURE_NONDETERMINISTIC"]);
    });
});

test("a type no projection covers fails coverage", () => {
  withModel(PROBE_TYPE + PROBE_PROJECTION
    + '  - {kind: type, name: Orphan, version: 1.0.0, fields: [{name: x, typeRef: string}]}\n', root => {
      expect(codes(root, "MC-PROJ-COVERAGE")).toEqual(["TYPE_NOT_PROJECTED"]);
    });
});

test("rule-scoped and model-wide selectors are graded differently", () => {
  withModel('  - {kind: type, name: A, version: 1.0.0, fields: [{name: x, typeRef: string}]}\n'
    + '  - {kind: projection, name: p, version: 1.0.0, targetTokens: 10, include: [nope], rules: [{typeRef: A, include: [x, alsoNope]}]}\n', root => {
      const findings = runModelConformance(root).checks.find(c => c.id === "MC-PROJ-SELECTORS")?.findings ?? [];
      expect(findings.map(f => `${f.severity}/${f.code}`)).toEqual(["error/PROJECTION_SELECTOR_UNRESOLVED", "warning/PROJECTION_BASE_SELECTOR_UNRESOLVED"]);
      expect(findings[0]?.message).toContain("alsoNope");
      expect(findings[0]?.message).not.toContain("nope,");
    });
});

test("additionalFields=unknown downgrades an unresolved rule selector to a warning", () => {
  withModel('  - {kind: type, name: A, version: 1.0.0, additionalFields: unknown, fields: [{name: x, typeRef: string}]}\n'
    + '  - {kind: projection, name: p, version: 1.0.0, targetTokens: 10, rules: [{typeRef: A, include: [y]}]}\n', root => {
      const findings = runModelConformance(root).checks.find(c => c.id === "MC-PROJ-SELECTORS")?.findings ?? [];
      expect(findings.map(f => f.severity)).toEqual(["warning"]);
    });
});

test("a wildcard projection covers every type and resolves every selector", () => {
  withModel('  - {kind: type, name: A, version: 1.0.0, fields: [{name: x, typeRef: string}]}\n'
    + '  - {kind: type, name: B, version: 1.0.0, fields: [{name: y, typeRef: string}]}\n'
    + '  - {kind: projection, name: full, version: 1.0.0, targetTokens: 10, include: ["*"]}\n', root => {
      const r = runModelConformance(root);
      expect(r.checks.find(c => c.id === "MC-PROJ-COVERAGE")?.status).toBe("pass");
      expect(r.checks.find(c => c.id === "MC-PROJ-SELECTORS")?.status).toBe("pass");
    });
});

test("an unusable retrieval profile is an error", () => {
  withModel(PROBE_TYPE + PROBE_PROJECTION
    + '  - {kind: retrieval-profile, name: rp, version: 1.0.0, projection: summary, candidateGenerators: [{name: g, weight: 0}, {name: g, weight: 0}], features: {}}\n', root => {
      expect(codes(root, "MC-RETRIEVAL-PROFILE")).toEqual(["DUPLICATE_GENERATOR", "GENERATOR_WEIGHTS_ALL_ZERO", "PROFILE_WITHOUT_FEATURES"]);
    });
});

test("a model with no type or projection at all fails loudly", () => {
  withModel('  - {kind: function, name: F, version: 1.0.0, inputs: [], output: string, purity: pure, deterministic: true, provider: p}\n', root => {
    expect(codes(root, "MC-TYPE-SUBSTANCE")).toEqual(["NO_TYPES"]);
    expect(codes(root, "MC-PROJ-COVERAGE")).toEqual(["NO_PROJECTIONS"]);
  });
});

test("the suite runs on a third, unrelated model package without code changes", () => {
  const ticket = join(import.meta.dir, "..", "..", "model-schema", "test", "fixtures", "ticket-model");
  const r = runModelConformance(ticket);
  expect(r.checks.find(c => c.id === "MC-MANIFEST")?.status).toBe("pass");
  expect(r.checks.find(c => c.id === "MC-REFS")?.status).toBe("pass");
  expect(r.checks.find(c => c.id === "MC-TYPE-SUBSTANCE")?.status).toBe("pass");
});
