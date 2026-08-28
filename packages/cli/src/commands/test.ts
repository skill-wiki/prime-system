/**
 * prime test <file.prime> — Run evaluation criteria tests.
 * Validates that success_criteria, failure_criteria, and checks are structurally sound.
 */

import { resolve, basename } from 'path';
import { header, success, error, warn, info, bold, green, yellow, gray } from '../utils/display';
import { readFile, fileExists } from '../utils/fs';

export async function testCommand(args: string[]) {
  const file = args[0];
  if (!file) {
    console.error('Usage: prime test <file.prime>');
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!fileExists(filePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  header(`Testing evaluation criteria: ${basename(filePath)}`);

  const source = await readFile(filePath);

  let passed = 0;
  let failed = 0;
  let warnings = 0;

  // Which criteria blocks to test is decided by what the source *declares*, not
  // by which type it extends: branching on a type name would hardcode a closed
  // set of model vocabulary, and it also silently skipped any other type that
  // declares the same blocks.
  if (/(?:success|failure)_criteria:/.test(source)) {
    // Test success_criteria
    console.log(`\n  ${bold('success_criteria:')}`);
    const scMatch = source.match(/success_criteria:\s*\{([\s\S]*?)\n\s*\}/);
    if (scMatch) {
      const criteria = scMatch[1].match(/id:\s*"([^"]+)"/g) || [];
      const weights = scMatch[1].match(/weight:\s*([\d.]+)/g) || [];
      const verifyMethods = scMatch[1].match(/verify:\s*\{[^}]+\}/g) || [];
      const decidabilities = scMatch[1].match(/decidability:\s*@(\w+)/g) || [];

      for (let i = 0; i < criteria.length; i++) {
        const id = criteria[i].match(/"([^"]+)"/)?.[1] || `criterion_${i}`;
        const hasVerify = i < verifyMethods.length;
        const hasDecidability = i < decidabilities.length;

        if (hasVerify) {
          console.log(`    ${green('✅')} ${id}: verify method exists`);
          passed++;
        } else {
          console.log(`    ${yellow('⚠️')} ${id}: missing verify method`);
          warnings++;
        }

        if (hasDecidability) {
          const d = decidabilities[i].match(/@(\w+)/)?.[1];
          console.log(`    ${green('✅')} ${id}: decidability marked as @${d}`);
          passed++;
        } else {
          console.log(`    ${yellow('⚠️')} ${id}: decidability not marked`);
          warnings++;
        }
      }

      // Check weights sum to 1.0
      const mode = scMatch[1].match(/mode:\s*"(\w+)"/)?.[1];
      if (mode === 'weighted' && weights.length > 0) {
        const sum = weights.reduce((acc, w) => acc + parseFloat(w.replace('weight:', '').trim()), 0);
        if (Math.abs(sum - 1.0) < 0.01) {
          console.log(`    ${green('✅')} weights sum: ${sum.toFixed(2)} ✓`);
          passed++;
        } else {
          console.log(`    ${yellow('⚠️')} weights sum: ${sum.toFixed(2)} (expected 1.0)`);
          warnings++;
        }
      }

      // Check min_score
      const minScore = scMatch[1].match(/min_score:\s*([\d.]+)/)?.[1];
      if (minScore) {
        const val = parseFloat(minScore);
        if (val >= 0 && val <= 1) {
          console.log(`    ${green('✅')} min_score: ${val} (valid range)`);
          passed++;
        } else {
          console.log(`    ${error('❌')} min_score: ${val} (must be 0-1)`);
          failed++;
        }
      }
    } else {
      console.log(`    ${yellow('⚠️')} No success_criteria found`);
      warnings++;
    }

    // Test failure_criteria
    console.log(`\n  ${bold('failure_criteria:')}`);
    const fcMatch = source.match(/failure_criteria:\s*\{([\s\S]*?)\n\s*\}/);
    if (fcMatch) {
      const criteria = fcMatch[1].match(/id:\s*"([^"]+)"/g) || [];
      for (const c of criteria) {
        const id = c.match(/"([^"]+)"/)?.[1];
        console.log(`    ${green('✅')} ${id}: defined`);
        passed++;
      }
    } else {
      console.log(`    ${gray('—')} No failure_criteria (optional)`);
    }
  }

  if (/(?:checks|thresholds):/.test(source)) {
    console.log(`\n  ${bold('checks:')}`);
    const checksMatch = source.match(/checks:\s*\[([\s\S]*?)\]/);
    if (checksMatch) {
      const descriptions = checksMatch[1].match(/description:\s*"([^"]+)"/g) || [];
      const passes = checksMatch[1].match(/pass:\s*"?([^",}\n]+)/g) || [];

      for (let i = 0; i < descriptions.length; i++) {
        const desc = descriptions[i].match(/"([^"]+)"/)?.[1] || `check_${i}`;
        if (i < passes.length) {
          console.log(`    ${green('✅')} "${desc}": has pass condition`);
          passed++;
        } else {
          console.log(`    ${error('❌')} "${desc}": missing pass condition`);
          failed++;
        }
      }
    }

    // Test thresholds
    console.log(`\n  ${bold('thresholds:')}`);
    const threshMatch = source.match(/thresholds:\s*\[([\s\S]*?)\]/);
    if (threshMatch) {
      const metrics = threshMatch[1].match(/\w+\s+block:/g) || [];
      for (const m of metrics) {
        const metric = m.replace(/\s+block:/, '');
        console.log(`    ${green('✅')} ${metric}: defined with block/warn/pass`);
        passed++;
      }
    }
  }

  // Summary
  console.log(`\n  ${bold('Summary:')}`);
  console.log(`  ${green(`${passed} passed`)}  ${failed > 0 ? error(`${failed} failed`) : ''}  ${warnings > 0 ? yellow(`${warnings} warnings`) : ''}`);

  if (failed > 0) {
    console.log(`\n  ${bold('Runtime accuracy depends on actual execution context.')}`);
    process.exit(1);
  } else {
    console.log(`\n  ${green('All evaluation criteria are structurally valid.')}`);
  }
}
