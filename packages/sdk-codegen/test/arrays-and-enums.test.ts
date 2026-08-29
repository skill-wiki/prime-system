/**
 * Array and enum emission (L14-D), on both emitters.
 *
 * The point of the assertions here is the DIFFERENCE from what the emitters did
 * before: `unknown` emitted `{}` (every shape accepted) and a list had to be
 * declared that way, so the schema a client validated against permitted a call the
 * handler was going to refuse. `unknown[]` is `{"type":"array","items":{}}`, which
 * is a real constraint, and an enum reaches the client as `enum` and the generated
 * SDK as a literal union.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import { buildCodegenSchema, emitMcpTools, emitTypes, generateSdk, parseTypeRef, typeScriptNames } from "../src/index.ts";

const roots: string[] = [];

function model(definitions: string) {
  const root = mkdtempSync(join(tmpdir(), "sdk-codegen-arrays-"));
  roots.push(root);
  writeFileSync(join(root, "prime-model.yaml"), "protocol: prime/model/v2\nname: probe\nversion: 1.0.0\nfiles: [d.yaml]\n");
  writeFileSync(join(root, "d.yaml"), `kind: definitions\nversion: 1.0.0\ndefinitions: ${definitions}\n`);
  return buildCodegenSchema(loadModelOrThrow(root));
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const SHAPES = "[{kind: type, name: Leaf, version: 1.0.0, fields: [{name: k, typeRef: string}]}, "
  + "{kind: type, name: Shapes, version: 1.0.0, additionalFields: reject, fields: ["
  + "{name: words, typeRef: \"string[]\", required: true}, "
  + "{name: opaque, typeRef: unknown, required: true}, "
  + "{name: opaqueList, typeRef: \"unknown[]\", required: true}, "
  + "{name: leaves, typeRef: \"Leaf[]\", required: true}, "
  + "{name: grid, typeRef: \"number[][]\", required: true}, "
  + "{name: level, typeRef: string, required: true, enum: [low, high]}, "
  + "{name: levels, typeRef: \"string[]\", required: false, enum: [a, b, c]}]}]";

describe("JSON Schema follows the declared arity", () => {
  const document = emitMcpTools(model(SHAPES), "probe");
  const properties = (document.$defs.Shapes as { properties: Record<string, Record<string, unknown>> }).properties;

  test("a builtin element becomes items, not a bare type", () => {
    expect(properties.words).toEqual({ type: "array", items: { type: "string" } });
  });

  /** The whole reason arrays were added: these two used to be the same schema. */
  test("`unknown[]` constrains the container even though the element is unconstrained", () => {
    expect(properties.opaque).toEqual({});
    expect(properties.opaqueList).toEqual({ type: "array", items: {} });
  });

  test("a declared element stays a $ref, so a self-referential type still terminates", () => {
    expect(properties.leaves).toEqual({ type: "array", items: { $ref: "#/$defs/Leaf" } });
  });

  test("nesting wraps once per level", () => {
    expect(properties.grid).toEqual({ type: "array", items: { type: "array", items: { type: "number" } } });
  });

  test("an enum reaches the client as `enum`, and on the ITEM of an array", () => {
    expect(properties.level).toEqual({ type: "string", enum: ["low", "high"] });
    expect(properties.levels).toEqual({ type: "array", items: { type: "string", enum: ["a", "b", "c"] } });
  });

  test("an array field is still required-tracked independently of its arity", () => {
    expect((document.$defs.Shapes as { required: string[] }).required).toEqual([
      "words", "opaque", "opaqueList", "leaves", "grid", "level",
    ]);
  });
});

describe("emitted TypeScript follows the declared arity", () => {
  const schema = model(SHAPES);
  const types = emitTypes(schema, typeScriptNames(schema.schema));

  test.each([
    ["words", "readonly words: readonly string[];"],
    ["opaque", "readonly opaque: unknown;"],
    ["opaqueList", "readonly opaqueList: readonly unknown[];"],
    ["leaves", "readonly leaves: readonly Leaf[];"],
    // `readonly (readonly number[])[]`, not `readonly readonly number[][]` — the
    // second does not parse, and only compiling the emitted bytes catches that.
    ["grid", "readonly grid: readonly (readonly number[])[];"],
    ["level", 'readonly level: "low" | "high";'],
    ["levels", 'readonly levels?: readonly ("a" | "b" | "c")[];'],
  ])("%s", (_name, line) => {
    expect(types).toContain(line);
  });
});

describe("an action's own input and output carry arity too", () => {
  const schema = model(
    "[{kind: type, name: Leaf, version: 1.0.0, fields: [{name: k, typeRef: string}]}, "
    + "{kind: action, name: fetch, version: 1.0.0, output: \"Leaf[]\", sideEffects: read, idempotency: idempotent, approval: never, provider: p, "
    + "inputs: [{name: ids, typeRef: \"string[]\", required: true}, {name: mode, typeRef: string, required: false, enum: [fast, full]}]}]",
  );
  const document = emitMcpTools(schema, "probe");
  const tool = document.tools[0]!;

  test("the input schema is an array of strings plus an enum", () => {
    const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties.ids).toEqual({ type: "array", items: { type: "string" } });
    expect(properties.mode).toEqual({ type: "string", enum: ["fast", "full"] });
  });

  test("the output schema is an array of $refs", () => {
    expect(tool.outputSchema).toEqual({ type: "array", items: { $ref: "#/$defs/Leaf" } });
  });

  test("the generated Output alias is the array type", () => {
    const types = emitTypes(schema, typeScriptNames(schema.schema));
    expect(types).toContain("export type FetchOutput = readonly Leaf[];");
  });
});

describe("the grammar is one authority, shared with the loader", () => {
  test("parseTypeRef is re-exported rather than re-implemented in the emitters", () => {
    expect(parseTypeRef("Leaf[][]")).toEqual({ element: "Leaf", arrayDepth: 2 });
  });

  /**
   * The enum values are sidecar data, not IR: the digest must not move when a value
   * set is corrected, or every generated artifact in the tree would need
   * regenerating for a change no consumer of the IR can see.
   */
  test("adding an enum to a field does not move the model digest", () => {
    const bare = generateSdk(loadModelOrThrow(rootFor("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string}]}]")));
    const enumed = generateSdk(loadModelOrThrow(rootFor("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string, enum: [p, q]}]}]")));
    expect(enumed.modelDigest).toBe(bare.modelDigest);
    // …but the artifacts DO differ, which is what makes the sidecar visible rather than lost.
    expect(enumed.files.find(f => f.path === "types.ts")!.content).not.toBe(
      bare.files.find(f => f.path === "types.ts")!.content,
    );
  });

  /** An array suffix, by contrast, IS part of the ref and so must move the digest. */
  test("changing arity moves the digest, because the IR ref changed", () => {
    const scalar = generateSdk(loadModelOrThrow(rootFor("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: string}]}]")));
    const list = generateSdk(loadModelOrThrow(rootFor("[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: \"string[]\"}]}]")));
    expect(list.modelDigest).not.toBe(scalar.modelDigest);
  });
});

function rootFor(definitions: string): string {
  const root = mkdtempSync(join(tmpdir(), "sdk-codegen-digest-"));
  roots.push(root);
  writeFileSync(join(root, "prime-model.yaml"), "protocol: prime/model/v2\nname: probe\nversion: 1.0.0\nfiles: [d.yaml]\n");
  writeFileSync(join(root, "d.yaml"), `kind: definitions\nversion: 1.0.0\ndefinitions: ${definitions}\n`);
  return root;
}
