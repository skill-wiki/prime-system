import { existsSync, lstatSync, realpathSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SemVer = z.string().regex(semver, "must be strict SemVer").refine(value => { const coreAndPrerelease = value.split("+", 1)[0]!; const separator = coreAndPrerelease.indexOf("-"); const prerelease = separator < 0 ? "" : coreAndPrerelease.slice(separator + 1); return !prerelease.split(".").some(part => /^0\d+$/.test(part)); }, "must not use numeric prerelease identifiers with leading zeroes");
const ExtensionMap = z.record(z.string(), z.unknown());
const Field = z.object({ name: z.string().min(1), typeRef: z.string().min(1), required: z.boolean().optional(), description: z.string().optional() }).strict();
const RelationSemantics = z.object({ traversal: z.enum(["none", "one-hop", "transitive"]), selection: z.enum(["informational", "expand", "closure", "exclude"]), loadOrder: z.enum(["none", "before", "after"]), cyclePolicy: z.enum(["allow", "reject", "collapse"]), conflictSeverity: z.enum(["none", "warning", "error"]) }).strict();
export const TypeDefinitionSchema = z.object({ kind: z.literal("type"), name: z.string().min(1), version: SemVer, fields: z.array(Field).default([]), extensions: ExtensionMap.optional() }).strict();
export const RelationDefinitionSchema = z.object({ kind: z.literal("relation"), name: z.string().min(1), version: SemVer, from: z.string().min(1), to: z.string().min(1), cardinality: z.enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]), directional: z.boolean(), semantics: RelationSemantics, inverse: z.string().min(1).optional(), aliases: z.array(z.string().min(1)).optional(), extensions: ExtensionMap.optional() }).strict();
export const FunctionDefinitionSchema = z.object({ kind: z.literal("function"), name: z.string().min(1), version: SemVer, inputs: z.array(Field).default([]), output: z.string().min(1), purity: z.enum(["pure", "read-only"]), deterministic: z.boolean(), provider: z.string().min(1), extensions: ExtensionMap.optional() }).strict();
export const ActionDefinitionSchema = z.object({ kind: z.literal("action"), name: z.string().min(1), version: SemVer, inputs: z.array(Field).default([]), output: z.string().min(1), capabilities: z.array(z.string().min(1)).default([]), sideEffects: z.enum(["none", "read", "write"]), idempotency: z.enum(["idempotent", "non-idempotent", "unknown"]), approval: z.enum(["never", "always", "conditional"]), provider: z.string().min(1).optional(), preconditions: z.array(z.string().min(1)).optional(), extensions: ExtensionMap.optional() }).strict();
export const ProjectionDefinitionSchema = z.object({ kind: z.literal("projection"), name: z.string().min(1), version: SemVer, targetTokens: z.number().int().positive(), include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]), typeGroups: z.record(z.string(), z.array(z.string().min(1))).default({}), rules: z.array(z.object({ layer: z.string().optional(), typeRef: z.string().optional(), include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() }).strict()).default([]), extensions: ExtensionMap.optional() }).strict();
export const RetrievalProfileSchema = z.object({ kind: z.literal("retrieval-profile"), name: z.string().min(1), version: SemVer, projection: z.string().min(1), candidateGenerators: z.array(z.object({ name: z.string().min(1), weight: z.number().nonnegative() }).strict()).min(1), features: z.record(z.string(), z.number()), constraints: z.array(z.string().min(1)).default([]), reranker: z.string().min(1).optional(), extensions: ExtensionMap.optional() }).strict();
const DefinitionSchema = z.discriminatedUnion("kind", [TypeDefinitionSchema, RelationDefinitionSchema, FunctionDefinitionSchema, ActionDefinitionSchema, ProjectionDefinitionSchema, RetrievalProfileSchema]);
export const ModelManifestSchema = z.object({ protocol: z.literal("prime/model/v2"), name: z.string().min(1), version: SemVer, files: z.array(z.string().min(1)).min(1) }).strict();
export const DefinitionFileSchema = z.object({ kind: z.literal("definitions"), version: SemVer, definitions: z.array(DefinitionSchema).min(1) }).strict();

export type Manifest = z.infer<typeof ModelManifestSchema>;
export type TypeDefinition = z.infer<typeof TypeDefinitionSchema>;
export type RelationDefinition = z.infer<typeof RelationDefinitionSchema>;
export type FunctionDefinition = z.infer<typeof FunctionDefinitionSchema>;
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;
export type ProjectionDefinition = z.infer<typeof ProjectionDefinitionSchema>;
export type RetrievalProfile = z.infer<typeof RetrievalProfileSchema>;
export type ModelDefinition = z.infer<typeof DefinitionSchema>;
export interface Diagnostic { code: string; message: string; path?: string; definition?: string }
export interface LoadedModel { root: string; manifest: Manifest; definitions: readonly ModelDefinition[] }
export type LoadResult = { ok: true; value: LoadedModel } | { ok: false; diagnostics: readonly Diagnostic[] };
export class ModelLoadError extends Error { constructor(readonly diagnostics: readonly Diagnostic[]) { super("Invalid model package"); } }

