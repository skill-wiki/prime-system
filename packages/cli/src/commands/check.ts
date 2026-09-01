/**
 * aoe check <file> — Check a source file without emitting output.
 *
 * This command used to run its *own* checker: regexes for `extends` and `name:`,
 * a branch per prime-v1 base type asserting which fields each one requires, and a
 * hardcoded relation-verb regex. Two rules were broken at once —
 *
 *  - §3.1: "a Method must declare input/output/steps" is a Model Package
 *    statement, not something the CLI is allowed to believe.
 *  - §8.1: "CLI, MCP and scripts may no longer each copy the parse/check/emit
 *    stages" — that private checker was a second, diverging implementation of
 *    Phase 2, so `aoe check` and `aoe compile` could disagree about the same
 *    file.
 *
 * Both are fixed by the same move: call the one compiler pipeline.
 */

import { resolve, basename } from 'path';
import { header, success, error, diagnosticLine, createSpinner, green, red, yellow } from '../utils/display';
import { readFile, fileExists } from '../utils/fs';
import { parseLegacy } from '@aoe/parser';
import { checkL1 } from '@aoe/compiler';
import type { Diagnostic } from '@aoe/compiler';

export async function checkCommand(args: string[]) {
  const file = args[0];
  if (!file) {
    console.error('Usage: aoe check <file.prime|SKILL.md>');
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!fileExists(filePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const isPrime = file.endsWith('.prime');
  const isSkill = file.toLowerCase().includes('skill');

  header(`AOE Check — ${basename(filePath)}`);

  const source = await readFile(filePath);

  if (isPrime) {
    await checkPrimeFile(source, basename(filePath));
  } else {
    await checkMarkdownFile(source, isSkill);
  }
}

/** Runs Phase 1 + Phase 2 of the compiler pipeline. Emits nothing. */
async function checkPrimeFile(source: string, filename: string) {
  const spinner = createSpinner('Running pipeline checks...');

  let diagnostics: Diagnostic[];
  try {
    const { ast, errors: parseErrors } = parseLegacy(source, filename);
    if (parseErrors.length > 0) {
      spinner.stop(`${red('❌')} ${parseErrors.length} syntax error(s)`);
      for (const err of parseErrors) diagnosticLine('error', err.line, err.message, err.suggestion);
      process.exit(1);
    }
    // No installed-unit map: `check` is a single-file gate, so cross-unit
    // reference resolution is deliberately out of scope here (that is `compile`).
    diagnostics = checkL1(ast, new Map());
  } catch (err) {
    spinner.stop(`${red('❌')} Parse failed`);
    error((err as Error).message);
    process.exit(1);
  }

  const errors = diagnostics.filter((d) => d.level === 'error');
  const warnings = diagnostics.filter((d) => d.level === 'warn');

  spinner.stop(
    errors.length > 0
      ? `${red('❌')} ${errors.length} errors, ${warnings.length} warnings`
      : warnings.length > 0
        ? `${yellow('⚠️')} 0 errors, ${warnings.length} warnings`
        : `${green('✅')} All checks passed`,
  );

  for (const d of diagnostics) diagnosticLine(d.level, d.line, d.message, d.suggestion);

  if (errors.length > 0) process.exit(1);
}

async function checkMarkdownFile(source: string, isSkill: boolean) {
  const spinner = createSpinner('Analyzing Markdown structure...');
  const diagnostics: { level: 'error' | 'warn' | 'suggestion'; line?: number; message: string; suggestion?: string }[] = [];

  if (isSkill) {
    if (!source.includes('primes:') && !source.includes('prime:')) {
      diagnostics.push({
        level: 'suggestion',
        message: 'This document references no units. Consider `aoe decompose` to extract reusable knowledge.',
      });
    }

    const lines = source.split('\n');
    if (lines.length > 500) {
      diagnostics.push({
        level: 'warn',
        message: `This document is ${lines.length} lines. Consider splitting it into smaller units for reuse.`,
      });
    }
  }

  spinner.stop(`${green('✅')} Analysis complete`);

  for (const d of diagnostics) diagnosticLine(d.level, d.line, d.message, d.suggestion);

  if (diagnostics.length === 0) success('No issues found.');
}
