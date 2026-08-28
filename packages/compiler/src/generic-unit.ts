import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { parse } from "@skill-wiki/parser";
import type { LoadedModel, ProjectionDefinition } from "@skill-wiki/model-schema";
import type { CompiledUnitIR, ProjectionArtifactIR, TypedValueIR, UnitIR, ValueIR } from "@skill-wiki/ir";
import type { AtomMeta } from "./global-index-emitter";
import { buildChunkProjectionRules, chunkNamedLayers, estimateTokens, usesSectionVocabulary, type ChunkableAST, type ChunkProjectionRules } from "./chunker";
import { normalizeUnit, type NormalizeContext, type NormalizeDiagnostic } from "./normalizer";

export interface CompileUnitOptions { readonly projections?: readonly string[]; }
export type CompileUnitDiagnostic = NormalizeDiagnostic | { readonly code: string; readonly message: string; readonly source?: { readonly filename?: string; readonly loc: { readonly line: number; readonly column: number; readonly offset: number } } };
export type CompileUnitResult = { readonly ok: true; readonly value: CompiledUnitIR } | { readonly ok: false; readonly diagnostics: readonly CompileUnitDiagnostic[] };
export interface EmitCompiledUnitResult { readonly directory: string; readonly meta: AtomMeta; readonly files: readonly string[]; }

const sha256 = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
/**
 * Token estimate, delegated to the chunker's estimator.
 *
 * It counts characters, not bytes. That difference is not cosmetic on this
 * corpus: `100°C` is 5 characters and 6 bytes, so a byte-based count reports a
 * different budget than the one the baseline `_index.xml` was built with.
 * One estimator, one number.
 */
const tokenCount = (content: string) => estimateTokens(content);
const genericSource = { loc: { line: 0, column: 0, offset: 0 } };
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function framedDigest(parts: readonly string[]): string { const hash = createHash("sha256"); for (const part of parts) { const bytes = Buffer.from(part, "utf8"); hash.update(`${bytes.length}:`); hash.update(bytes); hash.update(";"); } return `sha256:${hash.digest("hex")}`; }
function stableValue(value: ValueIR): ValueIR { if (Array.isArray(value)) return value.map(stableValue); if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, stableValue(item)])); return value; }
function stableTypedValue(value: TypedValueIR): unknown { if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") return { kind: value.kind, value: value.value, declaredTypeRef: value.declaredTypeRef }; if (value.kind === "reference") return { kind: value.kind, path: value.path, target: value.target, alias: value.alias, declaredTypeRef: value.declaredTypeRef }; if (value.kind === "array") return { kind: value.kind, items: value.items.map(stableTypedValue), declaredTypeRef: value.declaredTypeRef }; return { kind: value.kind, fields: Object.fromEntries(Object.entries(value.fields).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, stableTypedValue(item)])), declaredTypeRef: value.declaredTypeRef }; }
/** Canonical digest authority for portable compiled unit artifacts. */
export function computeCompiledUnitContentDigest(unit: UnitIR, projections: Readonly<Record<string, ProjectionArtifactIR>>): string {
  const envelope = { identity: unit.identity, typeRef: unit.typeRef, implements: unit.implements, fields: Object.fromEntries(Object.entries(unit.fields).sort(([a], [b]) => compare(a, b)).map(([key, value]) => [key, stableTypedValue(value)])), relations: [...unit.relations].sort((a, b) => compare(a.id, b.id)).map(edge => ({ id: edge.id, relationRef: edge.relationRef, from: edge.from, to: edge.to, attributes: edge.attributes && stableValue(edge.attributes) })), citations: unit.citations, policyLabels: unit.policyLabels, lifecycle: unit.lifecycle, visibility: unit.visibility };
  return framedDigest([JSON.stringify(envelope), ...Object.values(projections).sort((a, b) => compare(a.name, b.name)).flatMap(artifact => [artifact.name, artifact.path, artifact.digest, String(artifact.bytes), String(artifact.tokens), JSON.stringify(artifact.selectors)])]);
}

function selectedProjections(model: LoadedModel, requested?: readonly string[]): { ok: true; value: readonly ProjectionDefinition[] } | { ok: false; diagnostics: readonly CompileUnitDiagnostic[] } {
  const all = model.definitions.filter((d): d is ProjectionDefinition => d.kind === "projection");
  const names = requested ? [...requested] : all.map(x => x.name);
  const seen = new Set<string>(); const diagnostics: CompileUnitDiagnostic[] = [];
  for (const name of names) {
    if (seen.has(name)) diagnostics.push({ code: "DUPLICATE_PROJECTION", message: `Projection requested more than once: ${name}`, source: genericSource });
    seen.add(name);
    if (!all.some(x => x.name === name)) diagnostics.push({ code: "UNKNOWN_PROJECTION", message: `Unknown model projection: ${name}`, source: genericSource });
    else { try { safeName(name); } catch { diagnostics.push({ code: "UNSAFE_PROJECTION_NAME", message: `Projection name cannot be used as a safe artifact filename: ${name}`, source: genericSource }); } }
  }
  if (!names.length) diagnostics.push({ code: "NO_PROJECTIONS", message: "The model has no projections and none were selected.", source: genericSource });
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, value: names.map(name => all.find(x => x.name === name)!) };
}

