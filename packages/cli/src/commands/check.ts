/**
 * prime check <file> — Check a .prime or .md file without emitting output.
 * Supports checking existing SKILL.md files too.
 */

import { resolve, basename } from 'path';
import { header, success, error, diagnosticLine, createSpinner, green, red, yellow, gray } from '../utils/display';
import { readFile, fileExists } from '../utils/fs';

export async function checkCommand(args: string[]) {
  const file = args[0];
  if (!file) {
    console.error('Usage: prime check <file.prime|SKILL.md>');
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!fileExists(filePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const isPrime = file.endsWith('.prime');
  const isSkill = file.toLowerCase().includes('skill');

  header(`Prime Check — ${basename(filePath)}`);

  const source = await readFile(filePath);

  if (isPrime) {
    await checkPrimeFile(source, filePath);
  } else {
    await checkMarkdownFile(source, filePath, isSkill);
  }
}

async function checkPrimeFile(source: string, filePath: string) {
  const spinner = createSpinner('Running structural checks...');

  // Use the compile command's checker without emitting
  const diagnostics: any[] = [];

  // Basic checks
  if (!source.includes('extends')) {
    diagnostics.push({ level: 'error', message: 'Missing extends clause' });
  }
  if (!source.includes('name:')) {
    diagnostics.push({ level: 'error', message: 'Missing name field' });
  }

  const baseMatch = source.match(/extends\s+(\w+)/);
  const base = baseMatch?.[1];

  if (base === 'Method') {
    if (!source.includes('input:')) diagnostics.push({ level: 'error', message: 'Method missing input declaration' });
    if (!source.includes('output:')) diagnostics.push({ level: 'error', message: 'Method missing output declaration' });
    if (!source.includes('steps:')) diagnostics.push({ level: 'error', message: 'Method missing steps declaration' });
    if (!source.includes('success_criteria:')) diagnostics.push({ level: 'warn', message: 'Method has no success_criteria — how will you know if execution succeeded?' });

    // Check steps have error handlers
    const stepBlocks = source.match(/\w+\s*\{[^}]*\}/g) || [];
    for (const block of stepBlocks) {
      const stepName = block.match(/^(\w+)/)?.[1];
      if (stepName && stepName !== stepName.toLowerCase() && !block.includes('error:') && !block.includes('@safe')) {
        diagnostics.push({ level: 'warn', message: `Step '${stepName}' has no error handler. Add error: or mark @safe` });
      }
    }
  }

  if (base === 'Knowledge') {
    const hasContent = source.includes('definitions:') || source.includes('categories:') || source.includes('facts:');
    if (!hasContent) diagnostics.push({ level: 'error', message: 'Knowledge must have at least one of: definitions, categories, facts' });
  }

  if (base === 'Rule') {
    if (!source.includes('checks:')) diagnostics.push({ level: 'error', message: 'Rule missing checks declaration' });
  }

  // Check links references
  const useRefs = [...source.matchAll(/(?:requires|validates_with|enhances|contradicts|specializes|supplies_to)\s+"([^"]+)"/g)];
  for (const ref of useRefs) {
    // In a full implementation, we'd check if the referenced Prime exists
    diagnostics.push({ level: 'suggestion', message: `Reference '${ref[1]}' — ensure this Prime is installed` });
  }

  const errors = diagnostics.filter(d => d.level === 'error');
  const warnings = diagnostics.filter(d => d.level === 'warn');

  spinner.stop(errors.length > 0
    ? `${red('❌')} ${errors.length} errors, ${warnings.length} warnings`
    : warnings.length > 0
      ? `${yellow('⚠️')} 0 errors, ${warnings.length} warnings`
      : `${green('✅')} All checks passed`
  );

  for (const d of diagnostics) {
    diagnosticLine(d.level, d.line, d.message, d.suggestion);
  }

  if (errors.length > 0) process.exit(1);
}

async function checkMarkdownFile(source: string, filePath: string, isSkill: boolean) {
  const spinner = createSpinner('Analyzing Markdown structure...');
  const diagnostics: any[] = [];

  if (isSkill) {
    // Check SKILL.md for Prime-related issues
    if (!source.includes('primes:') && !source.includes('prime:')) {
      diagnostics.push({ level: 'suggestion', message: 'This Skill does not reference any Primes. Consider using `prime decompose` to extract reusable knowledge.' });
    }

    // Check for common Skill quality issues
    const lines = source.split('\n');
    if (lines.length > 500) {
      diagnostics.push({ level: 'warn', message: `This Skill is ${lines.length} lines. Consider breaking it into smaller Primes for reusability.` });
    }

    // Check for error handling in steps
    const hasSteps = source.match(/^###?\s+\d+\./gm);
    if (hasSteps && !source.toLowerCase().includes('error') && !source.toLowerCase().includes('fail')) {
      diagnostics.push({ level: 'warn', message: 'Steps defined but no error handling found. What happens when a step fails?' });
    }
  }

  spinner.stop(`${green('✅')} Analysis complete`);

  for (const d of diagnostics) {
    diagnosticLine(d.level, d.line, d.message, d.suggestion);
  }

  if (diagnostics.length === 0) {
    success('No issues found.');
  }
}
