import type { AtomDeclaration, UnitDeclaration, ValueNode } from "@skill-wiki/types";
import type { LoadedModel, TypeDefinition } from "@skill-wiki/model-schema";
import type { GraphEdgeIR, SourceRefIR, TypedValueIR, UnitIR, ValueIR } from "@skill-wiki/ir";
import { buildRelationIndex, type RelationIndex } from "./relation-semantics";

export interface NormalizeDiagnostic { readonly code: string; readonly message: string; readonly field?: string; readonly typeRef?: string; readonly source: SourceRefIR }
/**
 * `id` lets the caller supply the corpus-resolved unit id.
 *
 * Without it the only identity available here is the declaration name
 * (`fact WaterBoilsAt100C`), while the corpus addresses the same unit as
 * `@example/fact-water-boils-at-100c` — the id its `id:` field declares. Every
 * relation edge's `from` and every emitted directory path is keyed on that id,
 * so leaving it to be re-derived downstream is how two paths end up with two
 * different identities for one unit.
 */
export interface NormalizeContext {
  readonly corpus: string;
  readonly version: string;
  readonly digest: string;
  readonly id?: string;
  readonly lifecycle?: UnitIR["lifecycle"];
  readonly visibility?: UnitIR["visibility"];
  /** Optional corpus-level resolver. `undefined` means the value is not a unit edge. */
  readonly resolveRelationTarget?: (target: string, relation: string) => string | undefined;
  readonly onUnresolvedRelation?: (target: string, relation: string) => void;
}
export type NormalizeResult = { ok: true; value: UnitIR } | { ok: false; diagnostics: readonly NormalizeDiagnostic[] };
type ConvertResult = { ok: true; value: TypedValueIR } | { ok: false; code: string };
const scalarTypes = new Set(["string", "number", "boolean", "integer", "unknown"]);
const sourceOf = (node: { loc: { line: number; column: number; offset: number } }, filename?: string): SourceRefIR => ({ filename, loc: node.loc });

/**
 * `_meta` is the protocol envelope, not a field in a domain type.
 *
 * Keeping it out of `UnitIR.fields` is what lets a corpus attach licence and
 * provenance without forcing every external Model Package to repeat those
 * engine-level declarations on every type. The underscore also prevents a
 * collision with legitimate domain fields such as Nielsen taxonomy's `source`
 * relation.
 */
const PROTOCOL_META_FIELD = "_meta";

