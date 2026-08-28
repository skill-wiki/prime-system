import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import type { LoadedModel, ProjectionDefinition } from "@skill-wiki/model-schema";
import { compileUnit, computeCompiledUnitContentDigest, emitCompiledUnit } from "../src/generic-unit";

const model = loadModelOrThrow(join(import.meta.dir, "../../model-schema/test/fixtures/ticket-model"));
const context = { corpus: "tickets", version: "1.0.0", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
test("generic compiler uses only external projection definitions", () => {
  const result = compileUnit('unit T1 : Ticket { title: "A" priority: 2 active: true owner: Owner.a metadata: { x: 1 } }', model, context, { projections: ["summary", "core", "full"] });
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(result.value.projections.summary?.content).toContain("priority: 2");
  expect(result.value.projections.core?.content).toContain("owner: \"Owner.a\"");
  expect(result.value.projections.full?.content).toContain("metadata:");
  expect(result.value.projections.full?.content).toContain('{"x":1}');
});
test("projection selectors support the complete UnitIR meta envelope and rule precedence", () => {
  const projection: ProjectionDefinition = { kind: "projection", name: "envelope", version: "1.0.0", targetTokens: 300, include: ["meta:*", "fields.title", "owner*"], exclude: ["meta.digest", "fields.owner"], typeGroups: { tickets: ["Ticket"], other: ["Owner"] }, rules: [{ typeRef: "Ticket", include: ["active"] }, { typeRef: "group:tickets", include: ["priority"] }, { typeRef: "group:other", exclude: ["title"] }] };
  const result = compileUnit('unit T2 : Ticket { title: "A\\nB" priority: 2 active: true owner: Owner.a metadata: { x: ["q", 1] } }', { ...model, definitions: [...model.definitions, projection] } as LoadedModel, context, { projections: ["envelope"] });
  expect(result.ok).toBe(true); if (!result.ok) return; const content = result.value.projections.envelope!.content;
  for (const key of ["meta.id", "meta.version", "meta.corpus", "meta.typeRef", "meta.implements", "meta.citations", "meta.policyLabels", "meta.lifecycle", "meta.visibility"]) expect(content).toContain(`${key}:`);
  expect(content).not.toContain("meta.digest:"); expect(content).toContain('title: "A\\nB"'); expect(content).toContain("priority: 2"); expect(content).toContain("active: true"); expect(content).not.toContain("owner:");
});
test("Ticket is a non-legacy external model type and default selection is model order", () => {
  // The engine has no kind list to check against any more, so the meaningful
  // assertion is against data: Ticket is absent from the v1 compatibility
  // model, i.e. it really does come from an external model package.
  const compat = loadModelOrThrow(join(import.meta.dir, "../../../compat/prime-v1-model"));
  const compatTypeNames = compat.definitions.filter(d => d.kind === "type").map(d => d.name);
  expect(compatTypeNames).not.toContain("Ticket");
  expect(compatTypeNames).toContain("fact");
  const result = compileUnit('unit T3 : Ticket { title: "A" }', model, context);
  expect(result.ok).toBe(true); if (result.ok) expect(Object.keys(result.value.projections)).toEqual(["summary", "core", "full"]);
});
test("a generic type without a title field receives a deterministic description", () => {
  const result = compileUnit('unit N1 : Note { body: "domain independent" }', model, context);
  expect(result.ok).toBe(true); if (result.ok) expect(result.value.meta.description).toBe("domain independent");
});
test("compiled content digest binds the stable unit envelope", () => {
  const source = 'unit T6 : Ticket { title: "A" }'; const a = compileUnit(source, model, context); const b = compileUnit(source, model, { ...context, version: "1.0.1", lifecycle: "deprecated" });
  expect(a.ok && b.ok).toBe(true); if (a.ok && b.ok) expect(a.value.meta.contentDigest).not.toBe(b.value.meta.contentDigest);
});
test("compiled digest binds fields and emitter rejects a stale meta digest", () => {
  const result = compileUnit('unit T7 : Ticket { title: "A" }', model, context); expect(result.ok).toBe(true); if (!result.ok) return;
  const title = result.value.unit.fields.title; if (!title || title.kind !== "string") throw new Error("expected string title"); const changed = { ...result.value.unit, fields: { ...result.value.unit.fields, title: { ...title, value: "B" } } }; expect(computeCompiledUnitContentDigest(changed, result.value.projections)).not.toBe(result.value.meta.contentDigest);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "generic-stale-digest-")); try { expect(() => emitCompiledUnit({ ...result.value, meta: { ...result.value.meta, contentDigest: "sha256:" + "0".repeat(64) } }, dir)).toThrow("metadata digest"); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("generic compiler diagnoses non-units and invalid projection selection", () => {
  expect(compileUnit('fact X { statement: "x" }', model, context).ok).toBe(false);
  const duplicate = compileUnit('unit T1 : Ticket { title: "A" }', model, context, { projections: ["summary", "summary", "missing"] });
  expect(duplicate.ok).toBe(false); if (!duplicate.ok) expect(duplicate.diagnostics.map(x => x.code)).toEqual(expect.arrayContaining(["DUPLICATE_PROJECTION", "UNKNOWN_PROJECTION"]));
});
test("unsafe model projection names return diagnostics instead of throwing", () => {
  const unsafe: ProjectionDefinition = { kind: "projection", name: "bad/name", version: "1.0.0", targetTokens: 1, include: ["*"], exclude: [], typeGroups: {}, rules: [] };
  const result = compileUnit('unit T9 : Ticket { title: "A" }', { ...model, definitions: [...model.definitions, unsafe] } as LoadedModel, context, { projections: ["bad/name"] }); expect(result.ok).toBe(false); if (!result.ok) expect(result.diagnostics.map(x => x.code)).toContain("UNSAFE_PROJECTION_NAME");
});
test("relation attribute key insertion order does not affect digest", () => {
  const result = compileUnit('unit T10 : Ticket { title: "A" }', model, context); if (!result.ok) throw new Error("compile"); const base = result.value.unit; const left = { ...base, relations: [{ id: "r", relationRef: "x", from: "T10", to: "y", attributes: { b: { z: 1, a: 2 }, a: true } }] }; const right = { ...base, relations: [{ id: "r", relationRef: "x", from: "T10", to: "y", attributes: { a: true, b: { a: 2, z: 1 } } }] }; expect(computeCompiledUnitContentDigest(left, result.value.projections)).toBe(computeCompiledUnitContentDigest(right, result.value.projections));
});
test("emitter rejects lexical symlink ancestors before creating a child", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "generic-ancestor-")); const link = join(base, "link"); const outside = mkdtempSync(join(realpathSync(tmpdir()), "generic-outside-"));
  try { const result = compileUnit('unit T8 : Ticket { title: "A" }', model, context); if (!result.ok) throw new Error("compile"); symlinkSync(outside, link); expect(() => emitCompiledUnit(result.value, join(link, "new-child"))).toThrow("symlink ancestor"); expect(require("node:fs").existsSync(join(outside, "new-child"))).toBe(false); const final = join(outside, "existing"); require("node:fs").mkdirSync(final); expect(() => emitCompiledUnit(result.value, join(link, "existing"))).toThrow("symlink ancestor"); }
  finally { rmSync(base, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

// ─── ADR-1 architecture proof ──────────────────────────────────────────────
//
// A complete domain the engine has never seen, declared entirely in data and
// never mentioned in any Core source file. If this test ever needs a Core edit
// to pass, the refactor has regressed (plan §21's judgement criterion).

test("a domain Core has never heard of parses, normalizes and compiles with no engine edit", () => {
  const widgetModel: LoadedModel = {
    root: "/virtual/widget-model",
    manifest: { protocol: "prime/model/v2", name: "widget-shop", version: "1.0.0", files: ["types.yaml"] },
    definitions: [
      { kind: "type", name: "Widget", version: "1.0.0", additionalFields: "reject", fields: [
        { name: "sku", typeRef: "string", required: true },
        { name: "weightGrams", typeRef: "number" },
        { name: "discontinued", typeRef: "boolean" },
        { name: "supplier", typeRef: "Supplier" },
      ] },
      { kind: "type", name: "Supplier", version: "1.0.0", additionalFields: "reject", fields: [{ name: "sku", typeRef: "string" }] },
      { kind: "projection", name: "tool-signature", version: "1.0.0", targetTokens: 40, include: ["meta.typeRef", "sku"], exclude: [], typeGroups: { catalogue: ["Widget"] }, rules: [{ typeRef: "group:catalogue", include: ["weightGrams"] }] },
    ],
  };

  // Both spellings of the type reference: bare, and qualified by the model name.
  for (const typeRef of ["Widget", "@widget-shop/Widget"]) {
    const result = compileUnit(
      `unit W1 : ${typeRef} { sku: "WID-1" weightGrams: 340 discontinued: false supplier: Supplier.acme }`,
      widgetModel,
      { corpus: "widgets", version: "1.0.0", digest: "sha256:" + "b".repeat(64) },
      { projections: ["tool-signature"] },
    );
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.unit.typeRef).toBe("Widget");
    const content = result.value.projections["tool-signature"]!.content;
    // The projection the model declared is honoured: included fields present,
    // undeclared ones absent — no engine-side knowledge of "Widget" involved.
    expect(content).toContain('sku: "WID-1"');
    expect(content).toContain("weightGrams: 340");
    expect(content).not.toContain("discontinued");
  }

  // The closed schema is the model's, so the model's own errors surface.
  const bad = compileUnit('unit W2 : @widget-shop/Widget { colour: "red" }', widgetModel, { corpus: "widgets", version: "1.0.0", digest: "sha256:" + "c".repeat(64) }, { projections: ["tool-signature"] });
  expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.diagnostics.map(x => x.code)).toEqual(expect.arrayContaining(["UNKNOWN_FIELD", "MISSING_REQUIRED_FIELD"]));

  // A reference into a model that is not loaded is refused rather than guessed.
  const foreign = compileUnit('unit W3 : @some-other-shop/Widget { sku: "WID-3" }', widgetModel, { corpus: "widgets", version: "1.0.0", digest: "sha256:" + "d".repeat(64) }, { projections: ["tool-signature"] });
  expect(foreign.ok).toBe(false); if (!foreign.ok) expect(foreign.diagnostics.map(x => x.code)).toContain("FOREIGN_MODEL_TYPE_REF");
});
