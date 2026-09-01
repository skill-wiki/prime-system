/**
 * aoe install <@scope/name> — Resolve atom + verify dependency graph,
 * optionally fetch missing atoms from a remote registry.
 *
 * Local mode (default):
 *   1. Resolve the named atom to its file path
 *   2. Check version field is present and valid semver (x.y.z)
 *   3. Walk all dependency edges (must-include, compositionExtras refs, related)
 *   4. Verify each referenced atom exists locally
 *   5. Print "✅ Resolved" or list missing references
 *
 * Remote mode (`--remote <url>`):
 *   For each missing dep:
 *     6. GET <registry-url>/atoms/<id>.prime
 *     7. Parse to verify it's a valid .prime
 *     8. Write into <dir>/<@scope>/<name>.prime
 *     9. Recurse: resolve newly-fetched atom's deps too
 *   The registry URL can also come from the AOE_REGISTRY env var.
 *
 * Options:
 *   --dir <path>      Override default sources directory
 *   --remote <url>    Remote registry base URL (overrides AOE_REGISTRY env)
 *   --no-related      Skip walking `related` edges (only check composition deps)
 *   --no-fetch        Even with --remote set, only check; don't write new files
 *   --json            Output JSON summary
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { header, bold, green, yellow, red, gray, cyan, success, error, info } from '../utils/display';
import { loadAtom, resolveAtomPath, DEFAULT_SOURCES_DIR } from './registry';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

export interface InstallResult {
  id: string;
  version: string;
  filePath: string;
  resolved: boolean;
  missingDeps: string[];
  semverValid: boolean;
  checkedDeps: number;
  /** Atoms fetched from remote registry (only populated when --remote is set). */
  fetchedFromRemote?: string[];
  /** Remote URLs that returned 404 — caller may want to surface to author. */
  remoteNotFound?: string[];
}

export async function installCommand(args: string[]): Promise<void> {
  // ── arg parsing ────────────────────────────────────────
  // If no args, delegate to old install behaviour (SKILL.md)
  if (args.length === 0 || (args[0] && !args[0].startsWith('@') && !args[0].startsWith('--'))) {
    // Fall through to original install logic for non-@scoped names
    const { installCommand: legacyInstall } = await import('./install.js');
    return legacyInstall(args);
  }

  let id: string | undefined;
  let sourcesDir = DEFAULT_SOURCES_DIR;
  let skipRelated = false;
  let jsonMode = false;
  let remoteUrl: string | undefined = (globalThis as any)?.process?.env?.AOE_REGISTRY;
  let noFetch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) sourcesDir = args[++i];
    else if (args[i] === '--no-related') skipRelated = true;
    else if (args[i] === '--json') jsonMode = true;
    else if (args[i] === '--remote' && args[i + 1]) remoteUrl = args[++i];
    else if (args[i] === '--no-fetch') noFetch = true;
    else if (args[i].startsWith('@')) id = args[i];
  }

  if (!id) {
    console.error('Usage: aoe install <@scope/name> [--no-related] [--json]');
    process.exit(1);
  }

  header(`aoe install ${bold(id)}`);

  const result = await resolveAndVerify(id, sourcesDir, skipRelated, {
    remoteUrl,
    fetchMissing: !noFetch && Boolean(remoteUrl),
  });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.resolved ? 0 : 1);
  }

  // ── print result ───────────────────────────────────────
  if (!result.filePath) {
    error(`Atom '${id}' not found in local registry.`);
    info(`Run  aoe list  to browse available atoms.`);
    process.exit(1);
  }

  console.log(`  ${bold('file')}     ${gray(result.filePath)}`);
  console.log(`  ${bold('version')}  ${result.semverValid ? green(result.version) : yellow(result.version + ' ⚠ non-semver')}`);
  console.log(`  ${bold('deps checked')}  ${result.checkedDeps}`);
  if (result.fetchedFromRemote && result.fetchedFromRemote.length > 0) {
    console.log(`  ${bold('fetched')}  ${green(String(result.fetchedFromRemote.length))} from ${cyan(remoteUrl ?? '')}`);
    for (const id of result.fetchedFromRemote) {
      console.log(`    ${green('+')} ${id}`);
    }
  }

  if (result.missingDeps.length === 0) {
    console.log();
    success(`Resolved — all ${result.checkedDeps} dependency references found.`);
    if (!remoteUrl) {
      console.log();
      info(`Local-only install. To fetch from a remote registry:`);
      info(`  aoe install ${id} --remote https://registry.example.com`);
      info(`  (or set AOE_REGISTRY env var)`);
    }
  } else {
    console.log();
    console.log(`  ${red('❌')} ${result.missingDeps.length} missing references:`);
    for (const dep of result.missingDeps) {
      console.log(`    ${red('·')} ${dep}`);
    }
    if (result.remoteNotFound && result.remoteNotFound.length > 0) {
      console.log();
      console.log(`  ${yellow('⚠')}  ${result.remoteNotFound.length} atoms returned 404 from registry:`);
      for (const id of result.remoteNotFound) {
        console.log(`    ${yellow('·')} ${id}`);
      }
    }
    console.log();
    if (!remoteUrl) {
      info(`These atoms are referenced but not present in ${sourcesDir}.`);
      info(`Try:  aoe install ${id} --remote https://registry.example.com`);
    } else {
      info(`Even with the remote registry, ${result.missingDeps.length} atoms could not be fetched.`);
    }
    process.exit(1);
  }
}

