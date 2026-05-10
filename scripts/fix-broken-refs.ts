#!/usr/bin/env bun
/**
 * Inventory + auto-suggest fixes for broken atom refs in source `.prime`
 * files. The compiler can't resolve `@impeccable/persona-stripe` (the
 * existing atom is `persona-stripe-fintech`), `@community/template-fade-stagger`
 * (no such atom; closest is `pattern-fade-stagger-reveal`), etc.
 *
 * Strategy:
 *   1. Collect every atom id in the corpus.
 *   2. For each `.prime` source, parse it, walk relations, find any target
 *      that doesn't exist in the corpus.
 *   3. For each broken target, score every candidate atom id by:
 *        score = (longest-common-substring length) / (max(target.len, candidate.len))
 *      Apply auto-fix only when the best score is ≥0.7 AND the runner-up is
 *      ≥0.15 below (i.e. an unambiguous winner). Otherwise leave the ref
 *      and emit a warning so a human can pick.
 *
 * Modes:
 *   (default) report only — list broken refs + best suggestions
 *   --apply             rewrite source `.prime` files in place
 *   --threshold 0.7     adjust similarity threshold
 *   --src primes-v3/sources
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { parse } from "../packages/parser/src/index.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const STRIP_UNFIXABLE = args.includes("--strip-unfixable");
const flagVal = (flag: string, fallback: string): string => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const TH = parseFloat(flagVal("--threshold", "0.72")) || 0.72;
const SRC = flagVal("--src", "primes-v3/sources");

// ─── Collect every atom id ──────────────────────────────────────────────────

function* walkPrimes(root: string): Generator<string> {
  for (const ent of readdirSync(root)) {
    const full = join(root, ent);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkPrimes(full);
    else if (ent.endsWith(".prime")) yield full;
  }
}

const sourceFiles = [...walkPrimes(SRC)];
console.log(`Scanning ${sourceFiles.length} .prime files in ${SRC}`);

const knownIds = new Set<string>();
const fileById = new Map<string, string>();
for (const file of sourceFiles) {
  const src = readFileSync(file, "utf-8");
  // Extract id from `id: "@..."` or from ast name fallback
  const m = src.match(/^\s*id\s*:\s*"([^"]+)"/m);
  if (m) {
    knownIds.add(m[1]);
    fileById.set(m[1], file);
    continue;
  }
  // For files without explicit id, derive from path: @ns/atom-name.prime
  const rel = file.replace(/^.*?(\/@[^/]+\/[^/]+)\.prime$/, "$1");
  if (rel.startsWith("/")) {
    knownIds.add(rel.slice(1));
    fileById.set(rel.slice(1), file);
  }
}
console.log(`Loaded ${knownIds.size} atom ids`);

// ─── LCS-based similarity ───────────────────────────────────────────────────

function lcs(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = new Array(n + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > best) best = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = tmp;
    }
  }
  return best;
}

function score(target: string, candidate: string): number {
  // Strip namespace + kind prefix for comparison
  const norm = (s: string) => s.replace(/^@[^/]+\//, "").replace(/^[a-z]+-/, "");
  const a = norm(target);
  const b = norm(candidate);
  if (a === b) return 1.0;
  const len = Math.max(a.length, b.length);
  if (len === 0) return 0;
  return lcs(a, b) / len;
}

function suggestFor(target: string): { suggestion: string | null; topScore: number; runnerUpGap: number } {
  let best = { id: "", score: 0 };
  let runner = 0;
  for (const id of knownIds) {
    const s = score(target, id);
    if (s > best.score) {
      runner = best.score;
      best = { id, score: s };
    } else if (s > runner) {
      runner = s;
    }
  }
  return {
    suggestion: best.score >= TH ? best.id : null,
    topScore: best.score,
    runnerUpGap: best.score - runner,
  };
}

// ─── Find broken refs in every source ───────────────────────────────────────

interface BrokenRef {
  source: string;          // atom id of source
  file: string;            // path to source .prime
  field: string;           // which relation field (related/conflicts/...)
  target: string;          // dangling target
  suggestion: string | null;
  topScore: number;
  runnerUpGap: number;
}

const REL_FIELDS = [
  "related", "compatible", "conflicts", "see-also", "see_also",
  "extends", "derived-from", "derived_from",
  "requires", "enhances", "validates_with", "validates-with",
  "supplies_to", "supplies-to", "specializes",
  "contradicts", "relationships",
  "must-include", "must_include", "motion-prescriptions", "motion_prescriptions",
];

const broken: BrokenRef[] = [];

for (const file of sourceFiles) {
  const src = readFileSync(file, "utf-8");
  let ast: any;
  try {
    const parsed = parse(src, file);
    if (parsed.errors?.length > 0) continue;
    ast = parsed.ast ?? parsed;
  } catch { continue; }

  const sourceId = ast.body?.find((f: any) => f.key === "id")?.value?.value
    ?? src.match(/^\s*id\s*:\s*"([^"]+)"/m)?.[1]
    ?? null;
  if (!sourceId) continue;

  // Walk every field in body — including nested composition.must-include etc.
  function visit(node: any, fieldName?: string) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, fieldName);
      return;
    }
    if (node.type === "String" && fieldName && REL_FIELDS.includes(fieldName)) {
      const target = node.value;
      if (typeof target !== "string") return;
      // Only consider full-id targets (contain @ or /)
      if (!target.includes("/") && !target.startsWith("@")) return;
      if (!knownIds.has(target)) {
        const sug = suggestFor(target);
        broken.push({
          source: sourceId, file, field: fieldName, target,
          suggestion: sug.suggestion, topScore: sug.topScore, runnerUpGap: sug.runnerUpGap,
        });
      }
      return;
    }
    if (node.type === "Object" && node.fields) {
      for (const f of node.fields) visit(f.value, f.key);
      return;
    }
    if (node.type === "Array" && node.items) {
      for (const item of node.items) visit(item, fieldName);
      return;
    }
    if (node.body) {
      for (const f of node.body) visit(f.value, f.key);
    }
  }
  if (ast.body) for (const f of ast.body) visit(f.value, f.key);
}

console.log(`\nFound ${broken.length} broken refs`);

// Group by suggestion-or-not
const autofixable = broken.filter((b) => b.suggestion && b.runnerUpGap >= 0.15);
const ambiguous = broken.filter((b) => b.suggestion && b.runnerUpGap < 0.15);
const noMatch = broken.filter((b) => !b.suggestion);

console.log(`  ${autofixable.length} have unambiguous suggestion (top score ≥${TH}, runner-up gap ≥0.15)`);
console.log(`  ${ambiguous.length} ambiguous (suggestion exists but runner-up close)`);
console.log(`  ${noMatch.length} no match — atom needs to be authored`);

console.log(`\nAuto-fixable (top 20):`);
for (const b of autofixable.slice(0, 20)) {
  console.log(`  ${b.source}.${b.field}: ${b.target}`);
  console.log(`     → ${b.suggestion}  (score ${b.topScore.toFixed(2)}, gap ${b.runnerUpGap.toFixed(2)})`);
}

if (ambiguous.length > 0) {
  console.log(`\nAmbiguous (top 10):`);
  for (const b of ambiguous.slice(0, 10)) {
    console.log(`  ${b.source}.${b.field}: ${b.target}`);
    console.log(`     →? ${b.suggestion}  (score ${b.topScore.toFixed(2)}, gap ${b.runnerUpGap.toFixed(2)} — too close to call)`);
  }
}

if (noMatch.length > 0) {
  console.log(`\nNo close match (top 10):`);
  for (const b of noMatch.slice(0, 10)) {
    console.log(`  ${b.source}.${b.field}: ${b.target}`);
  }
}

// ─── Strip-unfixable mode ───────────────────────────────────────────────────
//
// For broken refs that have no near-match, the right thing is to remove the
// reference (the target atom doesn't exist in any form). We do this by
// rewriting source files: find the ref line, drop it. The rewrite is
// field-aware (we only touch lines whose target was identified by AST walk
// as a relation field), so prose / description strings are never touched.

if (APPLY && STRIP_UNFIXABLE && noMatch.length > 0) {
  const byFile = new Map<string, BrokenRef[]>();
  for (const b of noMatch) {
    if (!byFile.has(b.file)) byFile.set(b.file, []);
    byFile.get(b.file)!.push(b);
  }
  let stripped = 0;
  let filesPatched = 0;
  for (const [file, refs] of byFile) {
    let src = readFileSync(file, "utf-8");
    let dirty = false;
    for (const r of refs) {
      const t = escapeRe(r.target);
      // Match a line whose only meaningful content is the ref itself
      // (in either quoted or unquoted form), with optional trailing comma.
      // The line must be inside an array — we approximate that by requiring
      // leading whitespace.
      const rePatterns = [
        // quoted: `  "@scope/name",`
        new RegExp(`^[\\t ]+"${t}"\\s*,?\\s*\\n`, "gm"),
        // unquoted: `  @scope/name,`
        new RegExp(`^[\\t ]+${t}\\s*,?\\s*\\n`, "gm"),
      ];
      for (const re of rePatterns) {
        const after = src.replace(re, "");
        if (after !== src) { src = after; dirty = true; stripped++; break; }
      }
    }
    if (dirty) {
      writeFileSync(file, src, "utf-8");
      filesPatched++;
    }
  }
  console.log(`\nStripped ${stripped}/${noMatch.length} unfixable refs across ${filesPatched} source files.`);
} else if (STRIP_UNFIXABLE && noMatch.length > 0) {
  console.log(`\n--strip-unfixable requested without --apply (dry-run). ${noMatch.length} refs would be stripped.`);
}

if (APPLY && autofixable.length > 0) {
  // Group rewrites by file
  const byFile = new Map<string, BrokenRef[]>();
  for (const b of autofixable) {
    if (!byFile.has(b.file)) byFile.set(b.file, []);
    byFile.get(b.file)!.push(b);
  }
  let filesPatched = 0;
  let totalEditsApplied = 0;
  for (const [file, refs] of byFile) {
    let src = readFileSync(file, "utf-8");
    let dirty = false;
    for (const r of refs) {
      // Source files use BOTH quoted ("@scope/name") and unquoted Ident forms
      // (`@scope/name,`). The unquoted form requires a non-id-char boundary.
      const t = escapeRe(r.target);
      // 1. Quoted form
      const reQ = new RegExp(`"${t}"`, "g");
      const after1 = src.replace(reQ, `"${r.suggestion}"`);
      // 2. Unquoted form — bounded by start-of-line/whitespace/[ on the left
      //    and whitespace/,/]/end on the right. Don't match inside strings.
      const reU = new RegExp(`(^|[\\s\\[,])(${t})(?=[\\s,\\]])`, "gm");
      const after2 = after1.replace(reU, (_m, pre) => `${pre}${r.suggestion}`);
      if (after2 !== src) { src = after2; dirty = true; totalEditsApplied++; }
    }
    if (dirty) {
      writeFileSync(file, src, "utf-8");
      filesPatched++;
    }
  }
  console.log(`\nApplied ${totalEditsApplied}/${autofixable.length} auto-fixes across ${filesPatched} source files.`);
  console.log(`Re-run \`bun run scripts/build-atom-dirs.ts --src ${SRC} --out compiled-v3-final\` to recompile.`);
} else if (autofixable.length > 0) {
  console.log(`\nDry-run. Use --apply to rewrite source files.`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
