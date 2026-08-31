/**
 * Model-lock verification (plan §8.4 "Model lock 完整性", §8.5).
 *
 * The property under test is not "the lock parses" but "a corpus cannot be served
 * by a model it was not sealed against". Every assertion below is therefore about
 * a *relation* between two artifacts — the lock, the manifest and the loaded
 * model — never about a frozen digest value.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadServeModel, resolveModelRoot } from "../src/model-context";
import { createModelLock } from "@skill-wiki/model-schema";
import {
  MODEL_LOCK_FILE,
  ModelLockError,
  computeModelSchemaDigest,
  parseModelLock,
  verifyModelLock,
} from "../src/model-lock";

const CORPUS = resolve(join(import.meta.dir, "../../../examples/hello-world/primes/compiled"));
const MODEL = loadServeModel(resolveModelRoot(CORPUS, {}));
const SCHEMA_DIGEST = computeModelSchemaDigest(MODEL.model.definitions);
const GENERATED_ENTRY = createModelLock(MODEL.model).models[0]!;

function lockEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...GENERATED_ENTRY,
    ...overrides,
  };
}

/** Run `verifyModelLock` against a throwaway bundle root holding just a lock. */
function withLock<T>(
  lock: unknown,
  body: (root: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), "w10a-lock-"));
  try {
    if (lock !== undefined) {
      writeFileSync(join(root, MODEL_LOCK_FILE), typeof lock === "string" ? lock : JSON.stringify(lock), "utf8");
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("computeModelSchemaDigest", () => {
  it("is independent of definition order, so a file reshuffle does not invalidate a corpus", () => {
    const forward = computeModelSchemaDigest(MODEL.model.definitions);
    const reversed = computeModelSchemaDigest([...MODEL.model.definitions].reverse());
    expect(reversed).toBe(forward);
  });

  it("changes when a definition changes, so a silently edited model is detectable", () => {
    const [first, ...rest] = MODEL.model.definitions;
    const mutated = [{ ...first!, name: `${first!.name}-edited` }, ...rest];
    expect(computeModelSchemaDigest(mutated)).not.toBe(SCHEMA_DIGEST);
  });
});

describe("parseModelLock", () => {
  it("accepts a well-formed lock", () => {
    const lock = parseModelLock({ lockVersion: "1", models: [lockEntry()] });
    expect(lock.models).toHaveLength(1);
    expect(lock.models[0]!.schemaDigest).toBe(SCHEMA_DIGEST);
  });

  it("rejects an unsupported lockVersion instead of guessing the shape", () => {
    expect(() => parseModelLock({ lockVersion: "2", models: [lockEntry()] }))
      .toThrow(/lockVersion/);
  });

  for (const [label, value] of [
    ["a non-object", "not-an-object"],
    ["an array", [] as unknown],
    ["an empty models array", { lockVersion: "1", models: [] }],
    ["a missing models array", { lockVersion: "1" }],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => parseModelLock(value)).toThrow(ModelLockError);
    });
  }

  it("rejects a non-canonical digest, so a truncated hash cannot pass as a pin", () => {
    expect(() => parseModelLock({ lockVersion: "1", models: [lockEntry({ schemaDigest: "sha256:abc" })] }))
      .toThrow(/canonical sha256/);
  });

  it("rejects a lock that pins the same model twice", () => {
    expect(() => parseModelLock({ lockVersion: "1", models: [lockEntry(), lockEntry()] }))
      .toThrow(/twice/);
  });

  it("rejects a model entry with no files", () => {
    expect(() => parseModelLock({ lockVersion: "1", models: [lockEntry({ files: [] })] }))
      .toThrow(/files/);
  });
});

