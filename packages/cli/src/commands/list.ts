/**
 * aoe list [--scope @community] — Show all atoms in the local registry by scope.
 *
 * Options:
 *   --scope <@scope>   Only show atoms from this scope
 *   --dir   <path>     Override default sources directory
 *   --json             Output JSON instead of formatted table
 */

import { header, bold, gray } from '../utils/display';
import { listAllScopes, loadAtom, DEFAULT_SOURCES_DIR } from './registry';
import { kindPadding } from '../utils/kind-color';

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
  header(`AOE Registry — ${total} units across ${filtered.length} scope(s)`);

  for (const { scope, atoms } of filtered) {
    console.log(`\n  ${bold(scope)}  ${gray(`(${atoms.length} atoms)`)}`);
    console.log(`  ${'─'.repeat(50)}`);

    for (const name of atoms) {
      // Read the kind the atom actually declares. The previous version guessed
      // it from a name prefix against a fixed kind list, which both hardcoded
      // the ontology and silently mislabelled any atom not named after its kind.
      const kind = loadAtom(`${scope}/${name}`, sourcesDir)?.kind ?? '';
      console.log(`  ${gray('·')} ${kindPadding(kind, 18)}  ${scope}/${name}`);
    }
  }

  console.log(`\n  ${gray(`Sources: ${sourcesDir}`)}`);
}