function toValue(value: TypedValueIR): ValueIR {
  if (value.kind === "string" || value.kind === "number" || value.kind === "boolean") return value.value;
  if (value.kind === "reference") return value.target;
  if (value.kind === "array") return value.items.map(toValue);
  return Object.fromEntries(Object.entries(value.fields).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, toValue(item)]));
}
function firstString(value: TypedValueIR): string | undefined { if (value.kind === "string") return value.value; if (value.kind === "array") for (const item of value.items) { const found = firstString(item); if (found !== undefined) return found; } if (value.kind === "object") for (const [, item] of Object.entries(value.fields).sort(([a], [b]) => compare(a, b))) { const found = firstString(item); if (found !== undefined) return found; } return undefined; }
/** A declared scalar field, read as the corpus wrote it. */
function declaredScalar(unit: UnitIR, field: string): string | undefined { const value = unit.fields[field]; return value?.kind === "string" ? value.value : undefined; }
function declaredStrings(unit: UnitIR, field: string): readonly string[] { const value = unit.fields[field]; return value?.kind === "array" ? value.items.flatMap(item => item.kind === "string" ? [item.value] : []) : []; }
/**
 * `description` is the unit's own declared description.
 *
 * It used to be "the first string found in the alphabetically first field",
 * which on the v1 corpus resolved to `applies-to[0]` rather than `statement` —
 * a value no source file ever asked to be the description. The declared field
 * is read first; the scan survives only as the fallback for a model whose type
 * has no `description`, and the id is the last resort because
 * `finalizeCorpusBundle` rejects an empty one.
 */
function declaredDescription(unit: UnitIR): string {
  const declared = declaredScalar(unit, "description");
  const scanned = declared ?? Object.entries(unit.fields).sort(([a], [b]) => compare(a, b)).map(([, value]) => firstString(value)).find((value): value is string => value !== undefined);
  return (scanned ?? "").replace(/\s+/g, " ").trim() || unit.identity.id;
}
/** Markdown scalar contract: all strings (including references) are JSON quoted. */
function renderValue(value: ValueIR): string { return JSON.stringify(value); }
function match(selector: string, field: string): boolean {
  if (selector === "*") return true;
  if (selector === `meta.${field}` || selector === `meta:${field}`) return true;
  if (selector === "meta:*" || selector === "meta.*") return field.startsWith("meta.");
  if (selector.endsWith("*")) return field.startsWith(selector.slice(0, -1));
  return selector === field || selector === `fields.${field}`;
}
/** The selectors a layer honoured, for the artifact record. */
function layerSelectors(definition: ProjectionDefinition, rules: ChunkProjectionRules, typeRef: string): readonly string[] {
  const group = Object.entries(rules.groupOfType).find(([type]) => type === typeRef.toLowerCase())?.[1] ?? rules.defaultGroup;
  return [...new Set([...definition.include, ...(rules.sections[definition.name]?.[group] ?? [])])].sort(compare);
}
/**
 * Render a projection declared as a set of FIELD selectors.
 *
 * This is not a second renderer for the v1 corpus — `usesSectionVocabulary`
 * routes that corpus to the chunker. It is the only renderer for a model whose
 * `ProjectionDefinition` names fields rather than the engine's section
 * vocabulary (`packages/model-schema/test/fixtures/ticket-model` does exactly
 * that), and deleting it would make an unknown model uncompilable — the ADR-1
 * property plan §21 uses as its judgement criterion.
 */