describe("verifyModelLock", () => {
  it("warns rather than fails when a bundle predates the lock", () => {
    const diagnostics = withLock(undefined, (root) =>
      verifyModelLock({ bundleRoot: root, model: MODEL.model }));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("MODEL_LOCK_MISSING");
    expect(diagnostics[0]!.severity).toBe("warning");
  });

  it("passes silently when the loaded model is the locked one", () => {
    const diagnostics = withLock({ lockVersion: "1", models: [lockEntry()] }, (root) =>
      verifyModelLock({ bundleRoot: root, model: MODEL.model }));
    expect(diagnostics).toEqual([]);
  });

  it("fails closed when the lock pins a model the server did not load", () => {
    expect(() => withLock({ lockVersion: "1", models: [lockEntry({ name: "some-other-model" })] }, (root) =>
      verifyModelLock({ bundleRoot: root, model: MODEL.model })))
      .toThrow(/not in model\.lock/);
  });

  it("fails closed on a model version drift", () => {
    expect(() => withLock({ lockVersion: "1", models: [lockEntry({ version: "9.9.9" })] }, (root) =>
      verifyModelLock({ bundleRoot: root, model: MODEL.model })))
      .toThrow(/pins .*@9\.9\.9/);
  });

  it("fails closed when the model's semantics changed without its version changing", () => {
    // The dangerous case: same name, same version, different definitions. Only
    // the schema digest can catch it, which is why the lock carries one.
    expect(() => withLock(
      { lockVersion: "1", models: [lockEntry({ schemaDigest: `sha256:${"c".repeat(64)}` })] },
      (root) => verifyModelLock({ bundleRoot: root, model: MODEL.model })))
      .toThrow(/schemaDigest/);
  });

  it("fails closed when the manifest and the lock disagree about the model version", () => {
    expect(() => withLock({ lockVersion: "1", models: [lockEntry()] }, (root) =>
      verifyModelLock({
        bundleRoot: root,
        model: MODEL.model,
        manifestModels: { [MODEL.model.manifest.name]: "0.0.1" },
      })))
      .toThrow(/corpus\.manifest\.json declares/);
  });

  it("fails closed when the manifest omits the locked model entirely", () => {
    expect(() => withLock({ lockVersion: "1", models: [lockEntry()] }, (root) =>
      verifyModelLock({ bundleRoot: root, model: MODEL.model, manifestModels: { unrelated: "1.0.0" } })))
      .toThrow(/does not declare model/);
  });

  it("fails closed when the manifest schemaDigest is not the locked model's", () => {
    expect(() => withLock({ lockVersion: "1", models: [lockEntry()] }, (root) =>
      verifyModelLock({
        bundleRoot: root,
        model: MODEL.model,
        manifestModels: { [MODEL.model.manifest.name]: MODEL.model.manifest.version },
        manifestSchemaDigest: `sha256:${"d".repeat(64)}`,
      })))
      .toThrow(/schemaDigest .* does not match/);
  });

  it("accepts a manifest whose schemaDigest matches the single locked model", () => {
    const diagnostics = withLock({ lockVersion: "1", models: [lockEntry()] }, (root) =>
      verifyModelLock({
        bundleRoot: root,
        model: MODEL.model,
        manifestModels: { [MODEL.model.manifest.name]: MODEL.model.manifest.version },
        manifestSchemaDigest: SCHEMA_DIGEST,
      }));
    expect(diagnostics).toEqual([]);
  });

  it("refuses unparseable lock bytes instead of continuing unlocked", () => {
    expect(() => withLock("{ not json", (root) => verifyModelLock({ bundleRoot: root, model: MODEL.model })))
      .toThrow(/Unable to parse/);
  });

  it("refuses a symlinked lock, which could point outside the bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "w10a-lock-link-"));
    try {
      const target = join(root, "elsewhere.json");
      writeFileSync(target, JSON.stringify({ lockVersion: "1", models: [lockEntry()] }), "utf8");
      symlinkSync(target, join(root, MODEL_LOCK_FILE));
      expect(() => verifyModelLock({ bundleRoot: root, model: MODEL.model })).toThrow(/non-symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
