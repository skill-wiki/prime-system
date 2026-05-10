/**
 * prime list [--scope @community] — Show all atoms in the local registry by scope.
 *
 * Options:
 *   --scope <@scope>   Only show atoms from this scope
 *   --dir   <path>     Override default sources directory
 *   --json             Output JSON instead of formatted table
 */

import { header, bold, cyan, green, yellow, magenta, gray } from '../utils/display';
import { listAllScopes, DEFAULT_SOURCES_DIR } from './registry';

// Kind → colour mapping
const KIND_COLOR: Record<string, (s: string) => string> = {
  persona:       magenta,
  pattern:       cyan,
  template:      green,
  check:         yellow,
  rule:          yellow,
  constraint:    yellow,
  principle:     cyan,
  fact:          green,
  'anti-pattern': (s) => `\x1b[31m${s}\x1b[0m`, // red
};

function colorKind(kind: string): string {
  const fn = KIND_COLOR[kind];
  return fn ? fn(kind) : gray(kind);
}

/** Infer kind from atom name when kind detection from source would be costly */
function inferKindFromName(name: string): string {
  for (const k of Object.keys(KIND_COLOR)) {
    if (name.startsWith(k)) return k;
  }
  return 'atom';
}

export async function listCommand(args: string[]): Promise<void> {
  let filterScope: string | undefined;
  let sourcesDir = DEFAULT_SOURCES_DIR;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scope' && args[i + 1]) filterScope = args[++i];
    else if (args[i] === '--dir' && args[i + 1]) sourcesDir = args[++i];
    else if (args[i] === '--json') jsonMode = true;
    else if (args[i] && !args[i].startsWith('-')) {
      // positional: treat as scope if starts with @
      if (args[i].startsWith('@')) filterScope = args[i];
    }
  }

  const scopes = listAllScopes(sourcesDir);
  if (scopes.length === 0) {
    console.error(`No atoms found in: ${sourcesDir}`);
    process.exit(1);
  }

  const filtered = filterScope
    ? scopes.filter(s => s.scope === filterScope)
    : scopes;

  if (filtered.length === 0) {
    console.error(`Scope '${filterScope}' not found.`);
    process.exit(1);
  }

  if (jsonMode) {
    const out: Record<string, string[]> = {};
    for (const { scope, atoms } of filtered) {
      out[scope] = atoms.map(a => `${scope}/${a}`);
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const total = filtered.reduce((n, s) => n + s.atoms.length, 0);
  header(`Prime Registry — ${total} atoms across ${filtered.length} scope(s)`);

  for (const { scope, atoms } of filtered) {
    console.log(`\n  ${bold(scope)}  ${gray(`(${atoms.length} atoms)`)}`);
    console.log(`  ${'─'.repeat(50)}`);

    for (const name of atoms) {
      const kind = inferKindFromName(name);
      const kindStr = colorKind(kind).padEnd(18 + (colorKind(kind).length - kind.length));
      console.log(`  ${gray('·')} ${kindStr}  ${scope}/${name}`);
    }
  }

  console.log(`\n  ${gray(`Sources: ${sourcesDir}`)}`);
}
