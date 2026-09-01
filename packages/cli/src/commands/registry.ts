/**
 * registry.ts — Local atom registry for the AOE CLI.
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
 *   1. `AOE_SOURCES` environment variable (absolute or relative to cwd)
 *   2. `./primes/sources` relative to the current working directory
 *
 * The latter is the convention used by `aoe init` and the bundled
 * examples (`examples/<corpus>/primes/sources/...`). Override it with
 * `--dir` on any CLI command, or set `AOE_SOURCES` once for a session.
 */
export const DEFAULT_SOURCES_DIR =
  process.env.AOE_SOURCES
    ? resolve(process.env.AOE_SOURCES)
    : resolve(process.cwd(), 'primes/sources');

// ────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────

export interface AtomMeta {
  id: string;        // @scope/name
  scope: string;     // @scope
  name: string;      // the bare unit name, as the file is named
  filePath: string;
  version: string;
  /**
   * The kind token as the source wrote it. Opaque here: which kinds exist, and
   * whether this one is legal, is decided by the Model Package, not the CLI.
   */
  kind: string;
  description: string;
  mustInclude: string[];
  mustAvoid: string[];
  related: string[];
  compatible: string[];
  conflicts: string[];
  /**
   * Opaque bag for any domain-specific composition extras parsed from the
   * atom's `composition:` block that don't map to the universal fields above.
   * Keys are field names (e.g. "x-prescriptions", "x-required-axes");
   * values are the raw parsed string content.
   *
   * Each corpus reads only its own keys here; the CLI never interprets them.
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

  // kind: first token on first non-empty line (e.g. "widget Stripe {")
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

  // Any composition field that is not one of the universal ones above is kept
  // verbatim. The previous version scanned a fixed list of three frontend field
  // names, which is the engine holding one domain's field ontology — §3.1 names
  // that axis explicitly as something the engine must not know. Enumerating the
  // block instead means a corpus from any domain keeps its extras with no edit.
  const compositionExtras = extractBlockExtras(src, 'composition', ['must-include', 'must-avoid']);

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

/**
 * Enumerate every `key: value` field inside a named block, minus the keys the
 * caller already models explicitly. No key is looked for by name, so a field
 * from a domain this build has never seen is preserved rather than dropped.
 *
 * Values stay raw strings: interpreting them is the domain's job, not the CLI's.
 */
function extractBlockExtras(
  src: string,
  blockKey: string,
  universalKeys: readonly string[],
): Record<string, string> {
  const open = src.match(new RegExp(`\\b${blockKey}:\\s*\\{`));
  if (open === null || open.index === undefined) return {};

  // Brace matching rather than a lazy regex: composition blocks nest.
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = open.index; i < src.length; i += 1) {
    if (src[i] === '{') { if (depth === 0) start = i + 1; depth += 1; }
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (start === -1 || end === -1) return {};

  const body = src.slice(start, end);
  const skip = new Set(universalKeys);
  const extras: Record<string, string> = {};

  // Top-level fields of the block only: a nested value is captured whole by its
  // own key, so inner keys must not become extras of their own.
  let nesting = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const keyMatch = nesting === 0 ? line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/) : null;
    if (keyMatch !== null) {
      const [, key, rest] = keyMatch as unknown as [string, string, string];
      if (!skip.has(key)) {
        const value = rest.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').trim();
        if (value.length > 0) extras[key] = value;
      }
    }
    nesting += (line.match(/[[{(]/g) ?? []).length - (line.match(/[\])}]/g) ?? []).length;
    if (nesting < 0) nesting = 0;
  }
  return extras;
}

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