function renderSelectedFields(unit: UnitIR, definition: ProjectionDefinition): { content: string; selectors: readonly string[] } {
  const selectors = [...definition.include]; const excluded = [...definition.exclude];
  for (const rule of definition.rules) {
    const applies = !rule.typeRef || rule.typeRef === "*" || rule.typeRef === unit.typeRef || (rule.typeRef.startsWith("group:") && (definition.typeGroups[rule.typeRef.slice(6)] ?? []).includes(unit.typeRef));
    if (applies) { selectors.push(...(rule.include ?? [])); excluded.push(...(rule.exclude ?? [])); }
  }
  const visible = Object.entries(unit.fields).sort(([a], [b]) => compare(a, b)).filter(([name]) =>
    (selectors.length === 0 || selectors.some(s => match(s, name))) && !excluded.some(s => match(s, name)),
  );
  const meta: readonly [string, ValueIR][] = [
    ["meta.id", unit.identity.id], ["meta.version", unit.identity.version], ["meta.digest", unit.identity.digest], ["meta.corpus", unit.identity.corpus], ["meta.typeRef", unit.typeRef],
    ["meta.implements", unit.implements], ["meta.citations", unit.citations], ["meta.policyLabels", unit.policyLabels], ["meta.lifecycle", unit.lifecycle], ["meta.visibility", unit.visibility],
  ];
  const visibleMeta = meta.filter(([name]) => selectors.some(s => match(s, name)) && !excluded.some(s => match(s, name)));
  const lines = [`# ${unit.identity.id}`, `type: ${unit.typeRef}`, `projection: ${definition.name}`];
  for (const [name, value] of visibleMeta) lines.push(`${name}: ${renderValue(value)}`);
  for (const [name, value] of visible) lines.push(`${name}: ${renderValue(toValue(value))}`);
  return { content: lines.join("\n") + "\n", selectors: [...new Set(selectors)].sort(compare) };
}

/**
 * Render projections for an already-normalized unit.
 *
 * `ast` is required, and is the whole point of this lane: the projection
 * renderer is `chunker.chunk*`, the same function the legacy atom-dir emitter
 * calls, reading the same AST. Byte equality with the production corpus is
 * therefore a property of the construction rather than something measured after
 * the fact. The previous implementation rendered a second time from `UnitIR`
 * with its own `JSON.stringify` field dump and agreed with production on 0 of
 * 96 projections.
 *
 * Split out of `compileUnit` because normalization has more than one front end:
 * the generic `unit` syntax goes through `normalizeUnit`, while an untouched v1
 * `.prime` atom goes through `normalizePrimeV1Atom` (plan §6.3 syntax macro).
 */
