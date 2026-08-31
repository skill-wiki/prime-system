import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { LoadedModel, ModelDefinition } from "./index.ts";

export const MODEL_LOCK_FILE = "model.lock";
export const MODEL_LOCK_VERSION = "1";

export interface ModelLockFileEntry { readonly path: string; readonly digest: string }
export interface ModelLockEntry {
  readonly name: string;
  readonly version: string;
  readonly protocol: string;
  readonly schemaDigest: string;
  readonly files: readonly ModelLockFileEntry[];
  readonly manifestDigest: string;
}
export interface ModelLock { readonly lockVersion: string; readonly models: readonly ModelLockEntry[] }

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Canonical semantic digest shared by bundle producer and every host verifier. */
export function computeModelSchemaDigest(definitions: readonly ModelDefinition[]): string {
  const hash = createHash("sha256");
  for (const definition of [...definitions].sort((left, right) =>
    `${left.kind}/${left.name}` < `${right.kind}/${right.name}` ? -1 : 1)) {
    hash.update(JSON.stringify(definition));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function createModelLock(model: LoadedModel): ModelLock {
  const files = [...model.manifest.files].sort().map(path => ({
    path,
    digest: sha256(readFileSync(join(model.root, path))),
  }));
  return {
    lockVersion: MODEL_LOCK_VERSION,
    models: [{
      name: model.manifest.name,
      version: model.manifest.version,
      protocol: model.manifest.protocol,
      schemaDigest: computeModelSchemaDigest(model.definitions),
      files,
      manifestDigest: sha256(readFileSync(join(model.root, "prime-model.yaml"))),
    }],
  };
}

/** Write a deterministic lock atomically before the bundle manifest seals it. */
export function writeModelLock(bundleRoot: string, model: LoadedModel): string {
  const root = resolve(bundleRoot);
  const target = join(root, MODEL_LOCK_FILE);
  const rel = relative(root, target);
  if (rel !== MODEL_LOCK_FILE) throw new Error("model.lock target escapes bundle root");
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("model.lock target must be a regular non-symlink file");
  }
  const stage = join(root, `.model.lock.stage-${process.pid}`);
  rmSync(stage, { force: true });
  try {
    writeFileSync(stage, JSON.stringify(createModelLock(model), null, 2) + "\n", "utf8");
    renameSync(stage, target);
  } finally {
    rmSync(stage, { force: true });
  }
  return target;
}
