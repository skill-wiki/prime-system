#!/usr/bin/env bun
/**
 * Emit `diagnostics.json` (§8.3) for a compiled CorpusBundle.
 *
 *   bun packages/mcp-server-core/src/emit-diagnostics.ts <bundleRoot> [--sources <dir>] [--migrated <dir>]
 *
 * This is a bundle post-pass rather than a step inside the compiler because the
 * bundle in production (`compiled-v3-final`) was NOT produced by the compiler
 * now in the tree: its per-unit `graph.yaml` uses an `atom:`/`relations:` shape,
 * while `compiler/src/generic-unit.ts` writes an `edges:` shape. Regenerating
 * the bundle to obtain one file would therefore change the bundle's layout and
 * digests, which is a far larger blast radius than the missing artifact.
 *
 * The classifier needs the source trees to tell "absent everywhere" from
 * "exists but was not carried in", so both are inputs; when a tree is not
 * supplied every ref that would have matched it degrades to
 * `target-absent-everywhere`, which over-reports the honest-unknown class rather
 * than under-reporting it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { loadCorpusSnapshot, loadIndex, loadAtomMeta } from "@aoe/runtime";
import { buildCorpusGraph } from "./corpus-graph";
import {
  buildDiagnosticsDocument,
  classifyDangling,
  writeDiagnosticsDocument,
  type ClassifyContext,
} from "./diagnostics-sink";

/**
 * Read `deprecated_at` / `superseded_by` straight out of `_index.xml`.
 *
 * `loadIndex` routes a deprecated atom into its own bucket and drops it from
 * `atoms`, which is precisely why its inbound edges dangle — so the deprecation
 * table has to come from the raw index, not from the parsed one.
 */
function readDeprecated(bundleRoot: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const path = join(bundleRoot, "_index.xml");
  if (!existsSync(path)) return out;
  const xml = readFileSync(path, "utf-8");
  const atomRe = /<atom\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = atomRe.exec(xml)) !== null) {
    const attrs = match[1]!;
    if (!/\bdeprecated_at=/.test(attrs)) continue;
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
    if (!id) continue;
    out.set(id, /\bsuperseded_by="([^"]*)"/.exec(attrs)?.[1]);
  }
  return out;
}

/** `@ns/leaf` ids for every `.prime` file directly under `<dir>/@ns/`. */
function readSourceIds(dir: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!dir || !existsSync(dir)) return out;
  for (const ns of readdirSync(dir)) {
    if (!ns.startsWith("@")) continue;
    const nsDir = join(dir, ns);
    if (!statSync(nsDir).isDirectory()) continue;
    for (const file of readdirSync(nsDir)) {
      if (file.endsWith(".prime")) out.add(`${ns}/${file.slice(0, -".prime".length)}`);
    }
  }
  return out;
}

/** Bare leaf names of every `.prime` anywhere under `<dir>`, recursively. */
function readMigratedLeaves(dir: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!dir || !existsSync(dir)) return out;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".prime")) out.add(basename(entry, ".prime"));
    }
  };
  walk(dir);
  return out;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function emitBundleDiagnostics(options: {
  readonly bundleRoot: string;
  readonly sourcesDir?: string;
  readonly migratedDir?: string;
  readonly now?: () => Date;
}): { path: string; total: number; byClassification: Readonly<Record<string, number>> } {
  const { bundleRoot } = options;
  const loaded = loadCorpusSnapshot(bundleRoot);
  const index = loadIndex(bundleRoot);
  const graph = buildCorpusGraph({
    atoms: index.atoms,
    loadMeta: (id) => loadAtomMeta(bundleRoot, id),
    snapshot: {
      modelRelease: loaded.snapshot.release,
      modelDigest: loaded.snapshot.schemaDigest,
      corpusRelease: loaded.snapshot.release,
      corpusDigest: loaded.snapshot.contentDigest,
    },
    corpus: loaded.snapshot.corpus,
  });

  const deprecated = readDeprecated(bundleRoot);
  const context: ClassifyContext = {
    deprecated,
    sourceIds: readSourceIds(options.sourcesDir),
    migratedLeaves: readMigratedLeaves(options.migratedDir),
  };

  const document = buildDiagnosticsDocument({
    corpus: loaded.snapshot.corpus,
    release: loaded.snapshot.release,
    contentDigest: loaded.snapshot.contentDigest,
    diagnostics: graph.graph.diagnostics,
    classify: (to) => classifyDangling(to, context),
    supersededBy: (to) => deprecated.get(to),
    ...(options.now ? { now: options.now } : {}),
  });

  const path = writeDiagnosticsDocument(bundleRoot, document);
  return { path, total: document.dangling.total, byClassification: document.dangling.byClassification };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const bundleRoot = argv[0];
  if (!bundleRoot) {
    console.error("usage: emit-diagnostics <bundleRoot> [--sources <dir>] [--migrated <dir>]");
    process.exit(2);
  }
  const result = emitBundleDiagnostics({
    bundleRoot,
    ...(flag(argv, "--sources") ? { sourcesDir: flag(argv, "--sources")! } : {}),
    ...(flag(argv, "--migrated") ? { migratedDir: flag(argv, "--migrated")! } : {}),
  });
  console.error(`[emit-diagnostics] wrote ${result.path}`);
  console.error(`[emit-diagnostics] dangling ${result.total}:`, result.byClassification);
}
