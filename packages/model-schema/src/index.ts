import { existsSync, lstatSync, realpathSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SemVer = z.string().regex(semver, "must be strict SemVer").refine(value => { const coreAndPrerelease = value.split("+", 1)[0]!; const separator = coreAndPrerelease.indexOf("-"); const prerelease = separator < 0 ? "" : coreAndPrerelease.slice(separator + 1); return !prerelease.split(".").some(part => /^0\d+$/.test(part)); }, "must not use numeric prerelease identifiers with leading zeroes");
const ExtensionMap = z.record(z.string(), z.unknown());

/**
 * The builtin refs, and the two ways a ref can be more than one of them.
 *
 * `typeRef` is a grammar, not a name: `T`, `T[]`, `T[][]`. Before this existed a
 * field holding a list had to be declared `unknown` (which emits the empty JSON
 * Schema `{}` — every shape accepted) or smuggled through a comma-separated
 * `string`, and both were load-bearing in `projects/prime-frontend-design`. The
 * suffix is chosen over a sibling `items:` key because the ref stays a single
 * string, so `SchemaIR.TypeRef` (an opaque string) carries the arity with no IR
 * change and no second place to look.
 *
 * `enum` is a sibling key rather than part of the ref grammar because its values
 * are data, not a name: putting them inside the string would make the ref
 * unparseable the moment a value contains `[`, `]` or a delimiter. It is legal only
 * on a `string` element — a numeric enum has no declared consumer and allowing one
 * would put value parsing into the grammar.
 */
export const BUILTIN_TYPE_REFS = ["string", "number", "boolean", "integer", "unknown", "*", "generic"] as const;
export function isBuiltinTypeRef(ref: string): boolean { return (BUILTIN_TYPE_REFS as readonly string[]).includes(ref) || ref.startsWith("generic:"); }
export interface ParsedTypeRef { readonly element: string; readonly arrayDepth: number }
/** Split `T[][]` into its element and its arity. `undefined` means the ref is malformed, which is a diagnostic and never a silent scalar. */
export function parseTypeRef(ref: string): ParsedTypeRef | undefined {
  let element = ref; let arrayDepth = 0;
  while (element.endsWith("[]")) { element = element.slice(0, -2); arrayDepth += 1; }
  if (element.length === 0 || element.includes("[") || element.includes("]")) return undefined;
  return { element, arrayDepth };
}
const EnumValues = z.array(z.string().min(1)).min(1);
const Field = z.object({ name: z.string().min(1), typeRef: z.string().min(1), required: z.boolean().optional(), description: z.string().optional(), enum: EnumValues.optional() }).strict();
export type FieldDeclaration = z.infer<typeof Field>;
const RelationSemantics = z.object({ traversal: z.enum(["none", "one-hop", "transitive"]), selection: z.enum(["informational", "expand", "closure", "exclude"]), loadOrder: z.enum(["none", "before", "after"]), cyclePolicy: z.enum(["allow", "reject", "collapse"]), conflictSeverity: z.enum(["none", "warning", "error"]) }).strict();
export const TypeDefinitionSchema = z.object({ kind: z.literal("type"), name: z.string().min(1), version: SemVer, fields: z.array(Field).default([]), additionalFields: z.enum(["reject", "unknown"]).default("reject"), extensions: ExtensionMap.optional() }).strict();
export const RelationDefinitionSchema = z.object({ kind: z.literal("relation"), name: z.string().min(1), version: SemVer, from: z.string().min(1), to: z.string().min(1), cardinality: z.enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]), directional: z.boolean(), semantics: RelationSemantics, inverse: z.string().min(1).optional(), aliases: z.array(z.string().min(1)).optional(), extensions: ExtensionMap.optional() }).strict();
export const FunctionDefinitionSchema = z.object({ kind: z.literal("function"), name: z.string().min(1), version: SemVer, inputs: z.array(Field).default([]), output: z.string().min(1), purity: z.enum(["pure", "read-only"]), deterministic: z.boolean(), provider: z.string().min(1), extensions: ExtensionMap.optional() }).strict();
export const ActionDefinitionSchema = z.object({ kind: z.literal("action"), name: z.string().min(1), version: SemVer, inputs: z.array(Field).default([]), output: z.string().min(1), capabilities: z.array(z.string().min(1)).default([]), sideEffects: z.enum(["none", "read", "write"]), idempotency: z.enum(["idempotent", "non-idempotent", "unknown"]), approval: z.enum(["never", "always", "conditional"]), provider: z.string().min(1).optional(), preconditions: z.array(z.string().min(1)).optional(), extensions: ExtensionMap.optional() }).strict();
export const ProjectionDefinitionSchema = z.object({ kind: z.literal("projection"), name: z.string().min(1), version: SemVer, targetTokens: z.number().int().positive(), include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]), typeGroups: z.record(z.string(), z.array(z.string().min(1))).default({}), rules: z.array(z.object({ layer: z.string().optional(), typeRef: z.string().optional(), include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() }).strict()).default([]), extensions: ExtensionMap.optional() }).strict();
export const RetrievalProfileSchema = z.object({ kind: z.literal("retrieval-profile"), name: z.string().min(1), version: SemVer, projection: z.string().min(1), candidateGenerators: z.array(z.object({ name: z.string().min(1), weight: z.number().nonnegative() }).strict()).min(1), features: z.record(z.string(), z.number()), constraints: z.array(z.string().min(1)).default([]), reranker: z.string().min(1).optional(), extensions: ExtensionMap.optional() }).strict();
export const MigrationStepSchema = z.union([
  z.object({ renameField: z.object({ type: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }).strict() }).strict(),
  z.object({ mapRelation: z.object({ from: z.string().min(1), to: z.string().min(1) }).strict() }).strict(),
  z.object({ setDefault: z.object({ type: z.string().min(1), field: z.string().min(1), value: z.unknown() }).strict() }).strict(),
]);
export const MigrationDefinitionSchema = z.object({ kind: z.literal("migration"), name: z.string().min(1), version: SemVer, from: z.string().min(1), to: SemVer, steps: z.array(MigrationStepSchema).min(1), extensions: ExtensionMap.optional() }).strict();
const DefinitionSchema = z.discriminatedUnion("kind", [TypeDefinitionSchema, RelationDefinitionSchema, FunctionDefinitionSchema, ActionDefinitionSchema, ProjectionDefinitionSchema, RetrievalProfileSchema, MigrationDefinitionSchema]);
export const ModelManifestSchema = z.object({ protocol: z.literal("prime/model/v2"), name: z.string().min(1), version: SemVer, files: z.array(z.string().min(1)).min(1) }).strict();
export const DefinitionFileSchema = z.object({ kind: z.literal("definitions"), version: SemVer, definitions: z.array(DefinitionSchema).min(1) }).strict();

