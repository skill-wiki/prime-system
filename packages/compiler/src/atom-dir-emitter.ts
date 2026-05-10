/**
 * @module atom-dir-emitter
 *
 * Emits the per-atom directory tree from a parsed AST:
 *
 *   ${outDir}/<atom-id>/
 *     atom.yaml             # metadata (~60 tok)
 *     graph.yaml            # this atom's relations
 *     chunks/
 *       summary.md          # Level 1, ~30 tok
 *       core.md             # Level 2, ~150 tok
 *       full.md             # Level 3, ~380 tok
 *     index.xml             # pre-rendered XML stub (~50 tok)
 *     quality.yaml          # quality scores
 *
 * Key properties:
 * - **Idempotent**: re-running on unchanged source produces byte-identical
 *   output. Uses SHA-256 content hash in atom.yaml; skips writing if unchanged.
 * - **Cross-atom references kept as IDs**: @scope/atom-id strings stay as
 *   strings in graph.yaml.
 * - **Token estimation**: chars / 4.
 */

import { createHash } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import type { PrimeAST, AtomDeclaration, FieldNode, ArrayNode, StringNode, IdentNode, ObjectNode, NumberNode } from "@skill-wiki/types";
import { chunk, estimateTokens } from "./chunker.ts";
import { emitXmlStub } from "./xml-stub-emitter.ts";
import type { AtomMeta } from "./global-index-emitter.ts";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EmitResult {
  atomId: string;
  outDir: string;
  files: string[];
  tokens: {
    summary: number;
    core: number;
    full: number;
  };
  /** AtomMeta for adding to the global index */
  meta: AtomMeta;
  /** Whether the atom was skipped (content hash matched) */
  skipped: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findField(ast: AnyAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

function str(ast: AnyAST, key: string): string {
  const f = findField(ast, key);
  if (!f) return "";
  if (f.value.type === "String") return (f.value as StringNode).value;
  if (f.value.type === "Ident") return (f.value as IdentNode).value;
  return "";
}

function strArr(ast: AnyAST, key: string): string[] {
  const f = findField(ast, key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items
    .filter((i): i is StringNode => i.type === "String")
    .map((i) => i.value);
}

function objStrField(obj: ObjectNode, key: string): string {
  const f = obj.fields.find((x) => x.key === key);
  if (!f) return "";
  if (f.value.type === "String") return (f.value as StringNode).value;
  if (f.value.type === "Ident") return (f.value as IdentNode).value;
  return "";
}

function deriveKind(ast: AnyAST): string {
  // New 28-type form: parser returns an AtomDeclaration with `kind` directly
  // on the node (e.g. `persona Foo { … }` → { type: "AtomDeclaration", kind: "persona" }).
  // Without this branch every new-style atom collapses to "knowledge".
  if (!isPrimeAST(ast)) {
    return ast.kind.toLowerCase();
  }
  const kindField = str(ast, "kind");
  if (kindField) return kindField.toLowerCase();
  return (ast.extends ?? "knowledge").toLowerCase();
}

function deriveId(ast: AnyAST, name: string): string {
  const idField = str(ast, "id");
  if (idField) return idField;

  const moduleField = str(ast, "module");
  if (moduleField && /^M\d+$/.test(moduleField)) {
    return `@${moduleField}/${name.replace(/^m\d+-/, "")}`;
  }

  const m = name.match(/^(m\d+)-/);
  if (m) return `@${m[1].toUpperCase()}/${name.replace(/^m\d+-/, "")}`;

  return `@prime/${name}`;
}

/** Sanitize atom id into a safe directory path segment */
function idToPath(atomId: string): string {
  // "@community/fact-wcag-focus" -> "@community/fact-wcag-focus"
  // Keep @ and / as they define the directory structure
  return atomId;
}

function deriveQuality(ast: AnyAST): Record<string, number> {
  const qualityField = findField(ast, "quality");
  const scores: Record<string, number> = {};

  if (qualityField && qualityField.value.type === "Object") {
    const obj = qualityField.value as ObjectNode;
    for (const f of obj.fields) {
      if (f.value.type === "Number") {
        scores[f.key] = (f.value as NumberNode).value;
      }
    }
  }

  // Derive from status/priority if no explicit quality
  if (Object.keys(scores).length === 0) {
    const status = str(ast, "status");
    const priority = findField(ast, "priority");
    const pVal = priority && priority.value.type === "Number" ? (priority.value as NumberNode).value : 2;

    const baseScore = status === "validated" ? 4.5 : status === "draft" ? 3.0 : 4.0;
    // Adjust by priority (1 = highest priority → slight boost)
    const priorityBoost = pVal === 1 ? 0.3 : pVal === 2 ? 0.0 : -0.2;
    scores["overall"] = Math.min(5.0, Math.max(1.0, parseFloat((baseScore + priorityBoost).toFixed(1))));
  }

  return scores;
}

function computeQualityStr(scores: Record<string, number>): string {
  const vals = Object.values(scores);
  if (vals.length === 0) return "4.0";
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return avg.toFixed(1);
}

/** Compute SHA-256 content hash of a string */
function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

/** YAML scalar serializer — handles strings, numbers, arrays, objects */
function yamlScalar(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v.includes("\n")) {
      const lines = v.split("\n").map((l) => pad + "  " + l);
      return "|\n" + lines.join("\n");
    }
    // Quote strings containing special chars
    if (/[:#\[\]{}&*!,|>'"%@`]/.test(v) || v === "" || v.startsWith(" ") || v.endsWith(" ")) {
      return JSON.stringify(v);
    }
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const allScalar = v.every((i) => typeof i !== "object" || i === null);
    if (allScalar && v.map(String).join(", ").length < 80) {
      return "[" + v.map((i) => yamlScalar(i)).join(", ") + "]";
    }
    return "\n" + v.map((i) => pad + "- " + yamlScalar(i, indent + 1)).join("\n");
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return "\n" + entries
      .map(([k, val]) => {
        const rendered = yamlScalar(val, indent + 1);
        if (rendered.startsWith("\n")) return `${pad}  ${k}:${rendered}`;
        return `${pad}  ${k}: ${rendered}`;
      })
      .join("\n");
  }
  return String(v);
}

// ─── Graph YAML builder ────────────────────────────────────────────────────

/**
 * Atom-to-atom relation field names, normalized to canonical form.
 * The emitter accepts BOTH kebab-case and snake_case spellings (legacy),
 * and emits the canonical kebab-case in graph.yaml / atom.yaml.
 *
 * Categories:
 *  - canonical wiki edges: related, compatible, conflicts, see-also, extends, derived-from
 *  - legacy execution-graph edges: requires, enhances, validates_with, supplies_to,
 *    specializes, contradicts, relationships
 *  - collection composition: includes
 */
const RELATION_KEY_ALIASES: Record<string, string> = {
  // Canonical wiki edges (used by 410+ atoms)
  "related": "related",
  "related-atoms": "related",
  "compatible": "compatible",
  "conflicts": "conflicts",
  "see-also": "see-also",
  "see_also": "see-also",
  "extends": "extends",
  "derived-from": "derived-from",
  "derived_from": "derived-from",
  // Legacy execution-graph link verbs
  "requires": "requires",
  "enhances": "enhances",
  "validates_with": "validates-with",
  "validates-with": "validates-with",
  "supplies_to": "supplies-to",
  "supplies-to": "supplies-to",
  "specializes": "specializes",
  "contradicts": "contradicts",
  "relationships": "relationships",
  // Collection composition
  "includes": "includes",
};

const RELATION_KEYS = Object.keys(RELATION_KEY_ALIASES);

/** Resolve a value node to a target ID/string. Returns "" if unresolvable. */
function resolveTarget(node: any): string {
  if (!node) return "";
  if (node.type === "String") return (node as StringNode).value;
  if (node.type === "Ident") return (node as IdentNode).value;
  if (node.type === "Reference") {
    const ref = node as any;
    return ref.path ? ref.path.join("/") : "";
  }
  return "";
}

/**
 * Extract all edges from an AST. Walks RELATION_KEYS, normalizes the type
 * name via RELATION_KEY_ALIASES, and resolves String / Ident / Reference
 * value nodes uniformly. Deduplicates exact (type, target) pairs.
 */
export function extractEdges(ast: AnyAST): Array<{ type: string; target: string }> {
  const seen = new Set<string>();
  const edges: Array<{ type: string; target: string }> = [];

  const push = (rawType: string, target: string) => {
    if (!target) return;
    const type = RELATION_KEY_ALIASES[rawType] ?? rawType;
    const key = `${type}::${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ type, target });
  };

  for (const key of RELATION_KEYS) {
    const f = findField(ast, key);
    if (!f) continue;

    if (f.value.type === "Array") {
      for (const item of (f.value as ArrayNode).items) {
        push(key, resolveTarget(item));
      }
    } else {
      push(key, resolveTarget(f.value));
    }
  }

  return edges;
}

function buildGraphYaml(ast: AnyAST, atomId: string): string {
  const lines: string[] = [];
  lines.push(`atom: ${JSON.stringify(atomId)}`);
  lines.push("relations:");

  const edges = extractEdges(ast);
  if (edges.length === 0) {
    lines.push("  []");
  } else {
    for (const e of edges) {
      lines.push(`  - type: ${e.type}`);
      lines.push(`    target: ${JSON.stringify(e.target)}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ─── Atom YAML builder ────────────────────────────────────────────────────

function buildAtomYaml(
  ast: AnyAST,
  atomId: string,
  kind: string,
  contentHash: string,
  tokens: { summary: number; core: number; full: number },
  quality: Record<string, number>,
  createdAt: string
): string {
  const name = str(ast, "name") || ast.name;
  const version = str(ast, "version") || "1.0.0";
  const description = str(ast, "description");
  const tags = strArr(ast, "tags");
  const domain = str(ast, "domain");

  // Build sources array for yaml
  const sourcesForYaml: Array<{ url?: string; type?: string }> = [];
  const srcSingular = findField(ast, "source");
  const srcPlural = findField(ast, "sources");
  if (srcSingular && srcSingular.value.type === "Object") {
    const obj = srcSingular.value as ObjectNode;
    const url = objStrField(obj, "url") || objStrField(obj, "file") || objStrField(obj, "repo");
    const type = objStrField(obj, "type");
    if (url) sourcesForYaml.push({ url, ...(type ? { type } : {}) });
  }
  if (srcPlural && srcPlural.value.type === "Array") {
    for (const item of (srcPlural.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const url = objStrField(obj, "url") || objStrField(obj, "file");
        const type = objStrField(obj, "type");
        if (url) sourcesForYaml.push({ url, ...(type ? { type } : {}) });
      }
    }
  }

  // Relations for atom.yaml (same shape as graph.yaml — single source of truth)
  const relations = extractEdges(ast);

  const qualityStr = computeQualityStr(quality);
  const qualityEntries = Object.entries(quality);

  const lines: string[] = [];
  lines.push(`id: ${JSON.stringify(atomId)}`);
  lines.push(`kind: ${kind}`);
  lines.push(`version: ${JSON.stringify(version)}`);
  if (description) lines.push(`description: ${JSON.stringify(description)}`);
  if (tags.length > 0) lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  if (domain) lines.push(`domain: ${domain}`);
  lines.push(`content_hash: ${JSON.stringify(contentHash)}`);
  lines.push(`tokens:`);
  lines.push(`  summary: ${tokens.summary}`);
  lines.push(`  core: ${tokens.core}`);
  lines.push(`  full: ${tokens.full}`);
  lines.push(`projection:`);
  lines.push(`  summary: "chunks/summary.md"`);
  lines.push(`  core: "chunks/core.md"`);
  lines.push(`  full: "chunks/full.md"`);

  if (qualityEntries.length > 0) {
    lines.push(`quality:`);
    for (const [k, v] of qualityEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  if (relations.length > 0) {
    lines.push(`relations:`);
    for (const rel of relations) {
      lines.push(`  - { type: ${rel.type}, target: ${JSON.stringify(rel.target)} }`);
    }
  }

  if (sourcesForYaml.length > 0) {
    lines.push(`sources:`);
    for (const src of sourcesForYaml) {
      const type = (src as any).type;
      lines.push(`  - { url: ${JSON.stringify(src.url)}${type ? `, type: ${JSON.stringify(type)}` : ""} }`);
    }
  }

  lines.push(`created_at: ${JSON.stringify(createdAt)}`);

  // Lifecycle (PRIME-SPEC v1 §6)
  const lifecycle = findField(ast, "lifecycle");
  if (lifecycle && lifecycle.value.type === "Object") {
    const obj = lifecycle.value as ObjectNode;
    const deprecatedAt = objStrField(obj, "deprecated_at");
    const supersededBy = objStrField(obj, "superseded_by");
    if (deprecatedAt && deprecatedAt !== "null") {
      lines.push(`lifecycle:`);
      lines.push(`  deprecated_at: ${JSON.stringify(deprecatedAt)}`);
      if (supersededBy && supersededBy !== "null") {
        lines.push(`  superseded_by: ${JSON.stringify(supersededBy)}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

// ─── Quality YAML builder ──────────────────────────────────────────────────

function buildQualityYaml(quality: Record<string, number>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(quality).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\n") + "\n";
}

// ─── Write helper (idempotent) ─────────────────────────────────────────────

function writeIfChanged(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    if (existing === content) return false; // skip
  }
  writeFileSync(filePath, content, "utf-8");
  return true;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Emit the per-atom directory tree for a single parsed AST.
 *
 * @param ast     - The parsed PrimeAST
 * @param outDir  - Base output directory (e.g. "compiled-v3")
 * @param createdAt - ISO date string for created_at field (default: today)
 * @returns EmitResult with atom id, output dir, files list, and token counts
 */
export function emitAtomDir(
  ast: AnyAST,
  outDir: string,
  createdAt?: string
): EmitResult {
  const name = str(ast, "name") || ast.name;
  const kind = deriveKind(ast);
  const atomId = deriveId(ast, name);
  const atomPath = idToPath(atomId);
  const atomDir = join(outDir, atomPath);
  const chunksDir = join(atomDir, "chunks");

  const date = createdAt || new Date().toISOString().slice(0, 10);

  // ── Generate chunks ─────────────────────────────────────────────────
  const { summary, core, full } = chunk(ast);
  const tokens = {
    summary: estimateTokens(summary),
    core: estimateTokens(core),
    full: estimateTokens(full),
  };

  // ── Content hash — computed on core content (the primary projection) ─
  const contentHashInput = JSON.stringify({ id: atomId, kind, summary, core, full });
  const contentHash = sha256(contentHashInput);

  // ── Check idempotency via existing atom.yaml ─────────────────────────
  const atomYamlPath = join(atomDir, "atom.yaml");

  // Extract lifecycle fields (PRIME-SPEC v1 §6)
  let deprecatedAt: string | undefined;
  let supersededBy: string | undefined;
  const lifecycleField = findField(ast, "lifecycle");
  if (lifecycleField?.value.type === "Object") {
    const obj = lifecycleField.value as ObjectNode;
    const depAt = objStrField(obj, "deprecated_at");
    const supBy = objStrField(obj, "superseded_by");
    if (depAt && depAt !== "null") {
      deprecatedAt = depAt;
    }
    if (supBy && supBy !== "null") {
      supersededBy = supBy;
    }
  }

  if (existsSync(atomYamlPath)) {
    const existing = readFileSync(atomYamlPath, "utf-8");
    if (existing.includes(contentHash)) {
      // Content hash matches — skip writing (idempotent)
      const qualityScores = deriveQuality(ast);
      const qualityStr = computeQualityStr(qualityScores);
      const tags = strArr(ast, "tags");
      const domain = str(ast, "domain");
      const description = str(ast, "description");
      return {
        atomId,
        outDir: atomDir,
        files: [],
        tokens,
        meta: {
          id: atomId,
          kind,
          version: str(ast, "version") || "1.0.0",
          description,
          domain,
          tags,
          tokens,
          quality: qualityStr,
          edges: extractEdges(ast),
          ...(deprecatedAt ? { deprecated_at: deprecatedAt } : {}),
          ...(supersededBy ? { superseded_by: supersededBy } : {}),
        },
        skipped: true,
      };
    }
  }

  // ── Create directories ───────────────────────────────────────────────
  mkdirSync(chunksDir, { recursive: true });

  const files: string[] = [];

  // ── Write chunks ─────────────────────────────────────────────────────
  const summaryPath = join(chunksDir, "summary.md");
  const corePath = join(chunksDir, "core.md");
  const fullPath = join(chunksDir, "full.md");

  writeFileSync(summaryPath, summary + "\n", "utf-8");
  writeFileSync(corePath, core + "\n", "utf-8");
  writeFileSync(fullPath, full + "\n", "utf-8");
  files.push(summaryPath, corePath, fullPath);

  // ── Write atom.yaml ──────────────────────────────────────────────────
  const qualityScores = deriveQuality(ast);
  const qualityStr = computeQualityStr(qualityScores);
  const tags = strArr(ast, "tags");
  const domain = str(ast, "domain");
  const description = str(ast, "description");

  const atomYaml = buildAtomYaml(ast, atomId, kind, contentHash, tokens, qualityScores, date);
  writeFileSync(atomYamlPath, atomYaml, "utf-8");
  files.push(atomYamlPath);

  // ── Write graph.yaml ─────────────────────────────────────────────────
  const graphYaml = buildGraphYaml(ast, atomId);
  const graphYamlPath = join(atomDir, "graph.yaml");
  writeFileSync(graphYamlPath, graphYaml, "utf-8");
  files.push(graphYamlPath);

  // ── Write index.xml ──────────────────────────────────────────────────
  const xmlStub = emitXmlStub(ast, tokens);
  const indexXmlPath = join(atomDir, "index.xml");
  writeFileSync(indexXmlPath, xmlStub, "utf-8");
  files.push(indexXmlPath);

  // ── Write quality.yaml ───────────────────────────────────────────────
  const qualityYaml = buildQualityYaml(qualityScores);
  const qualityYamlPath = join(atomDir, "quality.yaml");
  writeFileSync(qualityYamlPath, qualityYaml, "utf-8");
  files.push(qualityYamlPath);

  const meta: AtomMeta = {
    id: atomId,
    kind,
    version: str(ast, "version") || "1.0.0",
    description,
    domain,
    tags,
    tokens,
    quality: qualityStr,
    edges: extractEdges(ast),
    ...(deprecatedAt ? { deprecated_at: deprecatedAt } : {}),
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
  };

  return {
    atomId,
    outDir: atomDir,
    files,
    tokens,
    meta,
    skipped: false,
  };
}
