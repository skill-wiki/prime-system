/**
 * Model-lock verification at activation.
 *
 * Plan §8.4 lists "Model lock 完整性" among the checks a Runtime must perform at
 * boot, and §8.5 defines a snapshot as `corpus release + model lock + policy set`.
 * Neither was enforced: a bundle's `corpus.manifest.json` could declare
 * `models: {foo: "1.0.0"}` while `PRIME_MODEL_DIR` handed the server an entirely
 * different Model Package, and nothing compared the two. The result would be a
 * response stamped with a snapshot identity that does not describe how it was
 * produced — the exact failure the immutable-snapshot rule exists to prevent.
 *
 * A mismatch therefore fails closed. A *missing* lock is a warning, because
 * bundles emitted before the lock existed are still legitimately servable and
 * their snapshot honestly reports what is known about them.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedModel, ModelDefinition } from "@skill-wiki/model-schema";

export const MODEL_LOCK_FILE = "model.lock";

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

export interface ModelLockFileEntry {
  readonly path: string;
  readonly digest: string;
}

export interface ModelLockEntry {
  readonly name: string;
  readonly version: string;
  readonly protocol: string;
  readonly schemaDigest: string;
  readonly files: readonly ModelLockFileEntry[];
  readonly manifestDigest: string;
}

export interface ModelLock {
  readonly lockVersion: string;
  readonly models: readonly ModelLockEntry[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SUPPORTED_LOCK_VERSION = "1";

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

/**
 * The digest of a Model Package's *semantics*, not of its bytes.
 *
 * Identical to `scripts/build-atom-dirs.ts` — the only producer of a
 * `schemaDigest` in this repository — so a bundle sealed by that pipeline and a
 * bundle verified here cannot disagree about what the model's digest is. Sorting
 * by `kind/name` makes the value independent of file order and of how the
 * definitions were split across files.
 */
export function computeModelSchemaDigest(definitions: readonly ModelDefinition[]): string {
  const hash = createHash("sha256");
  for (const definition of [...definitions].sort((left, right) =>
    `${left.kind}/${left.name}` < `${right.kind}/${right.name}` ? -1 : 1)) {
    hash.update(JSON.stringify(definition));
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Validate an untrusted parsed lock without touching disk. */
export function parseModelLock(value: unknown): ModelLock {
  const raw = record(value, MODEL_LOCK_FILE);
  const lockVersion = nonEmptyString(raw, "lockVersion", MODEL_LOCK_FILE);
  if (lockVersion !== SUPPORTED_LOCK_VERSION) {
    invalid(`Unsupported model.lock lockVersion "${lockVersion}"; this runtime understands "${SUPPORTED_LOCK_VERSION}".`);
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
