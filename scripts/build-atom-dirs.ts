#!/usr/bin/env node
/**
 * scripts/build-atom-dirs.ts
 *
 * End-to-end pipeline: walk *.prime source files, compile each into an
 * atom directory tree, then build the global _index.xml.
 *
 * Usage (node 22+ with native TS strip):
 *   node scripts/build-atom-dirs.ts \
 *     --src primes-v3/sources \
 *     --out compiled-v3
 *
 * Defaults:
 *   --src  primes-v2/modules  (the existing v2 corpus)
 *   --out  compiled-v3
 *
 * Options:
 *   --src <path>    Source directory containing *.prime files (recursive)
 *   --out <path>    Output directory for compiled atom dirs + _index.xml
 *   --limit <n>     Only compile the first N atoms (for testing)
 *   --verbose       Print each atom's file list
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, resolve, relative } from "path";

import { parse } from "../packages/parser/src/index.ts";
import { emitAtomDir } from "../packages/compiler/src/atom-dir-emitter.ts";
import { emitGlobalIndex } from "../packages/compiler/src/global-index-emitter.ts";
import { resolveCorpusEdges, rewriteAtomYamlEdges } from "../packages/compiler/src/edge-resolver.ts";
import { checkL3Cross } from "../packages/compiler/src/checker-l3-cross.ts";
import { buildL2Prompt, parseL2Response } from "../packages/compiler/src/checker-l2.ts";
import { callAI } from "../packages/compiler/src/ai-client.ts";
import type { AtomMeta } from "../packages/compiler/src/global-index-emitter.ts";
import type { EmitResult } from "../packages/compiler/src/atom-dir-emitter.ts";

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const result = {
    src: "primes-v2/modules",
    out: "compiled-v3",
    limit: Infinity,
    verbose: false,
    /** Run L2 LLM semantic checks on every atom (requires API key). Costly. */
    enableL2: false,
    /** Sample N atoms for L2 instead of all (for cost-bounded smoke). */
    l2Sample: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src" && argv[i + 1]) result.src = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) result.out = argv[++i];
    else if (argv[i] === "--limit" && argv[i + 1]) result.limit = parseInt(argv[++i], 10);
    else if (argv[i] === "--verbose") result.verbose = true;
    else if (argv[i] === "--enable-l2-llm") result.enableL2 = true;
    else if (argv[i] === "--l2-sample" && argv[i + 1]) result.l2Sample = parseInt(argv[++i], 10);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const srcDir = resolve(args.src);
const outDir = resolve(args.out);

if (!existsSync(srcDir)) {
  console.error(`Source directory not found: ${srcDir}`);
  process.exit(1);
}

// ── Walk for *.prime files ───────────────────────────────────────────────────

function walkPrimeFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkPrimeFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".prime")) {
      results.push(full);
    }
  }
  return results;
}

const allFiles = walkPrimeFiles(srcDir);
const files = args.limit < Infinity ? allFiles.slice(0, args.limit) : allFiles;

if (files.length === 0) {
  console.error(`No .prime files found in: ${srcDir}`);
  process.exit(1);
}

console.log(`Found ${allFiles.length} .prime files in ${relative(process.cwd(), srcDir)}`);
if (args.limit < Infinity) {
  console.log(`  (limiting to first ${args.limit})`);
}
console.log(`Output: ${relative(process.cwd(), outDir)}`);
console.log();

// ── Compile each atom ────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);
const allMetas: AtomMeta[] = [];
const allAsts: any[] = [];
const errors: Array<{ file: string; error: string }> = [];

let compiled = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    errors.push({ file, error: `Read error: ${e}` });
    failed++;
    continue;
  }

  let ast: any;
  try {
    const parsed = parse(source, file);
    if (parsed.errors && parsed.errors.length > 0) {
      const msg = parsed.errors.map((e: any) => e.message).join("; ");
      errors.push({ file, error: `Parse error: ${msg}` });
      failed++;
      continue;
    }
    ast = parsed.ast ?? parsed;
  } catch (e: any) {
    errors.push({ file, error: `Parse exception: ${e?.message ?? String(e)}` });
    failed++;
    continue;
  }

  let result: EmitResult;
  try {
    result = emitAtomDir(ast, outDir, TODAY);
  } catch (e: any) {
    errors.push({ file, error: `Emit error: ${e?.message ?? String(e)}` });
    failed++;
    continue;
  }

  allMetas.push(result.meta);
  allAsts.push(ast);

  if (result.skipped) {
    skipped++;
    if (args.verbose) {
      console.log(`  [skip] ${result.atomId}`);
    }
  } else {
    compiled++;
    const relOut = relative(process.cwd(), result.outDir);
    console.log(`  → ${relOut}/`);
    if (args.verbose) {
      for (const f of result.files) {
        console.log(`       ${relative(process.cwd(), f)}`);
      }
    }
  }
}

// ── Warn about deprecated atoms (PRIME-SPEC v1 §6) ──────────────────────────

const deprecatedMetas = allMetas.filter(m => m.deprecated_at);
if (deprecatedMetas.length > 0) {
  console.warn(`\n⚠️  ${deprecatedMetas.length} deprecated atoms excluded from BROWSE index:`);
  for (const d of deprecatedMetas) {
    const supersede = (d as any).superseded_by ?? "no replacement";
    console.warn(`     ${d.id} (deprecated ${d.deprecated_at}) → ${supersede}`);
  }
}