export type Manifest = z.infer<typeof ModelManifestSchema>;
export type TypeDefinition = z.infer<typeof TypeDefinitionSchema>;
export type RelationDefinition = z.infer<typeof RelationDefinitionSchema>;
export type FunctionDefinition = z.infer<typeof FunctionDefinitionSchema>;
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;
export type ProjectionDefinition = z.infer<typeof ProjectionDefinitionSchema>;
export type RetrievalProfile = z.infer<typeof RetrievalProfileSchema>;
export type MigrationStep = z.infer<typeof MigrationStepSchema>;
export type MigrationDefinition = z.infer<typeof MigrationDefinitionSchema>;
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
function builtin(ref: string): boolean { return isBuiltinTypeRef(ref); }
function validateLinks(definitions: readonly ModelDefinition[], diagnostics: Diagnostic[]): void {
  const names = new Set<string>(); const types = new Set<string>(); const relations = new Set<string>(); const projections = new Set<string>();
  for (const d of definitions) { const key = `${d.kind}:${d.name}`; if (names.has(key)) diagnostics.push(diag("DUPLICATE_DEFINITION", "Duplicate definition kind/name", undefined, key)); names.add(key); if (d.kind === "type") types.add(d.name); if (d.kind === "relation") relations.add(d.name); if (d.kind === "projection") projections.add(d.name); }
  /**
   * `arity: "scalar"` is not a style preference: a relation endpoint, a projection
   * type group member and a projection rule's `typeRef` all *name a type* the engine
   * indexes by, so `Foo[]` there is a declaration the engine has no way to honour.
   * A field or an input/output position holds a *value*, where an array is meaningful.
   */
  const ref = (value: string, owner: string, arity: "scalar" | "value" = "value") => {
    const parsed = parseTypeRef(value);
    if (parsed === undefined) { diagnostics.push(diag("INVALID_TYPE_REF", `Malformed type reference: ${value}`, undefined, owner)); return; }
    if (parsed.arrayDepth > 0 && arity === "scalar") { diagnostics.push(diag("ARRAY_TYPE_REF_NOT_ALLOWED", `An array type reference cannot name a type here: ${value}`, undefined, owner)); return; }
    if (!builtin(parsed.element) && !types.has(parsed.element)) diagnostics.push(diag("DANGLING_TYPE_REF", `Unknown type reference: ${parsed.element}`, undefined, owner));
  };
  const field = (f: FieldDeclaration, owner: string) => {
    ref(f.typeRef, owner);
    if (f.enum === undefined) return;
    const parsed = parseTypeRef(f.typeRef);
    if (parsed !== undefined && parsed.element !== "string") diagnostics.push(diag("ENUM_ON_NON_STRING_TYPE", `Field '${f.name}' declares an enum but its element type is '${parsed.element}'; only 'string' carries enum values`, undefined, owner));
    const seen = new Set<string>();
    for (const value of f.enum) { if (seen.has(value)) diagnostics.push(diag("DUPLICATE_ENUM_VALUE", `Field '${f.name}' repeats enum value '${value}'`, undefined, owner)); seen.add(value); }
  };
  for (const d of definitions) { const owner = `${d.kind}:${d.name}`; if (d.kind === "type") for (const f of d.fields) field(f, owner); if (d.kind === "function" || d.kind === "action") { for (const f of d.inputs) field(f, owner); ref(d.output, owner); } if (d.kind === "relation") { ref(d.from, owner, "scalar"); ref(d.to, owner, "scalar"); if (d.inverse && !relations.has(d.inverse)) diagnostics.push(diag("DANGLING_RELATION_REF", `Unknown inverse relation: ${d.inverse}`, undefined, owner)); } if (d.kind === "projection") { for (const [group, members] of Object.entries(d.typeGroups)) for (const member of members) ref(member, `${owner}/group:${group}`, "scalar"); for (const rule of d.rules) if (rule.typeRef) { if (rule.typeRef.startsWith("group:")) { const group = rule.typeRef.slice("group:".length); if (!(group in d.typeGroups)) diagnostics.push(diag("DANGLING_TYPE_GROUP_REF", `Unknown projection type group: ${group}`, undefined, owner)); } else ref(rule.typeRef, `${owner}/rule`, "scalar"); } } if (d.kind === "retrieval-profile" && !projections.has(d.projection)) diagnostics.push(diag("DANGLING_PROJECTION_REF", `Unknown projection: ${d.projection}`, undefined, owner)); if (d.kind === "migration") for (const step of d.steps) { if ("renameField" in step) { ref(step.renameField.type, owner, "scalar"); const target = definitions.find(x => x.kind === "type" && x.name === step.renameField.type); if (target?.kind === "type" && !target.fields.some(f => f.name === step.renameField.to)) diagnostics.push(diag("MIGRATION_TARGET_FIELD_UNKNOWN", `Migration target field is not declared: ${step.renameField.type}.${step.renameField.to}`, undefined, owner)); } else if ("mapRelation" in step) { if (!relations.has(step.mapRelation.to)) diagnostics.push(diag("MIGRATION_TARGET_RELATION_UNKNOWN", `Migration target relation is not declared: ${step.mapRelation.to}`, undefined, owner)); } else { ref(step.setDefault.type, owner, "scalar"); const target = definitions.find(x => x.kind === "type" && x.name === step.setDefault.type); if (target?.kind === "type" && !target.fields.some(f => f.name === step.setDefault.field)) diagnostics.push(diag("MIGRATION_DEFAULT_FIELD_UNKNOWN", `Migration default field is not declared: ${step.setDefault.type}.${step.setDefault.field}`, undefined, owner)); } } }
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

export {
  MODEL_LOCK_FILE,
  MODEL_LOCK_VERSION,
  computeModelSchemaDigest,
  createModelLock,
  writeModelLock,
  sha256 as computeModelFileDigest,
  type ModelLock,
  type ModelLockEntry,
  type ModelLockFileEntry,
} from "./model-lock.ts";
export {
  applyMigration,
  rollbackMigration,
  type MigratableRelation,
  type MigratableUnit,
  type MigrationApplyResult,
  type MigrationDiagnostic,
} from "./migration.ts";