function diag(code: string, message: string, path?: string, definition?: string): Diagnostic { return { code, message, path, definition }; }
function parseYaml(path: string, diagnostics: Diagnostic[]): unknown | undefined { try { return parse(readFileSync(path, "utf8")); } catch (error) { diagnostics.push(diag("YAML_PARSE_ERROR", error instanceof Error ? error.message : "YAML parsing failed", path)); } }
function safeFile(rootReal: string, root: string, file: string, diagnostics: Diagnostic[]): string | undefined {
  if (isAbsolute(file) || file.split(/[\\/]+/).includes("..")) { diagnostics.push(diag("PATH_OUTSIDE_ROOT", "Definition path must be a relative path within the model root", file)); return; }
  const candidate = resolve(root, file);
  if (!existsSync(candidate) || lstatSync(candidate).isDirectory()) { diagnostics.push(diag("DEFINITION_FILE_INVALID", "Definition path must name an existing regular file", file)); return; }
  const actual = realpathSync(candidate);
  if (relative(rootReal, actual).startsWith("..") || isAbsolute(relative(rootReal, actual))) { diagnostics.push(diag("PATH_OUTSIDE_ROOT", "Definition path resolves outside the model root", file)); return; }
  if (!lstatSync(actual).isFile()) { diagnostics.push(diag("DEFINITION_FILE_INVALID", "Definition path must resolve to a regular file", file)); return; }
  return actual;
}
function builtin(ref: string): boolean { return ["string", "number", "boolean", "integer", "unknown", "*", "generic"].includes(ref) || ref.startsWith("generic:"); }
function validateLinks(definitions: readonly ModelDefinition[], diagnostics: Diagnostic[]): void {
  const names = new Set<string>(); const types = new Set<string>(); const relations = new Set<string>(); const projections = new Set<string>();
  for (const d of definitions) { const key = `${d.kind}:${d.name}`; if (names.has(key)) diagnostics.push(diag("DUPLICATE_DEFINITION", "Duplicate definition kind/name", undefined, key)); names.add(key); if (d.kind === "type") types.add(d.name); if (d.kind === "relation") relations.add(d.name); if (d.kind === "projection") projections.add(d.name); }
  const ref = (value: string, owner: string) => { if (!builtin(value) && !types.has(value)) diagnostics.push(diag("DANGLING_TYPE_REF", `Unknown type reference: ${value}`, undefined, owner)); };
  for (const d of definitions) { const owner = `${d.kind}:${d.name}`; if (d.kind === "type") for (const f of d.fields) ref(f.typeRef, owner); if (d.kind === "function" || d.kind === "action") { for (const f of d.inputs) ref(f.typeRef, owner); ref(d.output, owner); } if (d.kind === "relation") { ref(d.from, owner); ref(d.to, owner); if (d.inverse && !relations.has(d.inverse)) diagnostics.push(diag("DANGLING_RELATION_REF", `Unknown inverse relation: ${d.inverse}`, undefined, owner)); } if (d.kind === "projection") { for (const [group, members] of Object.entries(d.typeGroups)) for (const member of members) ref(member, `${owner}/group:${group}`); for (const rule of d.rules) if (rule.typeRef) { if (rule.typeRef.startsWith("group:")) { const group = rule.typeRef.slice("group:".length); if (!(group in d.typeGroups)) diagnostics.push(diag("DANGLING_TYPE_GROUP_REF", `Unknown projection type group: ${group}`, undefined, owner)); } else ref(rule.typeRef, `${owner}/rule`); } } if (d.kind === "retrieval-profile" && !projections.has(d.projection)) diagnostics.push(diag("DANGLING_PROJECTION_REF", `Unknown projection: ${d.projection}`, undefined, owner)); }
}
export function loadModel(root: string): LoadResult {
  const diagnostics: Diagnostic[] = [];
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return { ok: false, diagnostics: [diag("MODEL_ROOT_INVALID", "Model root must be an existing directory", root)] };
  const rootReal = realpathSync(root); const manifestName = "prime-model.yaml";
  if (!existsSync(resolve(root, manifestName))) return { ok: false, diagnostics: [diag("MANIFEST_NOT_FOUND", "prime-model.yaml does not exist", resolve(root, manifestName))] };
  const manifestPath = safeFile(rootReal, root, manifestName, diagnostics);
  if (!manifestPath) return { ok: false, diagnostics };
  const manifestParsed = parseYaml(manifestPath, diagnostics); const manifestResult = ModelManifestSchema.safeParse(manifestParsed);
  if (!manifestResult.success) diagnostics.push(diag("INVALID_MANIFEST", manifestResult.error.issues.map(x => x.message).join("; "), manifestPath));
  if (!manifestResult.success) return { ok: false, diagnostics };
  const paths = new Set<string>(); const definitions: ModelDefinition[] = [];
  for (const file of manifestResult.data.files) { if (paths.has(file)) { diagnostics.push(diag("DUPLICATE_FILE_PATH", "Manifest lists a definition file more than once", file)); continue; } paths.add(file); const path = safeFile(rootReal, root, file, diagnostics); if (!path) continue; const doc = parseYaml(path, diagnostics); const result = DefinitionFileSchema.safeParse(doc); if (!result.success) { diagnostics.push(diag("INVALID_DEFINITION_FILE", result.error.issues.map(x => x.message).join("; "), file)); continue; } definitions.push(...result.data.definitions); }
  validateLinks(definitions, diagnostics); return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: { root: rootReal, manifest: manifestResult.data, definitions } };
}
export function loadModelOrThrow(root: string): LoadedModel { const result = loadModel(root); if (!result.ok) throw new ModelLoadError(result.diagnostics); return result.value; }
