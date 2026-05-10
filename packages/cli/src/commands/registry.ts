/**
 * registry.ts — Local atom registry for the Prime CLI.
 *
 * Provides helpers to:
 *   - resolve an @scope/name reference to an absolute file path
 *   - parse key metadata from a .prime source file
 *   - enumerate all atoms by scope
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Default sources directory.
 *
 * Resolution order:
 *   1. `PRIME_SOURCES` environment variable (absolute or relative to cwd)
 *   2. `./primes/sources` relative to the current working directory
 *
 * The latter is the convention used by `prime init` and the bundled
 * examples (`examples/<corpus>/primes/sources/...`). Override it with
 * `--dir` on any CLI command, or set `PRIME_SOURCES` once for a session.
 */
export const DEFAULT_SOURCES_DIR =
  process.env.PRIME_SOURCES
    ? resolve(process.env.PRIME_SOURCES)
    : resolve(process.cwd(), 'primes/sources');

// ────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────

export interface AtomMeta {
  id: string;        // @scope/name
  scope: string;     // @community
  name: string;      // persona-stripe
  filePath: string;
  version: string;
  kind: string;      // fact | rule | pattern | step | … (any of the 28 kinds)
  description: string;
  mustInclude: string[];
  mustAvoid: string[];
  related: string[];
  compatible: string[];
  conflicts: string[];
  /**
   * Opaque bag for any domain-specific composition extras parsed from the
   * atom's `composition:` block that don't map to the universal fields above.
   * Keys are field names (e.g. "motion-prescriptions", "typography-required");
   * values are the raw parsed string content.
   *
   * Frontend tooling reads its own keys here; a security corpus reads its own.
   * The CLI and protocol layer treat this as opaque.
   */
  compositionExtras: Record<string, string>;
}

// ────────────────────────────────────────────────────────
// Resolve: @scope/name → absolute path
// ────────────────────────────────────────────────────────

export function resolveAtomPath(
  id: string,
  sourcesDir: string = DEFAULT_SOURCES_DIR
): string | null {
  // Strip leading @ and split
  const clean = id.startsWith('@') ? id.slice(1) : id;
  const slashIdx = clean.indexOf('/');
  if (slashIdx === -1) return null;

  const scope = '@' + clean.slice(0, slashIdx);
  const atomName = clean.slice(slashIdx + 1);
  const candidate = join(sourcesDir, scope, `${atomName}.prime`);
  return existsSync(candidate) ? candidate : null;
}

// ────────────────────────────────────────────────────────
// Parse a .prime source file into AtomMeta
// ────────────────────────────────────────────────────────

export function parseAtom(src: string, filePath: string, id: string): AtomMeta {
  const clean = id.startsWith('@') ? id.slice(1) : id;
  const slashIdx = clean.indexOf('/');
  const scope = slashIdx !== -1 ? '@' + clean.slice(0, slashIdx) : '@unknown';
  const name = slashIdx !== -1 ? clean.slice(slashIdx + 1) : clean;

  // kind: first token on first non-empty line (e.g. "persona Stripe {")
  const kindMatch = src.match(/^\s*([a-z][\w-]*)\s+\w/m);
  const kind = kindMatch ? kindMatch[1] : 'atom';

  const version = extractField(src, 'version') ?? '0.0.0';
  const description = extractField(src, 'description') ?? '';

  // composition.must-include / must-avoid
  const mustInclude = extractRefList(src, 'must-include');
  const mustAvoid = extractRefList(src, 'must-avoid');

  // related: [ @a/b, @c/d, … ]
  const related = extractRefList(src, 'related');

  // compatible: ["a", "b"] — may be strings not @refs
  const compatible = extractStringList(src, 'compatible');
  const conflicts = extractStringList(src, 'conflicts');

  // Collect any remaining domain-specific composition block fields into
  // compositionExtras so they are preserved without polluting the universal
  // AtomMeta surface.  We scan for known domain-specific field names.
  // Frontend tooling can read compositionExtras["motion-prescriptions"],
  // compositionExtras["typography-required"], etc.  New domains add their
  // own keys here without touching AtomMeta.
  const compositionExtras: Record<string, string> = {};
  const knownExtraFields = [
    'motion-prescriptions',
    'typography-required',
    'color-required',
  ];
  for (const field of knownExtraFields) {
    const val = extractField(src, field);
    if (val !== null) compositionExtras[field] = val;
    // Also try ref-list form
    const refs = extractRefList(src, field);
    if (refs.length > 0) compositionExtras[field] = refs.join(', ');
  }

  return {
    id,
    scope,
    name,
    filePath,
    version,
    kind,
    description,
    mustInclude,
    mustAvoid,
    related,
    compatible,
    conflicts,
    compositionExtras,
  };
}

// ────────────────────────────────────────────────────────
// List all scopes and atoms in sourcesDir
// ────────────────────────────────────────────────────────

export interface ScopeEntry {
  scope: string;
  atoms: string[];  // bare names without .prime
}

export function listAllScopes(sourcesDir: string = DEFAULT_SOURCES_DIR): ScopeEntry[] {
  if (!existsSync(sourcesDir)) return [];
  return readdirSync(sourcesDir)
    .filter(d => d.startsWith('@'))
    .sort()
    .map(scope => ({
      scope,
      atoms: readdirSync(join(sourcesDir, scope))
        .filter(f => f.endsWith('.prime'))
        .map(f => f.replace(/\.prime$/, ''))
        .sort(),
    }));
}

// ────────────────────────────────────────────────────────
// Load a single atom from id
// ────────────────────────────────────────────────────────

export function loadAtom(
  id: string,
  sourcesDir: string = DEFAULT_SOURCES_DIR
): AtomMeta | null {
  const filePath = resolveAtomPath(id, sourcesDir);
  if (!filePath) return null;
  const src = readFileSync(filePath, 'utf-8');
  return parseAtom(src, filePath, id);
}

// ────────────────────────────────────────────────────────
// Internal parse helpers
// ────────────────────────────────────────────────────────

/** Extract a quoted scalar field: `key: "value"` */
function extractField(src: string, key: string): string | null {
  const re = new RegExp(`\\b${key}:\\s*"([^"]+)"`, 'm');
  return src.match(re)?.[1] ?? null;
}

/**
 * Extract a list of @scope/name references from a named block.
 * Handles both bracket lists and bare refs on separate lines.
 *
 * Examples matched:
 *   must-include: [ @a/b, @c/d, ]
 *   related: [\n  @a/b,\n  @c/d,\n]
 */
function extractRefList(src: string, key: string): string[] {
  const re = new RegExp(`\\b${key}:\\s*\\[([^\\]]+)\\]`, 's');
  const m = src.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/@[\w-]+\/[\w-]+/g)].map(r => r[0]);
}

/**
 * Extract a list of quoted strings from a named array field.
 * compatible: ["a", "b"]
 */
function extractStringList(src: string, key: string): string[] {
  const re = new RegExp(`\\b${key}:\\s*\\[([^\\]]+)\\]`, 's');
  const m = src.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map(r => r[1]);
}
