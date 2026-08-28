/**
 * prime compile <file.prime> [--deep] [--output <dir>] [--bundle]
 *
 * Compiles a .prime file through 4 phases:
 *   Phase 1: Parse (.prime → AST)
 *   Phase 2: Check (structural + logic + domain)
 *   Phase 3: Resolve (dependencies)
 *   Phase 4: Emit (AST → optimized .md + bundle + index + graph)
 */

import { resolve as resolvePath, basename, dirname, join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { header, success, error, warn, info, diagnosticLine, createSpinner, bold, green, yellow, red, gray } from '../utils/display';
import { readFile, writeFile, fileExists } from '../utils/fs';

import { parseLegacy as parse } from '@skill-wiki/parser';
import {
  checkL1,
  resolve as resolveGraph,
  emitMarkdown,
  emitBundle,
  emitIndex,
  emitGraph,
  estimateTokens,
  emitAtomDir,
  emitGlobalIndex,
} from '@skill-wiki/compiler';
import type { InstalledPrime, AtomMeta } from '@skill-wiki/compiler';
import type { PrimeAST, AtomDeclaration } from '@skill-wiki/types';

function isPrimeAST(ast: PrimeAST | AtomDeclaration): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

export async function compileCommand(args: string[]) {
  const flags = parseFlags(args);

  if (!flags.file) {
    console.error('Usage: prime compile <file.prime> [--deep] [--output <dir>] [--bundle]');
    process.exit(1);
  }

  const filePath = resolvePath(flags.file);
  if (!fileExists(filePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  header(`Prime Compiler v0.1`);
  console.log(gray(`  Compiling: ${basename(filePath)}`));
  console.log();

  const source = await readFile(filePath);

  // ── Phase 1: Parse ──────────────────────────────────────────────────────
  const parseSpinner = createSpinner('Phase 1: Parsing...');
  const { ast, errors: parseErrors } = parse(source, basename(filePath));

  if (parseErrors.length > 0) {
    parseSpinner.stop(`${red('❌')} Phase 1: ${parseErrors.length} syntax errors`);
    for (const err of parseErrors) {
      diagnosticLine('error', err.line, err.message, err.suggestion);
    }
    process.exit(1);
  }
  const lineCount = source.split('\n').length;
  parseSpinner.stop(`${green('✅')} Phase 1: Parsed ${lineCount} lines, 0 syntax errors`);

  // ── Build installedPrimes map ───────────────────────────────────────────
  const installedPrimes = new Map<string, InstalledPrime>();
  const searchDirs = [
    join(dirname(filePath), '.primes', 'source'),
    join(dirname(filePath), '..', '.primes', 'source'),
    join(process.cwd(), '.primes', 'source'),
    join(process.cwd(), 'primes'),
    join(dirname(filePath)),  // also scan the directory of the file itself
  ];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f: string) => f.endsWith('.prime'))) {
      const primeName = f.replace('.prime', '');
      if (installedPrimes.has(primeName)) continue; // first found wins
      try {
        const primeSource = readFileSync(join(dir, f), 'utf-8');
        const { ast: primeAst } = parse(primeSource, f);
        const nameField = primeAst.body.find((field) => field.key === 'name');
        const versionField = primeAst.body.find((field) => field.key === 'version');
        const name = nameField && nameField.value.type === 'String'
          ? (nameField.value as any).value
          : primeName;
        const version = versionField && versionField.value.type === 'String'
          ? (versionField.value as any).value
          : '0.0.0';
        const baseType = (isPrimeAST(primeAst) ? primeAst.extends : undefined) || 'Unknown';
        installedPrimes.set(primeName, {
          name,
          version,
          type: baseType,
          ast: primeAst,
        });
      } catch {
        // Skip files that fail to parse
      }
    }
  }

  // ── Phase 2: Check ──────────────────────────────────────────────────────
  const level = flags.deep ? 3 : flags.structureOnly ? 1 : 2;
  const checkSpinner = createSpinner(`Phase 2: Checking (Level ${level})...`);

  const diagnostics = checkL1(ast, installedPrimes);

  if (level >= 2) {
    // L2 logic check would call AI — placeholder for now
    // const { buildL2Prompt, parseL2Response } = await import('@skill-wiki/compiler');
    // const prompt = buildL2Prompt(ast);
    // const response = await callAI(prompt);
    // diagnostics.push(...parseL2Response(response));
  }

  if (level >= 3) {
    // L3 domain check — same pattern
    // const { buildL3Prompt, parseL3Response } = await import('@skill-wiki/compiler');
    // const prompt = buildL3Prompt(ast);
    // const response = await callAI(prompt);
    // diagnostics.push(...parseL3Response(response));
  }

  const errors_list = diagnostics.filter((d) => d.level === 'error');
  const warnings = diagnostics.filter((d) => d.level === 'warn');
  const suggestions = diagnostics.filter((d) => d.level === 'suggestion');

  if (errors_list.length > 0) {
    checkSpinner.stop(`${red('❌')} Phase 2: ${errors_list.length} errors, ${warnings.length} warnings`);
  } else if (warnings.length > 0) {
    checkSpinner.stop(`${yellow('⚠️')} Phase 2: 0 errors, ${warnings.length} warnings`);
  } else {
    checkSpinner.stop(`${green('✅')} Phase 2: All checks passed`);
  }

  for (const d of diagnostics) {
    diagnosticLine(d.level, d.line, d.message, d.suggestion);
  }

  if (errors_list.length > 0) {
    console.log();
    error(`${errors_list.length} error(s). Fix and re-compile.`);
    process.exit(1);
  }

  // ── Phase 3: Resolve ────────────────────────────────────────────────────
  const resolveSpinner = createSpinner('Phase 3: Resolving dependencies...');
  const { graph, diagnostics: resolverDiags } = resolveGraph(ast, installedPrimes);

  const resolverErrors = resolverDiags.filter((d) => d.level === 'error');
  if (resolverErrors.length > 0) {
    resolveSpinner.stop(`${red('❌')} Phase 3: Dependency conflicts`);
    for (const d of resolverDiags) {
      diagnosticLine(d.level, d.line, d.message, d.suggestion);
    }
    process.exit(1);
  }
  const depCount = graph.nodes.length - 1; // exclude root
  resolveSpinner.stop(`${green('✅')} Phase 3: ${depCount} dependencies resolved`);

  // ── Phase 4: Emit ───────────────────────────────────────────────────────
  const emitSpinner = createSpinner('Phase 4: Emitting...');
  const outputDir = flags.output || join(dirname(filePath), 'compiled');

  if (flags.dir) {
    // ── New: emit atom directory tree ─────────────────────────────────
    const result = emitAtomDir(ast, outputDir);
    const allMeta: AtomMeta[] = [result.meta];
    emitGlobalIndex(allMeta, outputDir);

    emitSpinner.stop(`${green('✅')} Phase 4: Emitted atom directory`);
    console.log();
    if (result.skipped) {
      info(`Skipped (content unchanged): ${result.atomId}`);
    } else {
      success(`${bold(result.outDir)}`);
      for (const f of result.files) {
        console.log(gray(`    → ${f}`));
      }
      success(`${join(outputDir, '_index.xml')}`);
    }
    console.log();
    console.log(`  Tokens: summary=${result.tokens.summary} core=${result.tokens.core} full=${result.tokens.full}`);
  } else {
    // ── Legacy: emit flat .md files ───────────────────────────────────
    const nameField = ast.body.find((field) => field.key === 'name');
    const primeName = nameField && nameField.value.type === 'String'
      ? (nameField.value as any).value
      : basename(filePath, '.prime');

    const compiledMd = emitMarkdown(ast);
    const sourceTokens = estimateTokens(source);
    const compiledTokens = estimateTokens(compiledMd);

    let bundleMd: string | undefined;
    let bundleTokens: number | undefined;
    if (flags.bundle) {
      bundleMd = emitBundle(ast, graph, installedPrimes);
      bundleTokens = estimateTokens(bundleMd);
    }

    const indexYaml = emitIndex(ast, graph, sourceTokens, compiledTokens, bundleTokens);
    const graphYaml = emitGraph(graph);

    await writeFile(join(outputDir, `${primeName}.md`), compiledMd);
    await writeFile(join(outputDir, `${primeName}.index.yaml`), indexYaml);
    await writeFile(join(outputDir, `${primeName}.graph.yaml`), graphYaml);

    if (flags.bundle && bundleMd) {
      await writeFile(join(outputDir, `${primeName}.bundle.md`), bundleMd);
    }

    const reduction = sourceTokens > 0 ? Math.round((1 - compiledTokens / sourceTokens) * 100) : 0;

    emitSpinner.stop(`${green('✅')} Phase 4: Emitted`);
    console.log();
    success(`${bold(join(outputDir, `${primeName}.md`))} (${compiledTokens} tokens, ${reduction}% reduction)`);
    success(`${join(outputDir, `${primeName}.index.yaml`)}`);
    success(`${join(outputDir, `${primeName}.graph.yaml`)}`);
    if (flags.bundle) {
      success(`${join(outputDir, `${primeName}.bundle.md`)}`);
    }
  }

  console.log();
  console.log(`  Result: ${green(`${errors_list.length} errors`)}, ${yellow(`${warnings.length} warnings`)}, ${suggestions.length} suggestions. ${bold('Compilation successful.')}`);
}

// --- Internal helpers ---

function parseFlags(args: string[]) {
  const flags: any = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--deep') flags.deep = true;
    else if (args[i] === '--structure-only') flags.structureOnly = true;
    else if (args[i] === '--bundle') flags.bundle = true;
    else if (args[i] === '--dir') flags.dir = true;
    else if (args[i] === '--output' && args[i + 1]) { flags.output = args[++i]; }
    else if (!args[i].startsWith('-')) flags.file = args[i];
  }
  return flags;
}