function valueIR(value: ValueNode): ValueIR | undefined {
  if (value.type === "String" || value.type === "Ident" || value.type === "EnumValue") return value.value;
  if (value.type === "Number" || value.type === "Boolean") return value.value;
  if (value.type === "Reference") return value.path.join("/");
  if (value.type === "Array") {
    const items = value.items.map(valueIR);
    return items.some(item => item === undefined) ? undefined : items as ValueIR[];
  }
  if (value.type === "Object") {
    const entries: [string, ValueIR][] = [];
    for (const field of value.fields) {
      const converted = valueIR(field.value);
      if (converted === undefined) return undefined;
      entries.push([field.key, converted]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

/** Build the model-qualified form of a type name: `@<model>/<type>`. */
export function qualifyTypeRef(modelName: string, typeName: string): string { return `@${modelName}/${typeName}`; }

/**
 * Resolve a possibly model-qualified type reference against the loaded model.
 *
 * A bare `fact` resolves as-is. `@prime-v1-compatibility/fact` resolves to
 * `fact` when the prefix names the loaded model. A reference to some *other*
 * model resolves to `undefined` rather than silently falling through to a bare
 * name — a Runtime loads one model package, and pretending otherwise would let
 * two models' types collide unnoticed.
 */
function resolveTypeRef(typeRef: string, model: LoadedModel): string | undefined {
  if (!typeRef.startsWith("@")) return typeRef;
  const separator = typeRef.indexOf("/");
  if (separator < 0) return typeRef;
  const modelName = typeRef.slice(1, separator);
  if (modelName !== model.manifest.name) return undefined;
  return typeRef.slice(separator + 1);
}

function convertUnknown(value: ValueNode, filename?: string): ConvertResult {
  const source = sourceOf(value, filename);
  if (value.type === "String") return { ok: true, value: { kind: "string", value: value.value, source, declaredTypeRef: "unknown" } };
  // A bare word (`domain: physics`, `confidence: strong`) is lexically an
  // Ident, not a String — the language has no quoting rule that would make it
  // one. Semantically it is still a scalar string: the v1 corpus uses Ident
  // purely as an unquoted string literal, never as a symbolic enum consumed by
  // engine logic (there is no `switch (value)` anywhere that keys on this).
  // `declaredTypeRef: "ident"` (rather than "unknown") keeps that provenance
  // visible in the IR without adding a TypedValueIR variant — `packages/ir` is
  // a read-only shared contract (LANE-BRIEF §2.8); a new "ident" kind there is
  // the kind of change every consumer would need, not one this lane can make.
  if (value.type === "Ident") return { ok: true, value: { kind: "string", value: value.value, source, declaredTypeRef: "ident" } };
  if (value.type === "Number") return { ok: true, value: { kind: "number", value: value.value, source, declaredTypeRef: "unknown" } };
  // `@example-framer-page-transition` lexes as AT_DECORATOR and parses to
  // `EnumValue`, the node the language uses for `@decidable`-style markers. In
  // the v1 corpus the same spelling is also how an unscoped unit id is written
  // inside a relation array, and there is no lexical rule that separates the
  // two. Rejecting the node made one whole source file uncompilable
  // (`UNSUPPORTED_VALUE`) while the legacy stack accepted it, so it is read as
  // the scalar string it spells; `declaredTypeRef: "enum"` keeps the provenance
  // visible for a model that later declares a real enum typeRef.
  if (value.type === "EnumValue") return { ok: true, value: { kind: "string", value: value.value, source, declaredTypeRef: "enum" } };
  if (value.type === "Boolean") return { ok: true, value: { kind: "boolean", value: value.value, source, declaredTypeRef: "unknown" } };
  if (value.type === "Reference") return { ok: true, value: { kind: "reference", path: value.path, target: value.path.join("."), alias: value.alias, source, declaredTypeRef: "unknown" } };
  if (value.type === "Array") { const items: TypedValueIR[] = []; for (const item of value.items) { const converted = convertUnknown(item, filename); if (!converted.ok) return converted; items.push(converted.value); } return { ok: true, value: { kind: "array", items, source, declaredTypeRef: "unknown" } }; }
  if (value.type === "Object") { const fields: Record<string, TypedValueIR> = {}; for (const field of value.fields) { const converted = convertUnknown(field.value, filename); if (!converted.ok) return converted; fields[field.key] = converted.value; } return { ok: true, value: { kind: "object", fields, source, declaredTypeRef: "unknown" } }; }
  return { ok: false, code: "UNSUPPORTED_VALUE" };
}

/**
 * The target of one relation value.
 *
 * `String`, `Ident` and `Reference` are all legal spellings of a unit id in the
 * v1 corpus — `related: [@example/term-celsius]` lexes as `Ident`, not
 * `Reference`, because the language has no sigil rule that would make it one.
 * Anything else is not an id and is skipped rather than coerced.
 */
function relationTarget(value: ValueNode): string {
  if (value.type === "String" || value.type === "Ident") return value.value;
  if (value.type === "Reference") return value.path.join("/");
  return "";
}

/**
 * Lift the unit's link declarations into `UnitIR.relations`.
 *
 * Which field keys are relations, and what the canonical name of each spelling
 * is, are **model facts** read through `RelationIndex` — there is no relation
 * name literal here (D-3 forbids a third hand-written narrowing).
 *
 * Edge ids are `from|relation|to`, which is stable across runs and across
 * source reordering: `computeCompiledUnitContentDigest` sorts relations by id,
 * so a counter-based id would make the content digest depend on declaration
 * order. The same triple is the dedup key, reproducing the legacy emitter's
 * `(type, target)` dedup.
 */
function extractRelations(
  body: readonly { key: string; value: ValueNode }[],
  from: string,
  index: RelationIndex,
  context: NormalizeContext,
): GraphEdgeIR[] {
  const edges: GraphEdgeIR[] = [];
  const seen = new Set<string>();
  for (const field of body) {
    const definition = index.definition(field.key);
    if (!definition) continue;
    const values = field.value.type === "Array" ? field.value.items : [field.value];
    for (const item of values) {
      const raw = relationTarget(item);
      if (!raw) continue;
      const to = context.resolveRelationTarget?.(raw, definition.name) ?? (context.resolveRelationTarget === undefined ? raw : undefined);
      if (to === undefined) { context.onUnresolvedRelation?.(raw, definition.name); continue; }
      const id = `${from}|${definition.name}|${to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, relationRef: definition.name, from, to });
    }
  }
  return edges;
}

/**
 * One relation index per loaded model.
 *
 * Built from the model that was handed in rather than from
 * `defaultRelationIndex()`: normalization already knows which model package it
 * is normalizing against, and reaching for the v1 default here would make a
 * second model silently inherit v1's relation set.
 */
const relationIndexes = new WeakMap<LoadedModel, RelationIndex>();
function relationIndexFor(model: LoadedModel): RelationIndex {
  let index = relationIndexes.get(model);
  if (!index) { index = buildRelationIndex(model); relationIndexes.set(model, index); }
  return index;
}

function convert(value: ValueNode, expected: string, filename: string | undefined, knownTypes: Set<string>): ConvertResult {
  if (expected === "unknown") return convertUnknown(value, filename);
  const source = sourceOf(value, filename);
  if (!scalarTypes.has(expected)) {
    if (!knownTypes.has(expected)) return { ok: false, code: "UNKNOWN_DECLARED_TYPE_REF" };
    if (value.type !== "Reference") return { ok: false, code: "REFERENCE_MISMATCH" };
    if (value.path[0] !== expected) return { ok: false, code: "REFERENCE_TYPE_MISMATCH" };
    return { ok: true, value: { kind: "reference", path: value.path, target: value.path.join("."), alias: value.alias, source, declaredTypeRef: expected } };
  }
  if (expected === "string" && value.type === "String") return { ok: true, value: { kind: "string", value: value.value, source, declaredTypeRef: expected } };
  if ((expected === "number" || expected === "integer") && value.type === "Number" && (expected !== "integer" || Number.isInteger(value.value))) return { ok: true, value: { kind: "number", value: value.value, source, declaredTypeRef: expected } };
  if (expected === "boolean" && value.type === "Boolean") return { ok: true, value: { kind: "boolean", value: value.value, source, declaredTypeRef: expected } };
  return { ok: false, code: "PRIMITIVE_MISMATCH" };
}

function normalize(name: string, typeRef: string, body: readonly { key: string; value: ValueNode; loc: { line: number; column: number; offset: number } }[], filename: string | undefined, declarationSource: SourceRefIR, model: LoadedModel, context: NormalizeContext): NormalizeResult {
  if (![context.corpus, context.version, context.digest].every(value => value.trim().length > 0)) return { ok: false, diagnostics: [{ code: "INVALID_NORMALIZE_CONTEXT", message: "corpus, version, and digest must be non-empty", source: declarationSource }] };
  const resolved = resolveTypeRef(typeRef, model);
  if (resolved === undefined) return { ok: false, diagnostics: [{ code: "FOREIGN_MODEL_TYPE_REF", message: `Type reference belongs to another model package: ${typeRef}`, typeRef, source: declarationSource }] };
  const type = model.definitions.find((definition): definition is TypeDefinition => definition.kind === "type" && definition.name === resolved);
  if (!type) return { ok: false, diagnostics: [{ code: "UNKNOWN_TYPE", message: `Unknown model type: ${resolved}`, typeRef: resolved, source: declarationSource }] };
  const definitions = new Map(type.fields.map(field => [field.name, field])); const knownTypes = new Set(model.definitions.filter(d => d.kind === "type").map(d => d.name)); const fields: Record<string, TypedValueIR> = {}; const seen = new Set<string>(); const diagnostics: NormalizeDiagnostic[] = [];
  const relationIndex = relationIndexFor(model);
  let provenanceAttributes: Readonly<Record<string, ValueIR>> | undefined;
  for (const field of body) {
    const fieldSource = sourceOf(field, filename);
    if (seen.has(field.key)) { diagnostics.push({ code: "DUPLICATE_FIELD", message: `Duplicate field: ${field.key}`, field: field.key, source: fieldSource }); continue; }
    seen.add(field.key);
    if (field.key === PROTOCOL_META_FIELD) {
      const converted = valueIR(field.value);
      if (converted === undefined || converted === null || Array.isArray(converted) || typeof converted !== "object") {
        diagnostics.push({ code: "INVALID_PROTOCOL_META", message: "Protocol _meta must be an object containing JSON-compatible values", field: field.key, source: fieldSource });
      } else {
        provenanceAttributes = converted as Readonly<Record<string, ValueIR>>;
      }
      continue;
    }
    // Relations are part of the generic Unit envelope, not ordinary domain
    // fields. A model may declare `extends` without repeating it on every type;
    // RelationDefinition is the authority for its shape and semantics.
    if (relationIndex.definition(field.key) !== undefined) continue;
    const definition = definitions.get(field.key);
    if (!definition && type.additionalFields === "reject") { diagnostics.push({ code: "UNKNOWN_FIELD", message: `Unknown field: ${field.key}`, field: field.key, typeRef: resolved, source: fieldSource }); continue; }
    const expected = definition?.typeRef ?? "unknown";
    const converted = convert(field.value, expected, filename, knownTypes);
    if (!converted.ok) { diagnostics.push({ code: converted.code, message: `Field '${field.key}' does not match ${expected}`, field: field.key, typeRef: expected, source: fieldSource }); continue; }
    fields[field.key] = converted.value;
  }
  for (const definition of type.fields) if (definition.required && !fields[definition.name]) diagnostics.push({ code: "MISSING_REQUIRED_FIELD", message: `Missing required field: ${definition.name}`, field: definition.name, typeRef: resolved, source: declarationSource });
  if (diagnostics.length) return { ok: false, diagnostics };
  const id = context.id ?? name;
  return { ok: true, value: { identity: { id, version: context.version, digest: context.digest, corpus: context.corpus }, typeRef: resolved as UnitIR["typeRef"], implements: [], fields, relations: extractRelations(body, id, relationIndex, context), citations: [], policyLabels: [], lifecycle: context.lifecycle ?? "active", visibility: context.visibility ?? "shared", provenance: { source: declarationSource, ...(provenanceAttributes === undefined ? {} : { attributes: provenanceAttributes }) }, projections: {} } };
}
export function normalizeUnit(ast: UnitDeclaration, model: LoadedModel, context: NormalizeContext): NormalizeResult { return normalize(ast.name, ast.typeRef.name, ast.body, ast.filename, sourceOf(ast, ast.filename), model, context); }

/**
 * Plan §6.3 — the v1 syntax macro.
 *
 * Rewrites a kind-form declaration into the generic envelope:
 *
 *   fact Foo { … }   →   unit Foo : @prime-v1-compatibility/fact { … }
 *
 * This is what lets an untouched `.prime` file compile on an engine that has no
 * built-in kinds: the kind survives only as a model-qualified type reference,
 * and everything downstream sees a plain UnitDeclaration. The macro is
 * load-bearing, not documentation — `normalizePrimeV1Atom` goes through it, so
 * there is exactly one normalization path rather than a legacy fork.
 */
export function applyV1SyntaxMacro(ast: AtomDeclaration, modelName: string): UnitDeclaration {
  const declaration: UnitDeclaration = {
    type: "UnitDeclaration",
    name: ast.name,
    typeRef: { type: "TypeRef", name: qualifyTypeRef(modelName, ast.kind), loc: ast.loc },
    decorators: ast.decorators,
    body: ast.body,
    loc: ast.loc,
  };
  if (ast.filename !== undefined) declaration.filename = ast.filename;
  return declaration;
}

export function normalizePrimeV1Atom(ast: AtomDeclaration, model: LoadedModel, context: NormalizeContext): NormalizeResult {
  return normalizeUnit(applyV1SyntaxMacro(ast, model.manifest.name), model, context);
}

/** A declared scalar field of a v1 atom, accepting the quoted and bare spellings alike. */
function declaredField(ast: AtomDeclaration | UnitDeclaration, key: string): string {
  const field = ast.body.find(entry => entry.key === key);
  if (!field) return "";
  if (field.value.type === "String" || field.value.type === "Ident") return field.value.value;
  return "";
}

/**
 * The corpus-resolved id of a v1 atom, for `NormalizeContext.id`.
 *
 * This is the v1 addressing convention, so it belongs beside the v1 syntax
 * macro: the id a `.prime` file declares (or the module-prefixed one it
 * implies) is the key every relation edge's `from` and every emitted artifact
 * directory is built on. It lived privately inside the legacy atom-dir emitter,
 * which meant deleting that emitter would have silently changed every unit's
 * identity; the caller cannot re-derive it without copying these four rules.
 */
export function deriveV1AtomId(ast: AtomDeclaration | UnitDeclaration): string {
  const name = declaredField(ast, "name") || ast.name;
  const declaredId = declaredField(ast, "id");
  if (declaredId) return declaredId;
  const module = declaredField(ast, "module");
  const bare = name.replace(/^m\d+-/, "");
  if (/^M\d+$/.test(module)) return `@${module}/${bare}`;
  const prefixed = name.match(/^(m\d+)-/);
  if (prefixed) return `@${prefixed[1]!.toUpperCase()}/${bare}`;
  return `@prime/${name}`;
}