export function compileNormalizedUnit(unit: UnitIR, ast: ChunkableAST, model: LoadedModel, options: CompileUnitOptions = {}): CompileUnitResult {
  const selection = selectedProjections(model, options.projections);
  if (!selection.ok) return selection;
  const declared = model.definitions.filter((d): d is ProjectionDefinition => d.kind === "projection");
  const rules = buildChunkProjectionRules(declared);
  // A model that declares section names is rendered by the layer chain; a model
  // that declares plain field selectors is rendered by the selector renderer
  // below. See `usesSectionVocabulary` and the W6-A report §3.3 — the protocol
  // has no field that states which contract a projection means, so the
  // selectors themselves are the only data available to dispatch on.
  const layers = usesSectionVocabulary(ast, rules)
    ? chunkNamedLayers(ast, declared.map(definition => definition.name), rules)
    : undefined;
  const projections: Record<string, ProjectionArtifactIR> = {};
  for (const definition of selection.value) {
    const layer = layers?.get(definition.name);
    const rendered = layer === undefined
      ? renderSelectedFields(unit, definition)
      : { content: `${layer}\n`, selectors: layerSelectors(definition, rules, unit.typeRef) };
    const path = `chunks/${safeName(definition.name)}.md`;
    projections[definition.name] = { name: definition.name, path, content: rendered.content, bytes: Buffer.byteLength(rendered.content, "utf8"), digest: sha256(rendered.content), tokens: tokenCount(rendered.content), selectors: rendered.selectors };
  }
  const tokens = Object.fromEntries(Object.entries(projections).map(([name, artifact]) => [name, artifact.tokens]));
  const contentDigest = computeCompiledUnitContentDigest(unit, projections);
  return { ok: true, value: { kind: "compiled-unit", unit, projections, meta: { id: unit.identity.id, kind: unit.typeRef, version: unit.identity.version, description: declaredDescription(unit), domain: declaredScalar(unit, "domain") ?? unit.identity.corpus, tags: declaredStrings(unit, "tags"), tokens, projection: Object.fromEntries(Object.entries(projections).sort(([a], [b]) => compare(a, b)).map(([name, artifact]) => [name, artifact.path])), contentDigest } } };
}

/** Parse, normalize, and render a generic `unit` declaration without legacy compiler stages. */
export function compileUnit(source: string, model: LoadedModel, context: NormalizeContext, options: CompileUnitOptions = {}): CompileUnitResult {
  const parsed = parse(source);
  if (parsed.errors.length) return { ok: false, diagnostics: parsed.errors.map(error => ({ code: "PARSE_ERROR", message: error.message, source: { filename: error.filename, loc: { line: error.line, column: error.column, offset: 0 } } })) };
  if (parsed.ast.type !== "UnitDeclaration") return { ok: false, diagnostics: [{ code: "EXPECTED_UNIT_DECLARATION", message: "Generic compilation requires a UnitDeclaration.", source: { filename: parsed.ast.filename, loc: parsed.ast.loc } }] };
  const normalized = normalizeUnit(parsed.ast, model, context);
  if (!normalized.ok) return normalized;
  return compileNormalizedUnit(normalized.value, parsed.ast, model, options);
}

