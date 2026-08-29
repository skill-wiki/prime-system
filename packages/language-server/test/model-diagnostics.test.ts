/**
 * §14.1 third capability: external model/schema diagnostics.
 *
 * Every expectation below is a consequence of the fixture model's own
 * declarations, never of a name known to this package.
 */

import { describe, test, expect } from "bun:test";
import { createLanguageServer } from "../src/index";
import { loadModelState, ModelIndex } from "../src/model-index";
import { writeBrokenModelFixture, writeModelFixture } from "./model-fixture";

const model = writeModelFixture();
const URI = "file:///tmp/doc.prime";

function serve(source: string, modelRoot: string = model.root) {
  const server = createLanguageServer({ modelRoot });
  server.openDocument(URI, source);
  return server;
}

/** No `modelRoot` at all — distinct from passing `undefined` into a defaulted parameter. */
function serveWithoutModel(source: string) {
  const server = createLanguageServer();
  server.openDocument(URI, source);
  return server;
}

describe("ModelIndex", () => {
  test("indexes only type definitions, sorted", () => {
    const state = loadModelState(model.root);
    expect(state.kind).toBe("loaded");
    const index = (state as { index: ModelIndex }).index;
    expect(index.typeNames).toEqual(["capsule", "container"]);
    expect(index.modelName).toBe("fixture-model");
  });

  test("resolves a bare and a correctly qualified reference", () => {
    const index = (loadModelState(model.root) as { index: ModelIndex }).index;
    expect(index.resolveType("container")?.version).toBe("1.0.0");
    expect(index.resolveType("@fixture-model/container")?.name).toBe("container");
  });

  test("refuses a reference qualified with a different model rather than falling through", () => {
    const index = (loadModelState(model.root) as { index: ModelIndex }).index;
    expect(index.resolveType("@other-model/container")).toBeUndefined();
    expect(index.resolveType("@no-separator")).toBeUndefined();
  });

  test("flattens fields with required defaulting to false", () => {
    const index = (loadModelState(model.root) as { index: ModelIndex }).index;
    const fields = index.fieldsOf(index.resolveType("container")!);
    expect(fields.map(field => [field.name, field.required])).toEqual([
      ["label", true],
      ["note", false],
    ]);
    expect(fields[0]!.description).toBe("The container label");
  });
});

describe("model diagnostics", () => {
  test("accepts a declaration that satisfies its type", () => {
    const lsp = serve(`container Thing {\n  label: "a thing"\n  note: "optional"\n}\n`).diagnostics(URI);
    expect(lsp.model).toEqual([]);
    expect(lsp.modelOutcome).toEqual({ kind: "checked", typeName: "container" });
  });

  test("reports a type the model does not declare, listing the ones it does", () => {
    const lsp = serve(`absent Thing {\n  label: "a"\n}\n`).diagnostics(URI);
    expect(lsp.model.length).toBe(1);
    expect(lsp.model[0]!.code).toBe("UNKNOWN_TYPE");
    expect(lsp.model[0]!.message).toContain(`declares no type "absent"`);
    expect(lsp.model[0]!.suggestion).toContain("capsule, container");
    expect(lsp.model[0]!.range.start.line).toBe(0);
  });

  test("reports an undeclared field when the type rejects additional fields", () => {
    const lsp = serve(`container Thing {\n  label: "a"\n  stray: "b"\n}\n`).diagnostics(URI);
    expect(lsp.model.map(entry => entry.code)).toEqual(["UNKNOWN_FIELD"]);
    expect(lsp.model[0]!.message).toContain(`"stray"`);
    expect(lsp.model[0]!.range.start.line).toBe(2);
  });

  test("allows an undeclared field when the type declares additionalFields: unknown", () => {
    const lsp = serve(`capsule Thing {\n  label: "a"\n  stray: "b"\n}\n`).diagnostics(URI);
    expect(lsp.model).toEqual([]);
  });

  test("reports a missing required field at the declaration line", () => {
    const lsp = serve(`container Thing {\n  note: "only the optional one"\n}\n`).diagnostics(URI);
    expect(lsp.model.map(entry => entry.code)).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(lsp.model[0]!.message).toContain(`"label"`);
    expect(lsp.model[0]!.suggestion).toBe("Add label: <string>");
    expect(lsp.model[0]!.range.start.line).toBe(0);
  });

  test("checks a generic unit declaration through its qualified type reference", () => {
    const lsp = serve(`unit Thing : @fixture-model/container {\n  note: "no label"\n}\n`).diagnostics(URI);
    expect(lsp.model.map(entry => entry.code)).toEqual(["MISSING_REQUIRED_FIELD"]);
    expect(lsp.modelOutcome).toEqual({ kind: "checked", typeName: "container" });
  });

  test("skips the legacy extends form, which names a base and not a model type", () => {
    const lsp = serve(`prime Thing extends Container {\n  name: "thing"\n  version: "1.0.0"\n}\n`).diagnostics(URI);
    expect(lsp.model).toEqual([]);
    expect(lsp.modelOutcome).toEqual({ kind: "skipped", reason: "legacy-extends-form" });
  });

  test("skips model checking while the document has syntax errors", () => {
    const lsp = serve(`container Thing {\n  label "missing colon"\n`).diagnostics(URI);
    expect(lsp.model).toEqual([]);
    expect(lsp.modelOutcome).toEqual({ kind: "skipped", reason: "syntax-errors" });
    expect(lsp.compile.length).toBeGreaterThan(0);
  });

  test("skips model checking when no model is configured", () => {
    const lsp = serveWithoutModel(`container Thing {\n  label: "a"\n}\n`).diagnostics(URI);
    expect(lsp.model).toEqual([]);
    expect(lsp.modelOutcome).toEqual({ kind: "skipped", reason: "no-model" });
  });

  test("reports an invalid model package once, at the document start, instead of per unit", () => {
    const broken = writeBrokenModelFixture();
    const lsp = serve(`container Thing {\n  label: "a"\n}\n`, broken.root).diagnostics(URI);
    expect(lsp.modelOutcome).toEqual({ kind: "skipped", reason: "invalid-model" });
    expect(lsp.model.length).toBeGreaterThan(0);
    expect(lsp.model.every(entry => entry.range.start.line === 0)).toBe(true);
    expect(lsp.model[0]!.message).toContain("is invalid");
  });

  test("reloadModel re-reads the package", () => {
    const server = createLanguageServer({ modelRoot: model.root });
    expect(server.reloadModel().kind).toBe("loaded");
    expect(server.model.kind).toBe("loaded");
  });
});