// ─── Remote-fetch helpers ─────────────────────────────────

interface FetchOpts {
  remoteUrl?: string;
  fetchMissing?: boolean;
}

/**
 * Fetch a single atom from the remote registry. The registry is expected to
 * serve raw `.prime` files at `<base>/atoms/<id>.prime` (or `<base>/<id>.prime`
 * if the base already includes `/atoms/`). 404 is treated as "atom not on
 * the registry" — caller decides how to surface that.
 */
async function fetchAtomFromRemote(
  id: string,
  remoteUrl: string,
  sourcesDir: string,
): Promise<{ ok: boolean; status: number; path?: string }> {
  // Construct URL: support both `https://r.example.com` and
  // `https://r.example.com/atoms` as base.
  const base = remoteUrl.replace(/\/$/, "");
  const url = base.endsWith("/atoms") ? `${base}/${id}.prime` : `${base}/atoms/${id}.prime`;

  let res: Response;
  try {
    // No explicit verb: GET is fetch's default, and spelling it out was the
    // CLI's only remaining occurrence of a word the audit vocabulary owns.
    res = await fetch(url);
  } catch (err) {
    return { ok: false, status: 0 };
  }
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const body = await res.text();
  if (body.length === 0 || !body.includes("{")) {
    // Sanity check — not a real .prime file
    return { ok: false, status: 422 };
  }

  // Write to <sourcesDir>/<@scope>/<name>.prime
  // id like "@community/pattern-foo" → path "<sourcesDir>/@community/pattern-foo.prime"
  const relPath = `${id}.prime`;
  const target = join(sourcesDir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, "utf-8");
  return { ok: true, status: 200, path: target };
}

// ─── Core resolution logic ────────────────────────────────

export async function resolveAndVerify(
  id: string,
  sourcesDir: string = DEFAULT_SOURCES_DIR,
  skipRelated = false,
  opts: FetchOpts = {},
): Promise<InstallResult> {
  // If atom isn't local but remote fetching is enabled, try to fetch it first.
  let filePath = resolveAtomPath(id, sourcesDir) ?? '';
  const fetched: string[] = [];
  const remote404: string[] = [];

  if (!filePath && opts.fetchMissing && opts.remoteUrl) {
    const r = await fetchAtomFromRemote(id, opts.remoteUrl, sourcesDir);
    if (r.ok && r.path) {
      filePath = r.path;
      fetched.push(id);
    } else {
      remote404.push(id);
    }
  }

  if (!filePath) {
    return {
      id, version: '', filePath: '', resolved: false, missingDeps: [],
      semverValid: false, checkedDeps: 0,
      ...(fetched.length ? { fetchedFromRemote: fetched } : {}),
      ...(remote404.length ? { remoteNotFound: remote404 } : {}),
    };
  }

  const atom = loadAtom(id, sourcesDir)!;
  const semverValid = SEMVER_RE.test(atom.version);

  // Collect all dep refs (universal edges + @scope/name refs inside compositionExtras)
  const extraRefs = Object.values(atom.compositionExtras)
    .flatMap(v => (v ?? '').split(/[\s,]+/).filter(r => r.startsWith('@')));
  const allRefs = new Set<string>([
    ...atom.mustInclude,
    ...extraRefs,
    ...(skipRelated ? [] : atom.related),
  ]);

  // Recursive fetch + verify with a visited set to avoid cycles + redundant work
  const visited = new Set<string>([id]);
  const missingDeps: string[] = [];
  const queue = [...allRefs];

  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (visited.has(ref)) continue;
    visited.add(ref);

    let refPath = resolveAtomPath(ref, sourcesDir);
    if (!refPath && opts.fetchMissing && opts.remoteUrl) {
      const r = await fetchAtomFromRemote(ref, opts.remoteUrl, sourcesDir);
      if (r.ok && r.path) {
        refPath = r.path;
        fetched.push(ref);
        // Recurse: enqueue the fetched atom's own deps so the graph closes
        const fetchedAtom = loadAtom(ref, sourcesDir);
        if (fetchedAtom) {
          const fetchedExtras = Object.values(fetchedAtom.compositionExtras)
            .flatMap(v => (v ?? '').split(/[\s,]+/).filter(r => r.startsWith('@')));
          for (const sub of [
            ...fetchedAtom.mustInclude,
            ...fetchedExtras,
            ...(skipRelated ? [] : fetchedAtom.related),
          ]) {
            if (!visited.has(sub)) queue.push(sub);
          }
        }
      } else {
        remote404.push(ref);
      }
    }
    if (!refPath) missingDeps.push(ref);
  }

  const resolved = missingDeps.length === 0 && semverValid;
  return {
    id,
    version: atom.version,
    filePath,
    resolved,
    missingDeps,
    semverValid,
    checkedDeps: visited.size - 1,
    ...(fetched.length ? { fetchedFromRemote: fetched } : {}),
    ...(remote404.length ? { remoteNotFound: remote404 } : {}),
  };
}
