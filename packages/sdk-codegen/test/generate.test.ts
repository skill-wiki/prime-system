/**
 * Generation against the two real Model Packages, and the compile check that
 * `MC-SDK-COMPILE` needs.
 *
 * The compile step shells out to the repo's own `tsc` rather than trusting that
 * "it type-checks in my head": the acceptance is that the *emitted bytes* compile,
 * and a template can be wrong in ways only a compiler finds (a missing import, a
 * property name that needs quoting, a type referenced before it is declared).
 *
 * Output goes under this package's own directory, not `os.tmpdir()`, because the
 * generated `client.ts` imports `@aoe/sdk` and module resolution has to be
 * able to walk up to `packages/sdk-codegen/node_modules`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadModelOrThrow, type LoadedModel } from "@aoe/model-schema";
import { assertSchemaDigestSelfConsistent, generateSdk, type GeneratedSdk } from "../src/index.ts";

const REPO = resolve(import.meta.dir, "../../..");
const SCRATCH_ROOT = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(SCRATCH_ROOT, ".codegen-compile-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface ModelCase { readonly label: string; readonly root: string }

const MODELS: ModelCase[] = [
  { label: "prime-v1-model", root: join(REPO, "compat/prime-v1-model") },
  { label: "security-model", root: join(REPO, "packages/testkit/fixtures/security-model") },
];

function compile(label: string, generated: GeneratedSdk): { readonly code: number; readonly output: string } {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });
  for (const file of generated.files) writeFileSync(join(dir, file.path), file.content, "utf8");
  const tsconfig = join(dir, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: join(REPO, "tsconfig.json"),
      compilerOptions: { noEmit: true },
      include: ["*.ts"],
    }),
    "utf8",
  );
  const result = Bun.spawnSync(["npx", "tsc", "--noEmit", "-p", tsconfig], { cwd: REPO });
  return { code: result.exitCode ?? -1, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

describe.each(MODELS)("generating from the real $label Model Package", ({ label, root }) => {
  let model: LoadedModel;
  let generated: GeneratedSdk;

  test("the model loads and generation produces every artifact", () => {
    model = loadModelOrThrow(root);
    generated = generateSdk(model);
    expect(generated.files.map(file => file.path).sort()).toEqual([
      "client.ts",
      "mcp-tools.json",
      "schema.json",
      "types.ts",
    ]);
    expect(generated.modelDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("SchemaIR covers every definition the model declares", () => {
    const counted = (kind: string) => model.definitions.filter(definition => definition.kind === kind).length;
    const schema = generated.schema.schema;
    expect(Object.keys(schema.types).length).toBe(counted("type"));
    expect(Object.keys(schema.relations).length).toBe(counted("relation"));
    expect(Object.keys(schema.functions).length).toBe(counted("function"));
    expect(Object.keys(schema.actions).length).toBe(counted("action"));
    expect(Object.keys(schema.projections).length).toBe(counted("projection"));
    expect(Object.keys(schema.retrievalProfiles).length).toBe(counted("retrieval-profile"));
    expect(schema.protocolVersion).toBe(model.manifest.protocol);
  });

  test("one MCP tool per declared action, and no tool without one", () => {
    const actionNames = model.definitions.filter(d => d.kind === "action").map(d => d.name);
    expect(generated.mcp.tools.length).toBe(actionNames.length);
    expect(generated.mcp.model.digest).toBe(generated.modelDigest);
  });

  test("the emitted TypeScript compiles", () => {
    const result = compile(label, generated);
    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  }, 60_000);

  test("the digest is stable across regeneration and self-consistent", () => {
    expect(generateSdk(loadModelOrThrow(root)).modelDigest).toBe(generated.modelDigest);
    assertSchemaDigestSelfConsistent(generated.schema.schema);
  });
});

describe("the two models are distinguishable", () => {
  test("different models produce different digests and different tool prefixes", () => {
    const [first, second] = MODELS.map(entry => generateSdk(loadModelOrThrow(entry.root)));
    expect(first!.modelDigest).not.toBe(second!.modelDigest);
    const prefixes = new Set(second!.mcp.tools.map(tool => tool.name.split("_")[0]));
    expect(prefixes.size).toBe(1);
    expect([...prefixes][0]).not.toBe("");
  });
});