function safeName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "." || name === "..") throw new Error(`Unsafe unit artifact name: ${name}`);
  return name;
}
function safeUnitDirectory(root: string, id: string): string {
  const rootPath = resolve(root); const segments = id.split("/");
  if (!segments.length || segments.some(segment => !/^[A-Za-z0-9@][A-Za-z0-9@._-]*$/.test(segment) || segment === "." || segment === "..")) throw new Error(`Unsafe unit id: ${id}`);
  const target = resolve(rootPath, ...segments);
  if (relative(rootPath, target).startsWith("..") || relative(rootPath, target) === "" || !target.startsWith(rootPath + sep)) throw new Error(`Unit output escapes root: ${id}`);
  return target;
}
function ensureRealDirectory(path: string): void {
  const absolute = resolve(path); const root = parsePath(absolute).root; let lexical: string = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) { lexical = join(lexical, part); if (!existsSync(lexical)) break; const stat = lstatSync(lexical); if (stat.isSymbolicLink()) throw new Error(`Refusing symlink ancestor: ${lexical}`); }
  if (!existsSync(path)) { let ancestor = path; const missing: string[] = []; while (!existsSync(ancestor)) { missing.push(ancestor); const parent = resolve(ancestor, ".."); if (parent === ancestor) throw new Error(`No safe ancestor for ${path}`); ancestor = parent; } const parentStat = lstatSync(ancestor); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`Refusing symlink ancestor: ${ancestor}`); for (const directory of missing.reverse()) { mkdirSync(directory); const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory or symlink path: ${directory}`); } }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory or symlink path: ${path}`);
}
function ensureSafeTarget(root: string, target: string): void {
  const rel = relative(root, target); let current = root;
  ensureRealDirectory(root);
  for (const part of rel.split(sep)) { if (!part) continue; current = join(current, part); if (!existsSync(current)) continue; const stat = lstatSync(current); if (stat.isSymbolicLink()) throw new Error(`Refusing symlink path segment: ${current}`); }
}
function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function yaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? "\n" + value.map(item => `${pad}- ${yaml(item, indent + 1)}`).join("\n") : "[]";
  return "\n" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${pad}${key}: ${yaml(item, indent + 1)}`).join("\n");
}
function atomYaml(compiled: CompiledUnitIR): string {
  const relations = compiled.unit.relations.map(edge => ({ type: edge.relationRef, target: edge.to }));
  return yaml({ id: compiled.meta.id, kind: compiled.meta.kind, version: compiled.meta.version, description: compiled.meta.description, tags: compiled.meta.tags, content_hash: compiled.meta.contentDigest, tokens: compiled.meta.tokens, projection: compiled.meta.projection, relations, quality: {} }).trimStart() + "\n";
}

/** Atomically emit a runtime-readable generic unit directory. */
export function emitCompiledUnit(compiled: CompiledUnitIR, outDir: string): EmitCompiledUnitResult {
  const target = safeUnitDirectory(outDir, compiled.meta.id); const root = resolve(outDir);
  ensureSafeTarget(root, target);
  if (compiled.meta.contentDigest !== computeCompiledUnitContentDigest(compiled.unit, compiled.projections)) throw new Error("Compiled unit metadata digest mismatch");
  const temp = join(root, `.${basename(target)}.stage-${process.pid}-${Date.now()}`); const backup = join(root, `.${basename(target)}.backup-${process.pid}-${Date.now()}`); rmSync(temp, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true });
  try {
    mkdirSync(join(temp, "chunks"), { recursive: true });
    const files: string[] = [];
    const write = (name: string, data: string) => { const path = join(temp, name); writeFileSync(path, data, "utf8"); files.push(name); };
    write("atom.yaml", atomYaml(compiled));
    write("graph.yaml", yaml({ edges: compiled.unit.relations.map(edge => ({ id: edge.id, relation: edge.relationRef, from: edge.from, to: edge.to })) }).trimStart() + "\n");
    for (const artifact of Object.values(compiled.projections).sort((a, b) => compare(a.name, b.name))) { if (artifact.path !== `chunks/${safeName(artifact.name)}.md`) throw new Error(`Unsafe projection artifact path: ${artifact.path}`); if (artifact.bytes !== Buffer.byteLength(artifact.content, "utf8") || artifact.digest !== sha256(artifact.content) || artifact.tokens !== tokenCount(artifact.content)) throw new Error(`Projection artifact integrity mismatch: ${artifact.name}`); write(artifact.path, artifact.content); }
    const index = `<unit id="${xml(compiled.meta.id)}" kind="${xml(compiled.meta.kind)}"/>\n`; write("index.xml", index);
    let hadTarget = false;
    if (existsSync(target)) { const stat = lstatSync(target); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing existing non-directory unit target: ${target}`); renameSync(target, backup); hadTarget = true; }
    mkdirSync(resolve(target, ".."), { recursive: true }); renameSync(temp, target);
    if (hadTarget) try { rmSync(backup, { recursive: true, force: true }); } catch { /* committed unit remains valid; stale backup is safe to clean later */ }
    const legacyTokens = (name: string) => compiled.meta.tokens[name] ?? 0;
    return { directory: target, files, meta: { id: compiled.meta.id, kind: compiled.meta.kind, version: compiled.meta.version, description: compiled.meta.description, domain: compiled.meta.domain, tags: [...compiled.meta.tags], tokens: { summary: legacyTokens("summary"), core: legacyTokens("core"), full: legacyTokens("full") }, quality: "0" } };
  } catch (error) { try { if (!existsSync(target) && existsSync(backup)) renameSync(backup, target); } finally { rmSync(temp, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); } throw error; }
}
