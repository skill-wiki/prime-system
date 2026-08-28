import type { AtomDeclaration, UnitDeclaration, ValueNode } from "@skill-wiki/types";
import type { LoadedModel, TypeDefinition } from "@skill-wiki/model-schema";
import type { SourceRefIR, TypedValueIR, UnitIR } from "@skill-wiki/ir";

export interface NormalizeDiagnostic { readonly code: string; readonly message: string; readonly field?: string; readonly typeRef?: string; readonly source: SourceRefIR }
export interface NormalizeContext { readonly corpus: string; readonly version: string; readonly digest: string; readonly lifecycle?: UnitIR["lifecycle"]; readonly visibility?: UnitIR["visibility"] }
export type NormalizeResult = { ok: true; value: UnitIR } | { ok: false; diagnostics: readonly NormalizeDiagnostic[] };
type ConvertResult = { ok: true; value: TypedValueIR } | { ok: false; code: string };
const scalarTypes = new Set(["string", "number", "boolean", "integer", "unknown"]);
const sourceOf = (node: { loc: { line: number; column: number; offset: number } }, filename?: string): SourceRefIR => ({ filename, loc: node.loc });

function convertUnknown(value: ValueNode, filename?: string): ConvertResult {
  const source = sourceOf(value, filename);
  if (value.type === "String") return { ok: true, value: { kind: "string", value: value.value, source, declaredTypeRef: "unknown" } };
  if (value.type === "Number") return { ok: true, value: { kind: "number", value: value.value, source, declaredTypeRef: "unknown" } };
  if (value.type === "Boolean") return { ok: true, value: { kind: "boolean", value: value.value, source, declaredTypeRef: "unknown" } };
  if (value.type === "Reference") return { ok: true, value: { kind: "reference", path: value.path, target: value.path.join("."), alias: value.alias, source, declaredTypeRef: "unknown" } };
  if (value.type === "Array") { const items: TypedValueIR[] = []; for (const item of value.items) { const converted = convertUnknown(item, filename); if (!converted.ok) return converted; items.push(converted.value); } return { ok: true, value: { kind: "array", items, source, declaredTypeRef: "unknown" } }; }
  if (value.type === "Object") { const fields: Record<string, TypedValueIR> = {}; for (const field of value.fields) { const converted = convertUnknown(field.value, filename); if (!converted.ok) return converted; fields[field.key] = converted.value; } return { ok: true, value: { kind: "object", fields, source, declaredTypeRef: "unknown" } }; }
  return { ok: false, code: "UNSUPPORTED_VALUE" };
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
  const type = model.definitions.find((definition): definition is TypeDefinition => definition.kind === "type" && definition.name === typeRef);
  if (!type) return { ok: false, diagnostics: [{ code: "UNKNOWN_TYPE", message: `Unknown model type: ${typeRef}`, typeRef, source: declarationSource }] };
  const definitions = new Map(type.fields.map(field => [field.name, field])); const knownTypes = new Set(model.definitions.filter(d => d.kind === "type").map(d => d.name)); const fields: Record<string, TypedValueIR> = {}; const seen = new Set<string>(); const diagnostics: NormalizeDiagnostic[] = [];
  for (const field of body) { const fieldSource = sourceOf(field, filename); if (seen.has(field.key)) { diagnostics.push({ code: "DUPLICATE_FIELD", message: `Duplicate field: ${field.key}`, field: field.key, source: fieldSource }); continue; } seen.add(field.key); const definition = definitions.get(field.key); if (!definition && type.additionalFields === "reject") { diagnostics.push({ code: "UNKNOWN_FIELD", message: `Unknown field: ${field.key}`, field: field.key, typeRef, source: fieldSource }); continue; } const expected = definition?.typeRef ?? "unknown"; const converted = convert(field.value, expected, filename, knownTypes); if (!converted.ok) { diagnostics.push({ code: converted.code, message: `Field '${field.key}' does not match ${expected}`, field: field.key, typeRef: expected, source: fieldSource }); continue; } fields[field.key] = converted.value; }
  for (const definition of type.fields) if (definition.required && !fields[definition.name]) diagnostics.push({ code: "MISSING_REQUIRED_FIELD", message: `Missing required field: ${definition.name}`, field: definition.name, typeRef, source: declarationSource });
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: { identity: { id: name, version: context.version, digest: context.digest, corpus: context.corpus }, typeRef: typeRef as UnitIR["typeRef"], implements: [], fields, relations: [], citations: [], policyLabels: [], lifecycle: context.lifecycle ?? "active", visibility: context.visibility ?? "shared", provenance: { source: declarationSource }, projections: {} } };
}
export function normalizeUnit(ast: UnitDeclaration, model: LoadedModel, context: NormalizeContext): NormalizeResult { return normalize(ast.name, ast.typeRef.name, ast.body, ast.filename, sourceOf(ast, ast.filename), model, context); }
export function normalizePrimeV1Atom(ast: AtomDeclaration, model: LoadedModel, context: NormalizeContext): NormalizeResult { return normalize(ast.name, ast.kind, ast.body, ast.filename, sourceOf(ast, ast.filename), model, context); }
