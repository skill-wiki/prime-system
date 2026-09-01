/**
 * Model-lock verification at activation.
 *
 * Plan §8.4 lists "Model lock 完整性" among the checks a Runtime must perform at
 * boot, and §8.5 defines a snapshot as `corpus release + model lock + policy set`.
 * Neither was enforced: a bundle's `corpus.manifest.json` could declare
 * `models: {foo: "1.0.0"}` while `AOE_MODEL_DIR` handed the server an entirely
 * different Model Package, and nothing compared the two. The result would be a
 * response stamped with a snapshot identity that does not describe how it was
 * produced — the exact failure the immutable-snapshot rule exists to prevent.
 *
 * A mismatch therefore fails closed. A *missing* lock is a warning, because
 * bundles emitted before the lock existed are still legitimately servable and
 * their snapshot honestly reports what is known about them.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_LOCK_FILE,
  MODEL_LOCK_VERSION,
  computeModelFileDigest,
  computeModelSchemaDigest,
  type LoadedModel,
  type ModelLock,
  type ModelLockEntry,
  type ModelLockFileEntry,
} from "@aoe/model-schema";

export { MODEL_LOCK_FILE, computeModelSchemaDigest } from "@aoe/model-schema";
export type { ModelLock, ModelLockEntry, ModelLockFileEntry } from "@aoe/model-schema";

export type ModelLockCode = "MODEL_LOCK_MISSING" | "MODEL_LOCK_INVALID" | "MODEL_LOCK_MISMATCH";

export interface ModelLockDiagnostic {
  readonly code: ModelLockCode;
  readonly message: string;
  readonly severity: "warning" | "error";
}

export class ModelLockError extends Error {
  constructor(readonly code: ModelLockCode, message: string) {
    super(message);
    this.name = "ModelLockError";
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new ModelLockError("MODEL_LOCK_INVALID", message);
}

function mismatch(message: string): never {
  throw new ModelLockError("MODEL_LOCK_MISMATCH", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function nonEmptyString(raw: Record<string, unknown>, key: string, label: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") invalid(`${label}.${key} must be a non-empty string.`);
  return value;
}

function digestField(raw: Record<string, unknown>, key: string, label: string): string {
  const value = raw[key];
  if (typeof value !== "string" || !DIGEST.test(value)) invalid(`${label}.${key} must be a canonical sha256 digest.`);
  return value;
}

/** Validate an untrusted parsed lock without touching disk. */
export function parseModelLock(value: unknown): ModelLock {
  const raw = record(value, MODEL_LOCK_FILE);
  const lockVersion = nonEmptyString(raw, "lockVersion", MODEL_LOCK_FILE);
  if (lockVersion !== MODEL_LOCK_VERSION) {
    invalid(`Unsupported model.lock lockVersion "${lockVersion}"; this runtime understands "${MODEL_LOCK_VERSION}".`);
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    invalid("model.lock.models must be a non-empty array.");
  }
  const models = raw.models.map((entry, position) => {
    const label = `model.lock.models[${position}]`;
    const model = record(entry, label);
    if (!Array.isArray(model.files) || model.files.length === 0) invalid(`${label}.files must be a non-empty array.`);
    const files = model.files.map((file, index) => {
      const fileLabel = `${label}.files[${index}]`;
      const parsed = record(file, fileLabel);
      return {
        path: nonEmptyString(parsed, "path", fileLabel),
        digest: digestField(parsed, "digest", fileLabel),
      };
    });
    return {
      name: nonEmptyString(model, "name", label),
      version: nonEmptyString(model, "version", label),
      protocol: nonEmptyString(model, "protocol", label),
      schemaDigest: digestField(model, "schemaDigest", label),
      files,
      manifestDigest: digestField(model, "manifestDigest", label),
    };
  });
  const names = new Set<string>();
  for (const model of models) {
    if (names.has(model.name)) invalid(`model.lock declares "${model.name}" twice.`);
    names.add(model.name);
  }
  return { lockVersion, models };
}

export interface VerifyModelLockOptions {
  /** Compiled corpus root; `model.lock` is looked up directly beneath it. */
  readonly bundleRoot: string;
  readonly model: LoadedModel;
  /** `corpus.manifest.json`'s `models` map, absent for a legacy bundle. */
  readonly manifestModels?: Readonly<Record<string, string>>;
  /** `corpus.manifest.json`'s `schemaDigest`, absent for a legacy bundle. */
  readonly manifestSchemaDigest?: string;
}

