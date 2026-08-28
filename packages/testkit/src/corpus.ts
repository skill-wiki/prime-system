import { readFileSync, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";

/**
 * A corpus record is deliberately not a parser AST and not a compiler output:
 * the corpus suite must be runnable against any producer, so the exchange shape
 * is a plain readonly record that mirrors the identity/relation/lifecycle part
 * of `UnitIR` without dragging the compiler in.
 */

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const FieldValue: z.ZodType<unknown> = z.lazy(() => z.union([Scalar, z.array(FieldValue), z.record(z.string(), FieldValue)]));

const RelationRecordSchema = z.object({
  relation: z.string().min(1),
  to: z.string().min(1),
  attributes: z.record(z.string(), FieldValue).optional(),
}).strict();

const UnitRecordSchema = z.object({
  id: z.string().min(1),
  version: z.string().regex(semver, "must be strict SemVer"),
  typeRef: z.string().min(1),
  digest: z.string().optional(),
  fields: z.record(z.string(), FieldValue).default({}),
  relations: z.array(RelationRecordSchema).default([]),
  citations: z.array(z.string().min(1)).default([]),
  lifecycle: z.enum(["draft", "active", "deprecated", "deleted"]).default("active"),
  visibility: z.enum(["private", "shared", "public"]).default("shared"),
  license: z.string().min(1).optional(),
  supersededBy: z.string().min(1).optional(),
  /** projection name -> token count, as measured by whoever produced the corpus. */
  tokens: z.record(z.string(), z.number().int().nonnegative()).default({}),
}).strict();

export const CorpusPackageSchema = z.object({
  kind: z.literal("corpus"),
  name: z.string().min(1),
  version: z.string().regex(semver, "must be strict SemVer"),
  model: z.string().min(1),
  units: z.array(UnitRecordSchema).min(1),
}).strict();

export type CorpusRelationRecord = z.infer<typeof RelationRecordSchema>;
export type CorpusUnitRecord = z.infer<typeof UnitRecordSchema>;
export type CorpusPackage = z.infer<typeof CorpusPackageSchema>;

export interface CorpusLoadDiagnostic { readonly code: string; readonly message: string; readonly path?: string }
export type CorpusLoadResult = { readonly ok: true; readonly value: CorpusPackage } | { readonly ok: false; readonly diagnostics: readonly CorpusLoadDiagnostic[] };

/** Canonical JSON: object keys sorted, so a digest is stable across producers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Content identity covers everything a consumer can observe except the digest itself. */
export function computeUnitDigest(unit: CorpusUnitRecord): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ id: unit.id, version: unit.version, ...contentMaterial(unit) })).digest("hex")}`;
}

/**
 * Identity-free digest. Two units that differ only by id have the same content
 * digest, which is what makes "the same unit published twice under two names"
 * detectable at all — `computeUnitDigest` hashes the id and so never collides.
 */
export function computeContentDigest(unit: CorpusUnitRecord): string {
  return `sha256:${createHash("sha256").update(canonicalJson(contentMaterial(unit))).digest("hex")}`;
}

function contentMaterial(unit: CorpusUnitRecord): Record<string, unknown> {
  return {
    typeRef: unit.typeRef, fields: unit.fields,
    relations: [...unit.relations].map(r => ({ relation: r.relation, to: r.to, attributes: r.attributes ?? {} }))
      .sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : 1),
    citations: [...unit.citations].sort(), lifecycle: unit.lifecycle, visibility: unit.visibility,
  };
}

export function loadCorpus(path: string): CorpusLoadResult {
  if (!existsSync(path) || !lstatSync(path).isFile())
    return { ok: false, diagnostics: [{ code: "CORPUS_FILE_INVALID", message: "corpus path must name an existing regular file", path }] };
  let doc: unknown;
  try { doc = parse(readFileSync(path, "utf8")); }
  catch (error) { return { ok: false, diagnostics: [{ code: "YAML_PARSE_ERROR", message: error instanceof Error ? error.message : "YAML parsing failed", path }] }; }
  const result = CorpusPackageSchema.safeParse(doc);
  if (!result.success)
    return { ok: false, diagnostics: result.error.issues.map(i => ({ code: "INVALID_CORPUS", message: `${i.path.join(".") || "<root>"}: ${i.message}`, path })) };
  return { ok: true, value: result.data };
}
