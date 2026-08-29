import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, parse as parsePath, resolve, sep } from "node:path";
import { buildGlobalIndexXml, type AtomMeta } from "@skill-wiki/compiler";
import type { CompiledUnitIR } from "@skill-wiki/ir";
import { compareCanonicalStrings, computeCorpusContentDigest, loadCorpusSnapshot, validateCorpusManifest, type CorpusManifest } from "@skill-wiki/runtime";

export interface CorpusIndexEntry { readonly id: string; readonly kind: string; readonly version: string; readonly description: string; readonly domain: string; readonly tags: readonly string[]; readonly tokens: Readonly<Record<string, number>>; readonly lifecycle?: "active" | "deprecated"; readonly deprecatedAt?: string; readonly supersededBy?: string; }
export interface BundleManifestMetadata { readonly protocolVersion: string; readonly irVersion: string; readonly compilerVersion: string; readonly emitterVersion: string; readonly corpus: string; readonly release: string; readonly sourceRevision: string; readonly models: Readonly<Record<string, string>>; readonly schemaDigest: string; readonly createdAt: string; }
export interface FinalizeCorpusBundleOptions { readonly outDir: string; readonly units?: readonly CompiledUnitIR[]; readonly entries?: readonly CorpusIndexEntry[]; readonly manifest: BundleManifestMetadata; }
export interface FinalizedCorpusBundle { readonly manifest: CorpusManifest; readonly indexPath: string; readonly manifestPath: string; }

function digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function asEntry(unit: CompiledUnitIR): CorpusIndexEntry { return { id: unit.meta.id, kind: unit.meta.kind, version: unit.meta.version, description: unit.meta.description, domain: unit.meta.domain, tags: unit.meta.tags, tokens: unit.meta.tokens, lifecycle: unit.unit.lifecycle === "deprecated" ? "deprecated" : "active" }; }
function validate(entry: CorpusIndexEntry): void {
  if (!entry.id || entry.id.includes("\0") || entry.id.split("/").some(x => x === "" || x === "." || x === "..")) throw new Error(`Invalid corpus index entry id: ${entry.id}`);
  if (!entry.kind || !entry.version || !entry.description || !entry.domain) throw new Error(`Invalid corpus index entry metadata: ${entry.id}`);
  for (const key of ["summary", "core", "full"]) if (!Number.isInteger(entry.tokens[key]) || entry.tokens[key]! < 0) throw new Error(`Invalid ${key} token count: ${entry.id}`);
}
function atom(entry: CorpusIndexEntry): AtomMeta { return { id: entry.id, kind: entry.kind, version: entry.version, description: entry.description, domain: entry.domain, tags: [...entry.tags], tokens: { summary: entry.tokens.summary!, core: entry.tokens.core!, full: entry.tokens.full! }, quality: "0", ...(entry.lifecycle === "deprecated" && entry.deprecatedAt ? { deprecated_at: entry.deprecatedAt, ...(entry.supersededBy ? { superseded_by: entry.supersededBy } : {}) } : {}) }; }
const stable = (left: string, right: string) => compareCanonicalStrings(left, right);
const canonicalModels = (models: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(models).sort(([a], [b]) => stable(a, b)));
function ensureRoot(root: string): void { const absolute = resolve(root); const pathRoot = parsePath(absolute).root; let lexical: string = pathRoot; for (const part of absolute.slice(pathRoot.length).split(sep).filter(Boolean)) { lexical = join(lexical, part); if (!existsSync(lexical)) break; const stat = lstatSync(lexical); if (stat.isSymbolicLink()) throw new Error(`Corpus root has a symlink ancestor: ${lexical}`); } if (!existsSync(root)) { let ancestor = root; const missing: string[] = []; while (!existsSync(ancestor)) { missing.push(ancestor); const parent = resolve(ancestor, ".."); if (parent === ancestor) throw new Error(`No safe ancestor for ${root}`); ancestor = parent; } const parentStat = lstatSync(ancestor); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`Corpus root has a symlink ancestor: ${ancestor}`); for (const directory of missing.reverse()) { mkdirSync(directory); const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Corpus root has unsafe path segment: ${directory}`); } } const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Corpus root must be a real directory: ${root}`); }
function assertSafeExisting(path: string, label: string): void { if (!existsSync(path)) return; const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${path}`); }
function moveIntoPlace(stage: string, target: string, backup: string): boolean { if (!existsSync(target)) { renameSync(stage, target); return false; } renameSync(target, backup); try { renameSync(stage, target); return true; } catch (error) { renameSync(backup, target); throw error; } }
function restore(target: string, backup: string, hadOld: boolean): void { if (!hadOld) { rmSync(target, { force: true }); return; } if (!existsSync(backup)) return; if (existsSync(target)) rmSync(target, { force: true }); renameSync(backup, target); }

/**
 * Every unit must have been compiled under the corpus identity being recorded.
 *
 * `computeCompiledUnitContentDigest` hashes the whole `unit.identity`, so corpus
 * identity is a content-digest input. A bundle labelled `A` whose units carry
 * the digests of corpus `B` still passes every later digest check, because those
 * checks compare the artifacts against the manifest rather than against the
 * inputs. Refusing the mismatch here is what makes the recorded identity
 * load-bearing, and it is also what catches an identity that was derived from
 * the output directory instead of from a declared input (plan §8.4).
 */
function assertUnitsAgreeOnCorpus(units: readonly CompiledUnitIR[], corpus: string): void {
  for (const unit of units) {
    if (unit.unit.identity.corpus !== corpus) {
      throw new Error(`Unit was compiled for corpus "${unit.unit.identity.corpus}" but the bundle manifest declares corpus "${corpus}": ${unit.meta.id}`);
    }
  }
}

/** Write the authoritative corpus index and immutable manifest, then ask Runtime to verify it. */
export function finalizeCorpusBundle(options: FinalizeCorpusBundleOptions): FinalizedCorpusBundle {
  const root = resolve(options.outDir); const entries = [...(options.entries ?? []), ...(options.units ?? []).map(asEntry)];
  if (!entries.length) throw new Error("A corpus bundle requires at least one unit/index entry.");
  assertUnitsAgreeOnCorpus(options.units ?? [], options.manifest.corpus);
  const ids = new Set<string>(); for (const entry of entries) { validate(entry); if (ids.has(entry.id)) throw new Error(`Duplicate corpus index entry: ${entry.id}`); ids.add(entry.id); }
  validateCorpusManifest({ ...options.manifest, models: canonicalModels(options.manifest.models), contentDigest: digest(Buffer.from("content")), indexDigest: digest(Buffer.from("index")) });
  ensureRoot(root);
  for (const name of readdirSync(root).sort(stable)) if (/^\.corpus\.manifest\.json\.tmp-[A-Za-z0-9._-]+$/.test(name) || /^\.prime-bundle-(?:index|manifest)-(?:stage|backup)-\d+-\d+$/.test(name)) rmSync(join(root, name), { recursive: true, force: true });
  const indexPath = join(root, "_index.xml"); const manifestPath = join(root, "corpus.manifest.json"); assertSafeExisting(indexPath, "Corpus index"); assertSafeExisting(manifestPath, "Corpus manifest");
  // Full scan happens before staging any bytes, so links/special files cannot
  // turn a failed finalization into an out-of-root write.
  computeCorpusContentDigest(root);
  const nonce = `${process.pid}-${Date.now()}`; const indexStage = join(root, `.prime-bundle-index-stage-${nonce}`); const indexBackup = join(root, `.prime-bundle-index-backup-${nonce}`); const manifestStage = join(root, `.prime-bundle-manifest-stage-${nonce}`); const manifestBackup = join(root, `.prime-bundle-manifest-backup-${nonce}`);
  const index = buildGlobalIndexXml(entries.map(atom)); let oldIndex = false; let oldManifest = false; let committed = false;
  try {
    writeFileSync(indexStage, index, "utf8"); oldIndex = moveIntoPlace(indexStage, indexPath, indexBackup);
    const manifest: CorpusManifest = { ...options.manifest, models: canonicalModels(options.manifest.models), contentDigest: computeCorpusContentDigest(root), indexDigest: digest(Buffer.from(index, "utf8")) };
    writeFileSync(manifestStage, JSON.stringify(manifest, null, 2) + "\n", "utf8"); oldManifest = moveIntoPlace(manifestStage, manifestPath, manifestBackup);
    loadCorpusSnapshot(root, { requireManifest: true }); committed = true; try { rmSync(indexBackup, { force: true }); rmSync(manifestBackup, { force: true }); } catch { /* committed artifacts remain authoritative; stale backups are cleaned next run */ }
    return { manifest, indexPath, manifestPath };
  } catch (error) { if (!committed) { restore(manifestPath, manifestBackup, oldManifest); restore(indexPath, indexBackup, oldIndex); } throw error; }
  finally { for (const file of [indexStage, indexBackup, manifestStage, manifestBackup]) try { rmSync(file, { force: true }); } catch { /* post-commit cleanup never changes transaction outcome */ } }
}

/** Re-export the Runtime authority for callers that need to inspect artifacts before finalizing. */
export { computeCorpusContentDigest } from "@skill-wiki/runtime";