/**
 * Check that the Model Package actually loaded is the one this corpus was sealed
 * against. Throws on any disagreement; returns a warning when there is no lock.
 *
 * The lock is compared against the *loaded* model rather than against the model
 * directory, so an `explicit`/`environment` model root cannot slip past by
 * pointing at a directory whose files happen to be named the same.
 */
export function verifyModelLock(options: VerifyModelLockOptions): readonly ModelLockDiagnostic[] {
  const lockPath = join(options.bundleRoot, MODEL_LOCK_FILE);
  if (!existsSync(lockPath)) {
    return [{
      code: "MODEL_LOCK_MISSING",
      message: `Compiled corpus has no ${MODEL_LOCK_FILE}; the model identity serving it is unverified.`,
      severity: "warning",
    }];
  }
  const stat = lstatSync(lockPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    invalid(`${MODEL_LOCK_FILE} must be a regular non-symlink file.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (cause) {
    invalid(`Unable to parse ${MODEL_LOCK_FILE}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const lock = parseModelLock(parsed);

  const entry = lock.models.find((candidate) => candidate.name === options.model.manifest.name);
  if (entry === undefined) {
    mismatch(
      `Loaded model "${options.model.manifest.name}" is not in ${MODEL_LOCK_FILE}; ` +
        `the lock pins ${lock.models.map((m) => m.name).sort().join(", ")}.`,
    );
  }
  if (entry.version !== options.model.manifest.version) {
    mismatch(
      `${MODEL_LOCK_FILE} pins ${entry.name}@${entry.version} but the loaded model is ` +
        `${options.model.manifest.name}@${options.model.manifest.version}.`,
    );
  }
  if (entry.protocol !== options.model.manifest.protocol) {
    mismatch(
      `${MODEL_LOCK_FILE} pins protocol "${entry.protocol}" for ${entry.name} but the loaded model declares ` +
        `"${options.model.manifest.protocol}".`,
    );
  }
  const actualSchemaDigest = computeModelSchemaDigest(options.model.definitions);
  if (entry.schemaDigest !== actualSchemaDigest) {
    mismatch(
      `${MODEL_LOCK_FILE} pins ${entry.name} at schemaDigest ${entry.schemaDigest} but the loaded model hashes to ` +
        `${actualSchemaDigest}. The model was changed after this corpus was compiled; recompile the corpus.`,
    );
  }
  const expectedFiles = [...options.model.manifest.files].sort();
  const lockedFiles = [...entry.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (lockedFiles.map(file => file.path).join("\0") !== expectedFiles.join("\0")) {
    mismatch(`${MODEL_LOCK_FILE} file inventory does not match the loaded model manifest.`);
  }
  for (const file of lockedFiles) {
    if (file.path.split(/[\\/]+/).includes("..")) invalid(`${MODEL_LOCK_FILE} contains an unsafe model file path: ${file.path}`);
    const actual = computeModelFileDigest(readFileSync(join(options.model.root, file.path)));
    if (actual !== file.digest) mismatch(`${MODEL_LOCK_FILE} digest mismatch for model file ${file.path}.`);
  }
  const actualManifestDigest = computeModelFileDigest(readFileSync(join(options.model.root, "prime-model.yaml")));
  if (actualManifestDigest !== entry.manifestDigest) mismatch(`${MODEL_LOCK_FILE} manifestDigest does not match prime-model.yaml.`);
  // The manifest carries the same lock as a flat map (§8.4 `models`). Both are
  // checked so a hand-edited manifest cannot claim a model the lock disowns.
  if (options.manifestModels !== undefined) {
    const declared = options.manifestModels[entry.name];
    if (declared === undefined) {
      mismatch(`corpus.manifest.json does not declare model "${entry.name}" that ${MODEL_LOCK_FILE} pins.`);
    }
    if (declared !== entry.version) {
      mismatch(
        `corpus.manifest.json declares ${entry.name}@${declared} but ${MODEL_LOCK_FILE} pins ` +
          `${entry.name}@${entry.version}.`,
      );
    }
  }
  if (options.manifestSchemaDigest !== undefined && lock.models.length === 1
    && options.manifestSchemaDigest !== entry.schemaDigest) {
    mismatch(
      `corpus.manifest.json schemaDigest ${options.manifestSchemaDigest} does not match the single locked model's ` +
        `schemaDigest ${entry.schemaDigest}.`,
    );
  }
  return [];
}