// ── Resolve dangling edges (bare slug → full atom id) ──────────────────────
//
// Source `.prime` files commonly write `conflicts: ["brutalist"]` instead of
// `conflicts: ["@impeccable/persona-brutalist"]`. The compiler emits the
// raw target verbatim, so the graph is full of dangling refs. This pass
// fixes them up using a slug→fullId index built from all known atoms.

if (allMetas.length > 0) {
  const stats = resolveCorpusEdges(allMetas);
  if (stats.resolved > 0) {
    console.log(`\n🔗 edge resolver: ${stats.resolved}/${stats.scanned} bare-slug edges resolved`);
    const rewriteRes = await rewriteAtomYamlEdges(allMetas, outDir);
    if (rewriteRes.files_changed > 0) {
      console.log(`   atom.yaml files patched: ${rewriteRes.files_changed}`);
    }
  }
  if (stats.unresolved.length > 0) {
    console.warn(`   ⚠️  ${stats.unresolved.length} edges still unresolved (bare slug with no matching atom)`);
    if (args.verbose) {
      for (const u of stats.unresolved.slice(0, 10)) {
        console.warn(`      ${u.source} --[${u.type}]→ ${u.target}`);
      }
    }
  }
  if (stats.ambiguous.length > 0) {
    console.warn(`   ⚠️  ${stats.ambiguous.length} ambiguous (slug matches multiple kinds — left as-is)`);
  }
}

// ── L2 LLM semantic check (opt-in, requires API key) ──────────────────────
//
// Run a per-atom semantic prompt through the configured LLM. Only fires when
// the user explicitly enables it because each call costs $0.001-$0.01. Errors
// at this stage warn rather than block — the LLM judge is advisory, not gate.

if (args.enableL2 && allAsts.length > 0) {
  const sample = args.l2Sample < Infinity ? allAsts.slice(0, args.l2Sample) : allAsts;
  console.log(`\n🤖 L2 LLM semantic check — running over ${sample.length} atoms (this can take a while)`);
  const l2Findings: Array<{ atom: string; level: string; message: string }> = [];
  let l2Calls = 0;
  let l2Empty = 0;
  for (const ast of sample) {
    const name = ast?.body?.find((f: any) => f.key === "name")?.value?.value
      ?? ast?.name
      ?? "(unknown)";
    let response: string;
    try {
      response = await callAI(buildL2Prompt(ast));
    } catch (e) {
      l2Empty++;
      continue;
    }
    l2Calls++;
    if (!response) { l2Empty++; continue; }
    const diags = parseL2Response(response);
    for (const d of diags) {
      if (d.level === "error" || d.level === "warn") {
        l2Findings.push({ atom: name, level: d.level, message: d.message });
      }
    }
  }
  console.log(`   ${l2Calls} calls succeeded, ${l2Empty} empty/failed`);
  console.log(`   ${l2Findings.length} L2 findings (advisory, non-blocking)`);
  if (args.verbose && l2Findings.length > 0) {
    for (const f of l2Findings.slice(0, 30)) {
      console.warn(`     [L2/${f.level}] ${f.atom}: ${f.message}`);
    }
  }
} else if (args.enableL2) {
  console.warn(`\n🤖 L2 LLM check requested but no ASTs collected.`);
}

// ── L3 cross-atom check (C1 dup names / C2 dead refs / C3 dedup / C4 orphan) ──
//
// Was previously only run via standalone scripts; wiring it into the main
// compile flow means dup-name / dead-ref bugs fail loudly on every build.

if (allAsts.length > 0) {
  const findings = checkL3Cross(allAsts, {
    jaccardThreshold: 0.85,
    minTagsForDupCheck: 4,
    maxDuplicatePairs: 50,
  });
  const errors3 = findings.filter((f) => f.level === "error");
  const suggestions3 = findings.filter((f) => f.level === "suggestion");
  if (errors3.length > 0) {
    console.warn(`\n🔍 L3 cross-atom: ${errors3.length} errors`);
    if (args.verbose) {
      for (const f of errors3.slice(0, 20)) {
        console.warn(`     [${f.code}] ${f.atom}: ${f.message}`);
      }
    } else {
      const byCode = errors3.reduce((m, f) => { m[f.code] = (m[f.code] ?? 0) + 1; return m; }, {} as Record<string, number>);
      for (const [code, n] of Object.entries(byCode)) {
        console.warn(`     ${code}: ${n}`);
      }
    }
  }
  if (suggestions3.length > 0 && args.verbose) {
    console.warn(`   ${suggestions3.length} suggestions (C3/C4) — re-run with --verbose for list`);
  }
}

// ── Build global _index.xml ──────────────────────────────────────────────────

let indexTokens = 0;
if (allMetas.length > 0) {
  indexTokens = emitGlobalIndex(allMetas, outDir);
}

const indexRelPath = relative(process.cwd(), join(outDir, "_index.xml"));

// ── Cluster count ────────────────────────────────────────────────────────────

const domains = new Set(allMetas.map((m) => m.domain || m.tags[0] || "general"));

// ── Stats summary ────────────────────────────────────────────────────────────

console.log();
console.log("─".repeat(60));
console.log(`${compiled + skipped} atoms compiled`);
if (skipped > 0) console.log(`  (${skipped} skipped — content unchanged)`);
if (failed > 0) console.log(`  ${failed} failed`);
console.log(`  → ${indexRelPath} (${indexTokens} tokens, ${allMetas.length} atoms across ${domains.size} clusters)`);

if (errors.length > 0) {
  console.log();
  console.log(`Errors (${errors.length}):`);
  for (const e of errors) {
    console.log(`  ${relative(process.cwd(), e.file)}: ${e.error}`);
  }
  process.exit(1);
}
