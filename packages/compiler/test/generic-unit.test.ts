import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import type { LoadedModel, ProjectionDefinition } from "@skill-wiki/model-schema";
import { ATOM_KINDS } from "@skill-wiki/types";
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
  expect(ATOM_KINDS.includes("Ticket" as never)).toBe(false);
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
