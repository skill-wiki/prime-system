#!/usr/bin/env bun
/**
 * validate-output.ts
 *
 * Validates a directory of `.prime` files emitted by the prime-decompose skill.
 *
 * Checks:
 *   1. Each file parses (uses the project parser at packages/parser)
 *   2. Each atom declares ≥ 3 `related:` edges
 *   3. Each atom declares ≥ 1 of: extends / derived-from / requires / enhances / specializes
 *   4. Each atom's `id` matches its filename (`@scope/<kind>-<name>` ↔ <kind>-<name>.prime)
 *
 * Usage:
 *   bun run release/skills/prime-decompose/scripts/validate-output.ts <dir>
 *
 * Exit codes:
 *   0 — all atoms valid
 *   1 — one or more files failed validation
 *   2 — usage error (no dir, dir not found, parser not found)
 *
 * NOTE: This script imports the parser from the Prime monorepo. Run it from
 * the repo root, or set PRIME_REPO=<abs-path> to point at a checkout. It does
 * NOT need the MCP server running.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Resolve the parser path
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");
const RELEASE_ROOT = resolve(SKILL_ROOT, "..", "..");
const REPO_ROOT_GUESS = resolve(RELEASE_ROOT, "..");

const PRIME_REPO =
  process.env.PRIME_REPO ??
  (existsSync(join(REPO_ROOT_GUESS, "packages/parser/src/index.ts"))
    ? REPO_ROOT_GUESS
    : process.cwd());

const PARSER_PATH = join(PRIME_REPO, "packages/parser/src/index.ts");

if (!existsSync(PARSER_PATH)) {
  console.error(
    `[validate] cannot find parser at ${PARSER_PATH}\n` +
      `Set PRIME_REPO=<abs-path-to-prime-repo> or run from the repo root.`
  );
  process.exit(2);
}

// Dynamic import so the static path doesn't break the script when the parser
// is unavailable (e.g. when only this skill directory is shipped in isolation).
const { parse } = (await import(PARSER_PATH)) as {
  parse: (
    source: string,
    filename?: string
  ) => {
    ast: { type: string; kind?: string; id?: string; fields?: unknown };
    errors: Array<{ message: string; line?: number; column?: number }>;
  };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun run validate-output.ts <dir-of-prime-files>");
  process.exit(2);
}

const targetDir = resolve(args[0]);
if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
  console.error(`[validate] not a directory: ${targetDir}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Collect .prime files (recursive)
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".prime")) out.push(full);
  }
  return out;
}

const files = walk(targetDir).sort();
if (files.length === 0) {
  console.error(`[validate] no .prime files found in ${targetDir}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate each file
// ---------------------------------------------------------------------------

const STRONG_VERBS = [
  "extends",
  "derived-from",
  "requires",
  "enhances",
  "specializes",
];

let passCount = 0;
let failCount = 0;
const summaryByKind = new Map<string, number>();

for (const file of files) {
  const rel = file.replace(targetDir + "/", "");
  const source = readFileSync(file, "utf8");
  const fname = basename(file, ".prime");
  const fileErrors: string[] = [];

  // 1. Parse
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(source, rel);
  } catch (e) {
    fileErrors.push(`parse threw: ${(e as Error).message}`);
    report(rel, fileErrors);
    failCount++;
    continue;
  }

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      fileErrors.push(
        `parse error: ${err.message}` +
          (err.line ? ` (line ${err.line}:${err.column ?? "?"})` : "")
      );
    }
  }

  const ast = parsed.ast;
  if (!ast || (ast.type !== "AtomDeclaration" && ast.type !== "PrimeDeclaration")) {
    fileErrors.push(`expected AtomDeclaration, got ${ast?.type ?? "null"}`);
    report(rel, fileErrors);
    failCount++;
    continue;
  }

  // 2. Read fields. The AST shape is tolerated loosely — we only need access
  //    to `id`, `related`, and the strong verbs.
  const fields = readFields(ast);

  // 3. id ↔ filename
  const id = stringField(fields, "id");
  if (!id) {
    fileErrors.push(`missing required field: id`);
  } else {
    const m = id.match(/^@[^/]+\/(.+)$/);
    if (!m) {
      fileErrors.push(`id "${id}" does not match @scope/kebab-name`);
    } else if (m[1] !== fname) {
      fileErrors.push(
        `id slug "${m[1]}" does not match filename "${fname}"`
      );
    }
  }

  // 4. ≥ 3 related edges
  const related = arrayField(fields, "related");
  if (related.length < 3) {
    fileErrors.push(
      `only ${related.length} related: edges (need ≥ 3)`
    );
  }

  // 5. ≥ 1 strong verb
  const hasStrong = STRONG_VERBS.some((v) => arrayField(fields, v).length > 0 || stringField(fields, v));
  if (!hasStrong) {
    fileErrors.push(
      `no strong verb (need ≥ 1 of: ${STRONG_VERBS.join(", ")})`
    );
  }

  // 6. version present
  if (!stringField(fields, "version")) {
    fileErrors.push(`missing required field: version`);
  }

  // 7. description present (kind-specific field names accepted)
  if (
    !stringField(fields, "description") &&
    !stringField(fields, "statement") &&  // fact / principle
    !stringField(fields, "meaning") &&    // term
    !stringField(fields, "definition")    // term (alternate)
  ) {
    fileErrors.push(`missing description (or statement/meaning/definition per atom kind)`);
  }

  // Tally
  const kind = (ast as { kind?: string }).kind ?? "unknown";
  summaryByKind.set(kind, (summaryByKind.get(kind) ?? 0) + 1);

  if (fileErrors.length === 0) {
    passCount++;
    console.log(`  PASS  ${rel}  (${kind})`);
  } else {
    failCount++;
    report(rel, fileErrors);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("");
console.log(`──────────────────────────────────────────`);
console.log(`Total files: ${files.length}`);
console.log(`  pass: ${passCount}`);
console.log(`  fail: ${failCount}`);
console.log(`Kinds:`);
for (const [k, n] of [...summaryByKind.entries()].sort()) {
  console.log(`  ${k.padEnd(20)} ${n}`);
}

process.exit(failCount > 0 ? 1 : 0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function report(file: string, errs: string[]) {
  console.log(`  FAIL  ${file}`);
  for (const e of errs) console.log(`        ${e}`);
}

/**
 * The parser's AST exposes fields as either an array of `{ name, value }`
 * pairs or as a plain object map, depending on version. Normalize to a Map.
 *
 * Shapes supported:
 *   A: { fields: [{ name, value }] }                   — legacy
 *   B: { fields: { foo: bar } }                        — legacy object map
 *   C: { body: [{ type: "Field", key, value }] }       — current parser output
 *   D: top-level keys (fallback)
 */
