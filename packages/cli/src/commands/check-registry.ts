/**
 * prime check --registry — Validate the entire local atom registry.
 *
 * Checks:
 *   1. Every atom has a valid semver version field
 *   2. Every @scope/name reference in any dep edge resolves locally
 *   3. must-avoid self-references (atom A avoids itself)
 *
 * Usage:
 *   prime check --registry [--dir <path>] [--json] [--scope @community]
 */

import { header, bold, green, yellow, red, gray, success, error, warn } from '../utils/display';
import { listAllScopes, loadAtom, resolveAtomPath, DEFAULT_SOURCES_DIR } from './registry';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

interface AtomDiag {
  id: string;
  errors: string[];
  warnings: string[];
}

export interface RegistryCheckResult {
  total: number;
  passed: number;
  failed: number;
  diagnostics: AtomDiag[];
}

export async function checkRegistryCommand(args: string[]): Promise<void> {
  let sourcesDir = DEFAULT_SOURCES_DIR;
  let filterScope: string | undefined;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) sourcesDir = args[++i];
    else if (args[i] === '--scope' && args[i + 1]) filterScope = args[++i];
    else if (args[i] === '--json') jsonMode = true;
  }

  const result = await runRegistryCheck(sourcesDir, filterScope);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.failed > 0 ? 1 : 0);
  }

  printResult(result, sourcesDir);
  process.exit(result.failed > 0 ? 1 : 0);
}

export async function runRegistryCheck(
  sourcesDir = DEFAULT_SOURCES_DIR,
  filterScope?: string
): Promise<RegistryCheckResult> {
  const scopes = listAllScopes(sourcesDir);
  const filtered = filterScope ? scopes.filter(s => s.scope === filterScope) : scopes;

  const diagnostics: AtomDiag[] = [];
  let total = 0;
  let failed = 0;

  for (const { scope, atoms } of filtered) {
    for (const name of atoms) {
      const id = `${scope}/${name}`;
      total++;
      const diag: AtomDiag = { id, errors: [], warnings: [] };

      const atom = loadAtom(id, sourcesDir);
      if (!atom) {
        diag.errors.push('Could not load atom');
        failed++;
        diagnostics.push(diag);
        continue;
      }

      // 1. semver
      if (!atom.version || atom.version === '0.0.0') {
        diag.warnings.push(`version is missing or placeholder ('${atom.version}')`);
      } else if (!SEMVER_RE.test(atom.version)) {
        diag.errors.push(`version '${atom.version}' is not valid semver (expected x.y.z)`);
      }

      // 2. dep refs resolve
      // compositionExtras may contain @scope/name refs for domain-specific
      // fields (e.g. an `x-prescriptions` field declared by some corpus).
      // Resolve them the same way as the universal edges.
      const extraRefs: Array<{ ref: string; edge: string }> = [];
      for (const [field, val] of Object.entries(atom.compositionExtras)) {
        for (const ref of (val ?? '').split(/[\s,]+/).filter(r => r.startsWith('@'))) {
          extraRefs.push({ ref, edge: field });
        }
      }
      const depEdges: Array<{ ref: string; edge: string }> = [
        ...atom.mustInclude.map(r => ({ ref: r, edge: 'must-include' })),
        ...atom.mustAvoid.map(r => ({ ref: r, edge: 'must-avoid' })),
        ...extraRefs,
        ...atom.related.map(r => ({ ref: r, edge: 'related' })),
      ];

      for (const { ref, edge } of depEdges) {
        if (!resolveAtomPath(ref, sourcesDir)) {
          diag.errors.push(`${edge}: '${ref}' not found`);
        }
      }

      // 3. self-reference in must-avoid
      if (atom.mustAvoid.includes(id)) {
        diag.errors.push(`must-avoid references itself (${id})`);
      }

      if (diag.errors.length > 0) failed++;
      if (diag.errors.length > 0 || diag.warnings.length > 0) {
        diagnostics.push(diag);
      }
    }
  }

  return { total, passed: total - failed, failed, diagnostics };
}

function printResult(result: RegistryCheckResult, sourcesDir: string) {
  header('Prime Registry — Integrity Check');

  const { total, passed, failed, diagnostics } = result;

  // Summary bar
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log(`\n  ${bold('Atoms checked:')}   ${total}`);
  console.log(`  ${bold('Passed:')}          ${green(String(passed))}`);
  console.log(`  ${bold('With issues:')}     ${failed > 0 ? red(String(failed)) : green('0')}`);
  console.log(`  ${bold('Pass rate:')}       ${passRate >= 90 ? green(`${passRate}%`) : passRate >= 70 ? yellow(`${passRate}%`) : red(`${passRate}%`)}`);

  if (diagnostics.length === 0) {
    console.log();
    success('All atoms pass semver and reference checks.');
    return;
  }

  // Group: errors first, then warnings
  const withErrors = diagnostics.filter(d => d.errors.length > 0);
  const warnOnly = diagnostics.filter(d => d.errors.length === 0 && d.warnings.length > 0);

  if (withErrors.length > 0) {
    console.log(`\n  ${bold(red('Errors'))}  (${withErrors.length} atoms)`);
    console.log(`  ${'─'.repeat(55)}`);
    for (const d of withErrors.slice(0, 40)) {
      console.log(`\n  ${red('·')} ${bold(d.id)}`);
      for (const e of d.errors) console.log(`      ${red('✕')} ${e}`);
      for (const w of d.warnings) console.log(`      ${yellow('⚠')} ${w}`);
    }
    if (withErrors.length > 40) {
      console.log(`\n  ${gray(`... and ${withErrors.length - 40} more. Run with --json for full output.`)}`);
    }
  }

  if (warnOnly.length > 0) {
    console.log(`\n  ${bold(yellow('Warnings only'))}  (${warnOnly.length} atoms)`);
    console.log(`  ${'─'.repeat(55)}`);
    for (const d of warnOnly.slice(0, 20)) {
      console.log(`  ${yellow('⚠')} ${d.id}  ${gray(d.warnings[0])}`);
    }
    if (warnOnly.length > 20) {
      console.log(`  ${gray(`... and ${warnOnly.length - 20} more.`)}`);
    }
  }

  console.log(`\n  ${gray(`Sources: ${sourcesDir}`)}`);
}
