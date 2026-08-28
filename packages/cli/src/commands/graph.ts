/**
 * prime graph <file.prime> — Visualize the relation graph a unit declares.
 *
 * Every relation verb is rendered the same way. The previous version carried six
 * hardcoded verb regexes plus, per verb, a `required: true|false` flag and a
 * special ✕/red rendering for one of them. Architecture §3.1 names exactly those
 * judgements as things the engine must not hold: whether a relation is mandatory
 * and whether it blocks a composition are declared in the Model Package's
 * relation semantics (traversal/selection/conflictSeverity), so a CLI that paints
 * them from a local table is asserting a domain fact it has no authority over —
 * and gets it wrong for every corpus that is not prime-v1.
 */

import { resolve, basename } from 'path';
import { header, bold, gray, yellow } from '../utils/display';
import { readFile, fileExists } from '../utils/fs';
import { extractRelations, extractKind } from '../utils/relations';
import { paintFor } from '../utils/kind-color';

export async function graphCommand(args: string[]) {
  const file = args[0];
  if (!file) {
    console.error('Usage: prime graph <file.prime>');
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!fileExists(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  header(`Relation Graph: ${basename(filePath)}`);

  const source = await readFile(filePath);
  const { relations, parseErrors } = extractRelations(source, basename(filePath));
  const kind = extractKind(source, basename(filePath)) ?? '';
  const name = source.match(/name:\s*"([^"]+)"/)?.[1] || basename(file, '.prime');

  if (parseErrors.length > 0) {
    // Surfaced rather than swallowed: an empty graph caused by a syntax error is
    // indistinguishable from a unit that declares no relations otherwise.
    for (const message of parseErrors) console.log(`  ${yellow('⚠️')} ${message}`);
    console.log();
  }

  console.log();
  console.log(`  ${drawBox(name, paintFor(kind))}`);

  if (relations.length === 0) {
    console.log(gray('  (no relations declared)'));
    return;
  }

  const verbWidth = Math.max(...relations.map((r) => r.verb.length));
  for (let i = 0; i < relations.length; i++) {
    const rel = relations[i]!;
    const connector = i === relations.length - 1 ? '└' : '├';
    console.log(`  ${connector}── ${bold(rel.verb.padEnd(verbWidth))} ──→ ${bold(rel.target)}`);
  }

  console.log();
  console.log(gray(`  ${relations.length} relation(s). Traversal and conflict semantics are declared by the model package, not shown here.`));
}

function drawBox(text: string, colorFn: (s: string) => string): string {
  const width = text.length + 4;
  const top = '┌' + '─'.repeat(width) + '┐';
  const mid = '│  ' + colorFn(bold(text)) + '  │';
  const bot = '└' + '─'.repeat(width) + '┘';
  return `${top}\n  ${mid}\n  ${bot}`;
}
