/**
 * Seed script — reads every .prime file under
 * packages/compiler/fixtures/migrated/ and inserts the parsed metadata
 * into the registry database. Uses the real parser rather than regex,
 * so the registry's view of each atom stays aligned with what the
 * compiler sees.
 *
 * Usage: bun packages/registry/src/seed.ts
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse } from "@prime-lang/parser";
import type { PrimeAST, AtomDeclaration, FieldNode, ArrayNode, StringNode, LinkShorthandNode } from "@prime-lang/types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}
import { initDB, publishPrime, getDB } from "./db";

const ROOT = join(import.meta.dir, "../../..");
const DEFAULT_DIR = join(ROOT, "packages/compiler/fixtures/migrated");
const DIR = process.env.REGISTRY_SEED_DIR ?? DEFAULT_DIR;

// ── AST extraction helpers ──────────────────────────────────────────────────

function fieldString(ast: AnyAST, key: string): string | undefined {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "String") return undefined;
  return (f.value as StringNode).value;
}

function fieldStringArray(ast: AnyAST, key: string): string[] {
  const f = ast.body.find((x) => x.key === key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items
    .filter((item): item is StringNode => item.type === "String")
    .map((item) => item.value);
}

const LINK_VERBS = new Set([
  "requires",
  "enhances",
  "validates_with",
  "supplies_to",
  "contradicts",
  "specializes",
]);

/** Extract typed link edges from any supported .prime syntax shape. */
function extractLinks(ast: AnyAST): Array<{ type: string; to: string }> {
  const out: Array<{ type: string; to: string }> = [];

  function walkField(f: FieldNode): void {
    if (LINK_VERBS.has(f.key)) {
      if (f.value.type === "String") {
        out.push({ type: f.key, to: (f.value as StringNode).value });
      } else if (f.value.type === "Array") {
        for (const item of (f.value as ArrayNode).items) {
          if (item.type === "String") out.push({ type: f.key, to: (item as StringNode).value });
          else if (item.type === "LinkShorthand") {
            const l = item as LinkShorthandNode;
            if (LINK_VERBS.has(l.verb)) out.push({ type: l.verb, to: l.target });
          }
        }
      }
    }
    // Inspect nested values for LinkShorthand anywhere (the parser may place
    // shorthand nodes inside arbitrary structures).
    if (f.value.type === "Array") {
      for (const item of (f.value as ArrayNode).items) {
        if (item.type === "LinkShorthand") {
          const l = item as LinkShorthandNode;
          if (LINK_VERBS.has(l.verb)) out.push({ type: l.verb, to: l.target });
        }
      }
    }
  }

  for (const field of ast.body) walkField(field);
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log(`Initializing database...`);
initDB();

const files = readdirSync(DIR).filter((f) => f.endsWith(".prime"));
console.log(`Found ${files.length} .prime files in ${DIR}`);

let count = 0;
let parseFailed = 0;
let skipped = 0;
const seenKeys = new Set<string>();

for (const file of files) {
  const source = readFileSync(join(DIR, file), "utf-8");
  const { ast, errors } = parse(source, file);
  if (errors.length > 0) {
    parseFailed++;
    continue;
  }

  const name = fieldString(ast, "name") ?? ast.name;
  const version = fieldString(ast, "version") ?? "1.0.0";
  const type = (isPrimeAST(ast) ? ast.extends : undefined) ?? "Knowledge";
  const description = fieldString(ast, "description") ?? "";
  const tags = fieldStringArray(ast, "tags");
  const license = fieldString(ast, "license") ?? "MIT";
  const author = ""; // impeccable decomposition doesn't carry authors by default
  const links = extractLinks(ast);

  if (!name) {
    skipped++;
    continue;
  }

  const key = `${name}@${version}`;
  if (seenKeys.has(key)) {
    skipped++;
    continue;
  }
  seenKeys.add(key);

  publishPrime({
    name,
    version,
    type,
    description,
    tags,
    author,
    license,
    source,
    compiled: "",
    dependencies: [],
    links,
  });

  count++;
  if (count % 200 === 0) console.log(`  seeded ${count} primes…`);
}

console.log(`\nSeeded ${count} primes into the registry.`);
if (parseFailed > 0) console.log(`  ${parseFailed} parse failures skipped`);
if (skipped > 0) console.log(`  ${skipped} name/version duplicates skipped`);

const db = getDB();
const total = (db.query(`SELECT COUNT(*) AS n FROM primes`).get() as { n: number }).n;
console.log(`Registry now contains ${total} rows across all versions.`);
