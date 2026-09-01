import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "@aoe/parser";
import type { ArrayNode, FieldNode, ObjectNode, ValueNode } from "@aoe/types";
import type { LoadedModel, ModelDefinition } from "@aoe/model-schema";
import type { CorpusPackage, CorpusRelationRecord, CorpusUnitRecord } from "./corpus.ts";

/**
 * Turns a real `.prime` source tree into corpus records so §17.2 can be run
 * against production corpora instead of a hand-written fixture.
 *
 * Which fields are relations is decided by the MODEL, not by this file: a field
 * whose key matches a declared relation name or alias becomes edges, everything
 * else stays a field. That is the only way to read a v1 corpus without the
 * adapter itself knowing what `supplies-to` means.
 */

export interface V1CorpusOptions {
  readonly sourcesDir: string;
  readonly model: LoadedModel;
  readonly name: string;
  readonly version?: string;
  /**
   * Field keys to lift into `citations`. Supplied by the caller because the
   * protocol has no citation field name of its own (plan §17.2 requires the
   * check, §3.1 forbids the engine from naming the field).
   */
  readonly citationFields?: readonly string[];
}

export interface V1CorpusResult {
  readonly corpus: CorpusPackage;
  /** Files that could not be turned into a unit, with the reason. */
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}

type Plain = string | number | boolean | null | readonly Plain[] | { readonly [key: string]: Plain };

function plainValue(node: ValueNode): Plain {
  switch (node.type) {
    case "String": return node.value;
    case "Number": return node.value;
    case "Boolean": return node.value;
    case "Ident": return node.value;
    case "Reference": return `${node.path.join("/")}`;
    case "Array": return (node as ArrayNode).items.map(plainValue);
    case "Object": return Object.fromEntries((node as ObjectNode).fields.map(f => [f.key, plainValue(f.value)]));
    default: return null;
  }
}

function stringItems(node: ValueNode): readonly string[] {
  if (node.type === "Array") return (node as ArrayNode).items.flatMap(stringItems);
  const value = plainValue(node);
  return typeof value === "string" ? [value] : [];
}

function relationKeys(model: LoadedModel): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  for (const d of model.definitions as readonly ModelDefinition[]) {
    if (d.kind !== "relation") continue;
    keys.set(d.name, d.name);
    for (const alias of d.aliases ?? []) keys.set(alias, alias);
  }
  return keys;
}

function primeFiles(dir: string, out: string[] = []): readonly string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) primeFiles(join(dir, entry.name), out);
    else if (entry.name.endsWith(".prime")) out.push(join(dir, entry.name));
  }
  return out.sort();
}

function scalarField(body: readonly FieldNode[], key: string): string | undefined {
  const found = body.find(f => f.key === key);
  if (found === undefined) return undefined;
  const value = plainValue(found.value);
  return typeof value === "string" ? value : undefined;
}

export function corpusFromV1Sources(options: V1CorpusOptions): V1CorpusResult {
  const root = resolve(options.sourcesDir);
  const relations = relationKeys(options.model);
  const citationFields = new Set(options.citationFields ?? []);
  const units: CorpusUnitRecord[] = [];
  const rejected: { path: string; reason: string }[] = [];

  for (const path of primeFiles(root)) {
    const result = parse(readFileSync(path, "utf8"), path);
    if (result.errors.length > 0) { rejected.push({ path, reason: `parse: ${result.errors[0]?.message ?? "unknown"}` }); continue; }
    const ast = result.ast;
    const typeRef = ast.type === "AtomDeclaration" ? ast.kind : ast.type === "UnitDeclaration" ? ast.typeRef.name : undefined;
    if (typeRef === undefined || !("body" in ast)) { rejected.push({ path, reason: `unsupported declaration: ${ast.type}` }); continue; }
    const body = ast.body as readonly FieldNode[];
    const id = scalarField(body, "id");
    if (id === undefined) { rejected.push({ path, reason: "no `id` field" }); continue; }

    const edges: CorpusRelationRecord[] = [];
    const fields: Record<string, Plain> = {};
    const citations: string[] = [];
    for (const field of body) {
      if (relations.has(field.key)) { for (const to of stringItems(field.value)) edges.push({ relation: field.key, to }); continue; }
      if (citationFields.has(field.key)) { citations.push(...stringItems(field.value)); continue; }
      // `id` and `version` are lifted into `identity` AND left in `fields`: the
      // source really does declare them, and a type schema may require them.
      fields[field.key] = plainValue(field.value);
    }

    units.push({
      id,
      version: scalarField(body, "version") ?? "0.0.0",
      typeRef,
      fields: fields as Record<string, unknown>,
      relations: edges,
      citations,
      lifecycle: "active",
      visibility: "shared",
      tokens: {},
    });
  }

  return {
    corpus: { kind: "corpus", name: options.name, version: options.version ?? "1.0.0", model: options.model.manifest.name, units },
    rejected,
  };
}
