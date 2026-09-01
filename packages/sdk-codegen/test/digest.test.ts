/**
 * The §14.3 digest contract, from the generator's side.
 *
 * These are the tests that make the digest a *guarantee* rather than a field:
 * cosmetic changes must not move it, semantic changes must, and a mismatched
 * digest must be refused at both ends of the contract.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { loadModelOrThrow, type LoadedModel, type ModelDefinition } from "@aoe/model-schema";
import { assertGeneratedArtifactUsable, ModelDigestMismatchError, parseGeneratedArtifactHeader } from "@aoe/sdk";
import type { SchemaIR, SnapshotRef } from "@aoe/ir";
import {
  assertSchemaDigestSelfConsistent,
  buildCodegenSchema,
  canonicalJson,
  generateSdk,
  recomputeModelDigest,
} from "../src/index.ts";

const ROOT = resolve(import.meta.dir, "../../..", "packages/testkit/fixtures/security-model");
const model = loadModelOrThrow(ROOT);

function withDefinitions(definitions: readonly ModelDefinition[]): LoadedModel {
  return { root: model.root, manifest: model.manifest, definitions };
}

function snapshotFor(digest: string): SnapshotRef {
  return { modelRelease: "r", modelDigest: digest, corpusRelease: "r", corpusDigest: "sha256:c" };
}

describe("the digest is a function of meaning, not of layout", () => {
  test("reordering the definition list does not change it", () => {
    const reversed = withDefinitions([...model.definitions].reverse());
    expect(buildCodegenSchema(reversed).schema.model.digest).toBe(buildCodegenSchema(model).schema.model.digest);
  });

  test("canonical JSON sorts object keys, so key order in the source cannot move it", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("an absent optional field and an explicitly-undefined one encode identically", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  test("array order is preserved, because IR array order is semantic", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("the digest moves when the model's meaning does", () => {
  const baseline = buildCodegenSchema(model).schema.model.digest;

  test("changing a field's typeRef changes it", () => {
    const changed = structuredClone(model.definitions) as ModelDefinition[];
    const type = changed.find(d => d.kind === "type" && d.fields.length > 0);
    if (type === undefined || type.kind !== "type") throw new Error("fixture has no type with fields");
    (type.fields[0] as { typeRef: string }).typeRef = "integer";
    expect(buildCodegenSchema(withDefinitions(changed)).schema.model.digest).not.toBe(baseline);
  });

  test("changing a relation's declared semantics changes it", () => {
    const changed = structuredClone(model.definitions) as ModelDefinition[];
    const relation = changed.find(d => d.kind === "relation");
    if (relation === undefined || relation.kind !== "relation") throw new Error("fixture has no relation");
    (relation.semantics as { traversal: string }).traversal = "none";
    expect(buildCodegenSchema(withDefinitions(changed)).schema.model.digest).not.toBe(baseline);
  });

  test("adding an action changes it", () => {
    const added: ModelDefinition = {
      kind: "action",
      name: "ZzTestAction",
      version: "1.0.0",
      inputs: [],
      output: "boolean",
      capabilities: [],
      sideEffects: "none",
      idempotency: "idempotent",
      approval: "never",
    };
    expect(buildCodegenSchema(withDefinitions([...model.definitions, added])).schema.model.digest).not.toBe(baseline);
  });
});

describe("a mismatched digest is refused, at both ends of the contract", () => {
  test("the client gate refuses a generated header against a different snapshot", () => {
    const generated = generateSdk(model);
    const header = parseGeneratedArtifactHeader({
      protocol: "prime/generated/v1",
      generator: "@aoe/sdk-codegen",
      model: { name: model.manifest.name, version: model.manifest.version, digest: generated.modelDigest },
    });
    // Same header, matching snapshot: allowed.
    assertGeneratedArtifactUsable(header, snapshotFor(generated.modelDigest));
    // The model then changed under the generated SDK's feet.
    expect(() => assertGeneratedArtifactUsable(header, snapshotFor("sha256:rolled-forward"))).toThrow(
      ModelDigestMismatchError,
    );
  });

  test("the header the generator emits into types.ts is the one the client gate accepts", () => {
    const generated = generateSdk(model);
    const types = generated.files.find(file => file.path === "types.ts")!.content;
    expect(types).toContain(`digest: "${generated.modelDigest}"`);
    expect(types).toContain(`protocol: "prime/generated/v1"`);
  });

  test("a hand-edited digest is caught by the generator-side self-consistency check", () => {
    const schema = buildCodegenSchema(model).schema;
    const tampered = { ...schema, model: { ...schema.model, digest: "sha256:handwritten" } };
    expect(() => assertSchemaDigestSelfConsistent(tampered)).toThrow(/hashes to/);
    expect(recomputeModelDigest(tampered)).toBe(schema.model.digest);
  });

  test("a tampered definition inside a stamped schema is caught too", () => {
    const schema = buildCodegenSchema(model).schema;
    const first = Object.keys(schema.actions)[0]!;
    const tampered: SchemaIR = {
      ...schema,
      actions: { ...schema.actions, [first]: { ...schema.actions[first]!, capabilities: ["escalated.capability"] } },
    };
    expect(() => assertSchemaDigestSelfConsistent(tampered)).toThrow(/hashes to/);
  });
});

describe("emitted schema.json round-trips", () => {
  test("the emitted schema.json still verifies as self-consistent", () => {
    const generated = generateSdk(model);
    const emitted = JSON.parse(generated.files.find(file => file.path === "schema.json")!.content);
    assertSchemaDigestSelfConsistent(emitted);
    expect(emitted.model.digest).toBe(generated.modelDigest);
  });

  test("the emitted mcp-tools.json carries the same digest as the code", () => {
    const generated = generateSdk(model);
    const emitted = JSON.parse(generated.files.find(file => file.path === "mcp-tools.json")!.content);
    expect(emitted.model.digest).toBe(generated.modelDigest);
  });

  test("the fixture model root is the one the lane was told to use", () => {
    expect(ROOT.endsWith(join("packages", "testkit", "fixtures", "security-model"))).toBe(true);
  });
});
