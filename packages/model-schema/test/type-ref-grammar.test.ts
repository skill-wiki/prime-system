/**
 * The array `typeRef` grammar and the field `enum` (L14-D).
 *
 * These are load-bearing for validation rather than for convenience: before them a
 * field holding a list had to be declared `unknown`, which emits the empty JSON
 * Schema `{}` and accepts every shape, or squeezed through a comma-separated
 * `string`. So the assertions below are about what is now REFUSED — an accepted
 * malformed ref is the failure mode that ships.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModel, parseTypeRef } from "../src/index.ts";

const roots: string[] = [];

function fixture(definitions: string): string {
  const root = mkdtempSync(join(tmpdir(), "model-schema-typeref-"));
  roots.push(root);
  writeFileSync(join(root, "prime-model.yaml"), "protocol: prime/model/v2\nname: x\nversion: 1.0.0\nfiles: [d.yaml]\n");
  writeFileSync(join(root, "d.yaml"), `kind: definitions\nversion: 1.0.0\ndefinitions: ${definitions}\n`);
  return root;
}

const codes = (definitions: string): readonly string[] => {
  const result = loadModel(fixture(definitions));
  return result.ok ? [] : result.diagnostics.map(d => d.code);
};

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("parseTypeRef is the one place the grammar lives", () => {
  test.each([
    ["string", "string", 0],
    ["string[]", "string", 1],
    ["Foo[][]", "Foo", 2],
    ["generic:list", "generic:list", 0],
    ["*", "*", 0],
  ])("%s", (ref, element, arrayDepth) => {
    expect(parseTypeRef(ref)).toEqual({ element, arrayDepth });
  });

  test.each([["[]"], ["[]string"], ["Foo[]bar"], ["Foo["], ["Foo]"]])("%s is malformed, not a scalar named that", ref => {
    expect(parseTypeRef(ref)).toBeUndefined();
  });
});

describe("an array typeRef resolves through its element", () => {
  test("a declared element and every builtin element load", () => {
    const result = loadModel(fixture(
      "[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: \"string[]\"}, {name: b, typeRef: \"unknown[]\"}, {name: c, typeRef: \"X[][]\"}]}]",
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const type = result.value.definitions[0]!;
    // The suffix survives on the declaration: the loader resolves through it
    // without rewriting it, so a downstream emitter still sees the arity.
    expect(type.kind === "type" && type.fields.map(f => f.typeRef)).toEqual(["string[]", "unknown[]", "X[][]"]);
  });

  test("a dangling element is caught through the suffix rather than hidden by it", () => {
    expect(codes("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: \"Missing[]\"}]}]"))
      .toContain("DANGLING_TYPE_REF");
  });

  test("a malformed ref is a diagnostic, not a type named `Foo[`", () => {
    expect(codes("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: \"[]\"}]}]"))
      .toContain("INVALID_TYPE_REF");
  });

  test("an action input and output both accept an array", () => {
    const result = loadModel(fixture(
      "[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string}]}, "
      + "{kind: action, name: act, version: 1.0.0, output: \"X[]\", sideEffects: read, idempotency: idempotent, approval: never, provider: p, inputs: [{name: ids, typeRef: \"string[]\"}]}]",
    ));
    expect(result.ok).toBe(true);
  });

  /**
   * A relation endpoint, a projection type group member and a projection rule's
   * `typeRef` NAME a type the engine indexes by. `Foo[]` there is not a shape the
   * engine can honour, so accepting it would be a declaration with no effect.
   */
  test("a position that names a type refuses an array", () => {
    const relation = codes(
      "[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string}]}, "
      + "{kind: relation, name: r, version: 1.0.0, from: \"X[]\", to: X, cardinality: one-to-one, directional: true, "
      + "semantics: {traversal: none, selection: informational, loadOrder: none, cyclePolicy: allow, conflictSeverity: none}}]",
    );
    expect(relation).toContain("ARRAY_TYPE_REF_NOT_ALLOWED");
    const group = codes(
      "[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string}]}, "
      + "{kind: projection, name: p, version: 1.0.0, targetTokens: 1, typeGroups: {g: [\"X[]\"]}}]",
    );
    expect(group).toContain("ARRAY_TYPE_REF_NOT_ALLOWED");
  });
});

describe("an enum declares a value set the runtime can keep", () => {
  test("values load and stay in declaration order", () => {
    const result = loadModel(fixture(
      "[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string, enum: [low, med, high]}, {name: b, typeRef: \"string[]\", enum: [x, y]}]}]",
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const type = result.value.definitions[0]!;
    expect(type.kind === "type" && type.fields.map(f => f.enum)).toEqual([["low", "med", "high"], ["x", "y"]]);
  });

  test("an enum on a non-string element is refused rather than emitted as a string enum", () => {
    expect(codes("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: integer, enum: [\"1\", \"2\"]}]}]"))
      .toContain("ENUM_ON_NON_STRING_TYPE");
    expect(codes(
      "[{kind: type, name: Y, version: 1.0.0, fields: [{name: q, typeRef: string}]}, "
      + "{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: \"Y[]\", enum: [p]}]}]",
    )).toContain("ENUM_ON_NON_STRING_TYPE");
  });

  test("a repeated value is a diagnostic: a duplicated member is a mistake, never a wider set", () => {
    expect(codes("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string, enum: [x, x]}]}]"))
      .toContain("DUPLICATE_ENUM_VALUE");
  });

  test("an empty enum is refused by the schema: `enum: []` would declare a field no value satisfies", () => {
    expect(codes("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string, enum: []}]}]"))
      .toContain("INVALID_DEFINITION_FILE");
  });

  test("an unknown sibling key is still refused, so `enum` did not open the field shape", () => {
    expect(codes("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string, values: [x]}]}]"))
      .toContain("INVALID_DEFINITION_FILE");
  });
});
