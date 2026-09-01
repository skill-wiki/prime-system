/**
 * aoe show <@scope/name> — Print atom details and all relationship refs.
 *
 * Options:
 *   --dir <path>   Override default sources directory
 *   --json         Output raw JSON
 */

import { header, bold, cyan, green, gray, red } from '../utils/display';
import { loadAtom, DEFAULT_SOURCES_DIR, AtomMeta } from './registry';
import { colorKind } from '../utils/kind-color';

export async function showCommand(args: string[]): Promise<void> {
  let id: string | undefined;
  let sourcesDir = DEFAULT_SOURCES_DIR;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) sourcesDir = args[++i];
    else if (args[i] === '--json') jsonMode = true;
    else if (!args[i].startsWith('-')) id = args[i];
  }

  if (!id) {
    console.error('Usage: aoe show <@scope/name> [--json]');
    process.exit(1);
  }

  const atom = loadAtom(id, sourcesDir);
  if (!atom) {
    console.error(`Atom '${id}' not found in ${sourcesDir}`);
    console.error('Tip: run  aoe list  to see all available atoms.');
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(atom, null, 2));
    return;
  }

  printAtom(atom);
}

function printAtom(a: AtomMeta) {
  header(`${a.id}  (${a.kind})`);

  console.log(`  ${bold('version')}     ${green(a.version)}`);
  console.log(`  ${bold('kind')}        ${colorKind(a.kind)}`);
  console.log(`  ${bold('scope')}       ${a.scope}`);
  console.log(`  ${bold('file')}        ${gray(a.filePath)}`);
  if (a.description) {
    // Word-wrap description at 72 chars
    const wrapped = wordWrap(a.description, 72);
    console.log(`\n  ${bold('description')}`);
    for (const line of wrapped) console.log(`    ${gray(line)}`);
  }

  // Composition
  if (a.mustInclude.length > 0) {
    console.log(`\n  ${bold('must-include')}  (${a.mustInclude.length})`);
    for (const ref of a.mustInclude) console.log(`    ${green('+')} ${ref}`);
  }
  if (a.mustAvoid.length > 0) {
    console.log(`\n  ${bold('must-avoid')}    (${a.mustAvoid.length})`);
    for (const ref of a.mustAvoid) console.log(`    ${red('✕')} ${ref}`);
  }
  // Domain-specific composition extras (any constraint fields a corpus
  // declares beyond the universal must-include / must-avoid pair).
  // Rendered generically so any domain's extras appear without hardcoding.
  const extras = Object.entries(a.compositionExtras);
  if (extras.length > 0) {
    for (const [field, val] of extras) {
      console.log(`\n  ${bold(field)}`);
      console.log(`    ${cyan('→')} ${val}`);
    }
  }

  // Related
  if (a.related.length > 0) {
    console.log(`\n  ${bold('related')}  (${a.related.length})`);
    for (const ref of a.related) console.log(`    ${gray('·')} ${ref}`);
  }

  // Compatible / conflicts
  if (a.compatible.length > 0) {
    console.log(`\n  ${bold('compatible')}  ${a.compatible.map(c => green(c)).join('  ')}`);
  }
  if (a.conflicts.length > 0) {
    console.log(`  ${bold('conflicts')}   ${a.conflicts.map(c => red(c)).join('  ')}`);
  }

  console.log();
}

// ─── helpers ────────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (current.length + w.length + 1 > width) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);
  return lines;
}