function readFields(ast: unknown): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (!ast || typeof ast !== "object") return m;
  const a = ast as Record<string, unknown>;

  // Shape A: { fields: [{ name, value }] }
  if (Array.isArray(a.fields)) {
    for (const f of a.fields as Array<{ name?: string; value?: unknown }>) {
      if (f && typeof f.name === "string") m.set(f.name, f.value);
    }
    return m;
  }
  // Shape B: { fields: { foo: bar } }
  if (a.fields && typeof a.fields === "object") {
    for (const [k, v] of Object.entries(a.fields as Record<string, unknown>)) {
      m.set(k, v);
    }
    return m;
  }
  // Shape C: { body: [{ type: "Field", key, value }] } — current parser AST format
  if (Array.isArray(a.body)) {
    for (const entry of a.body as Array<Record<string, unknown>>) {
      if (entry && entry.type === "Field" && typeof entry.key === "string") {
        // value is a typed node: { type: "String"|"Array"|"Ident"|..., value/items: ... }
        const valNode = entry.value as Record<string, unknown> | undefined;
        if (valNode) {
          if (valNode.type === "Array" && Array.isArray(valNode.items)) {
            // Array node: expose items as a plain array of extracted scalar values
            const items = (valNode.items as Array<Record<string, unknown>>).map(
              (item) => (item && "value" in item ? item.value : item)
            );
            m.set(entry.key, items);
          } else if ("value" in valNode) {
            m.set(entry.key, valNode.value);
          } else {
            m.set(entry.key, entry.value);
          }
        }
      }
    }
    if (m.size > 0) return m;
  }
  // Shape D: top-level keys (fallback)
  for (const [k, v] of Object.entries(a)) {
    if (k !== "type" && k !== "kind" && k !== "name") m.set(k, v);
  }
  return m;
}

function stringField(fields: Map<string, unknown>, name: string): string | undefined {
  const v = fields.get(name);
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    const inner = (v as Record<string, unknown>).value;
    if (typeof inner === "string") return inner;
  }
  return undefined;
}

function arrayField(fields: Map<string, unknown>, name: string): unknown[] {
  const v = fields.get(name);
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    const inner = (v as Record<string, unknown>).value;
    if (Array.isArray(inner)) return inner;
  }
  return [];
}
