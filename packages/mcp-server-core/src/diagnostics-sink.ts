/**
 * `diagnostics.json` — the §8.3 CorpusBundle diagnostics artifact.
 *
 * Before this module the graph diagnostics produced by `buildCorpusGraph` were
 * written to stderr only (`index.ts`, the `stderr.error` loop). A warning that
 * exists solely in a server's stderr is not an artifact: it cannot be diffed
 * between releases, cannot gate a publish, and disappears with the process. The
 * §8.3 bundle layout lists `diagnostics.json` for exactly this reason.
 *
 * §8.3 names the file but does not fix its shape, so the shape here is the
 * `DiagnosticIR` list the engine already produces, plus a `dangling` section
 * that carries the CLASSIFICATION of every dropped edge.
 *
 * Why classification and not just a count: `CORPUS_EDGE_DANGLING` collapses
 * four materially different defects into one warning, and the remedy differs
 * per class. Measured on `compiled-v3-final` (899 units, 898 active, 5010
 * `atom.yaml` edges, 160 dropped):
 *
 *   53  target-deprecated-superseded   target IS in the bundle but is deprecated
 *                                      with a `superseded_by`; the inbound edges
 *                                      were never retargeted to the successor.
 *                                      All 53 point at one unit
 *                                      (`@community/anti-pattern-generic-saas-blue`
 *                                      -> `@community/anti-pattern-ai-slop-aesthetics`).
 *                                      Mechanically retargetable; NOT missing data.
 *   52  unresolved-style-token         target is a bare aesthetic token
 *                                      (`warm`, `quiet-luxury`, `neon-dark`, ...)
 *                                      not a `@ns/id` ref. The source dialect
 *                                      writes `compatible: ["notion-warm"]` as
 *                                      strings; the emitter resolves a token to
 *                                      `@impeccable/persona-<token>` when such a
 *                                      unit exists and otherwise emits the raw
 *                                      token as a `target:`. 39 distinct tokens
 *                                      name no unit. Emitter defect: partial
 *                                      resolution falling through silently.
 *   46  target-absent-everywhere       well-formed `@ns/id` ref whose target is in
 *                                      no source tree at all (29 distinct). This
 *                                      is the honest "cannot prove where it went"
 *                                      class and belongs with L12-C `unmapped`.
 *    9  target-in-migrated-not-bundled target exists in
 *                                      `packages/compiler/fixtures/migrated`
 *                                      but was not carried into the bundle
 *                                      (3 distinct). Recoverable.
 *
 * Emitting the class is what makes a dropped edge auditable rather than merely
 * logged: the counts are a publish gate input, and the per-edge records are the
 * work list. Nothing here repairs an edge — repair belongs to the emitter and to
 * the corpus source, and doing it silently at load time would hide the defect
 * again.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import type { DiagnosticIR } from "@skill-wiki/ir";

/** How a dropped edge should be remedied. Ordered most to least mechanical. */
export type DanglingClass =
  | "target-deprecated-superseded"
  | "unresolved-style-token"
  | "target-in-migrated-not-bundled"
  | "target-absent-everywhere";

/** One dropped edge, with the evidence that placed it in its class. */
export interface DanglingRecord {
  readonly from: string;
  readonly relation: string;
  readonly to: string;
  readonly classification: DanglingClass;
  /** Set only for `target-deprecated-superseded`: the retarget destination. */
  readonly supersededBy?: string;
}

/** The `diagnostics.json` document. */
export interface BundleDiagnosticsDocument {
  readonly corpus: string;
  readonly release: string;
  /** Digest of the bundle the diagnostics describe, so a stale file is detectable. */
  readonly contentDigest: string;
  readonly generatedAt: string;
  readonly counts: {
    readonly total: number;
    readonly error: number;
    readonly warning: number;
    readonly info: number;
  };
  readonly diagnostics: readonly DiagnosticIR[];
  readonly dangling: {
    readonly total: number;
    /** Edge count per class; keys are absent when the class is empty. */
    readonly byClassification: Readonly<Record<string, number>>;
    readonly records: readonly DanglingRecord[];
  };
}

/** `<from> -[<relation>]-> <to>: ...` — the shape `buildCorpusGraph` emits. */
const DANGLING_MESSAGE = /^(\S+) -\[([\w-]+)\]-> (\S+):/;

/**
 * Recover the edge triple from a `CORPUS_EDGE_DANGLING` message.
 *
 * Parsing a message we also format is not ideal, but the alternative is
 * widening `DiagnosticIR` (consumed well beyond this bundle) with fields only
 * this artifact reads. Returns undefined rather than throwing so one
 * unparseable message cannot cost the whole artifact.
 */
export function parseDanglingMessage(
  message: string
): { from: string; relation: string; to: string } | undefined {
  const m = DANGLING_MESSAGE.exec(message);
  return m ? { from: m[1]!, relation: m[2]!, to: m[3]! } : undefined;
}

/** Inputs the classifier needs about the bundle and the source trees. */
export interface ClassifyContext {
  /** unit id -> `superseded_by`, for every unit the index marks deprecated. */
  readonly deprecated: ReadonlyMap<string, string | undefined>;
  /** Unit ids present as corpus sources. */
  readonly sourceIds: ReadonlySet<string>;
  /** Bare leaf names present in the migrated fixture tree. */
  readonly migratedLeaves: ReadonlySet<string>;
}

/**
 * Place one dropped edge in a class.
 *
 * Order matters: a bare token can never be a unit id, and a deprecated target
 * is present-but-inactive rather than absent, so both are decided before the
 * source trees are consulted.
 */
export function classifyDangling(to: string, context: ClassifyContext): DanglingClass {
  if (!to.startsWith("@")) return "unresolved-style-token";
  if (context.deprecated.has(to)) return "target-deprecated-superseded";
  if (context.sourceIds.has(to)) return "target-in-migrated-not-bundled";
  const leaf = to.slice(to.indexOf("/") + 1);
  if (context.migratedLeaves.has(leaf)) return "target-in-migrated-not-bundled";
  return "target-absent-everywhere";
}

/** Build the document without writing it, so callers can assert on it. */
export function buildDiagnosticsDocument(input: {
  readonly corpus: string;
  readonly release: string;
  readonly contentDigest: string;
  readonly diagnostics: readonly DiagnosticIR[];
  readonly classify: (to: string) => DanglingClass;
  readonly supersededBy?: (to: string) => string | undefined;
  readonly now?: () => Date;
}): BundleDiagnosticsDocument {
  const records: DanglingRecord[] = [];
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.code !== "CORPUS_EDGE_DANGLING") continue;
    const edge = parseDanglingMessage(diagnostic.message);
    if (!edge) continue;
    const classification = input.classify(edge.to);
    const supersededBy = input.supersededBy?.(edge.to);
    records.push({
      from: edge.from,
      relation: edge.relation,
      to: edge.to,
      classification,
      ...(supersededBy ? { supersededBy } : {}),
    });
  }

  const byClassification: Record<string, number> = {};
  for (const record of records) {
    byClassification[record.classification] = (byClassification[record.classification] ?? 0) + 1;
  }

  const counts = { total: input.diagnostics.length, error: 0, warning: 0, info: 0 };
  for (const diagnostic of input.diagnostics) counts[diagnostic.severity]++;

  return {
    corpus: input.corpus,
    release: input.release,
    contentDigest: input.contentDigest,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    counts,
    diagnostics: input.diagnostics,
    dangling: { total: records.length, byClassification, records },
  };
}

/** Bundle-relative name of the artifact (§8.3). */
export const DIAGNOSTICS_FILE = "diagnostics.json";

/**
 * Write `diagnostics.json` into a bundle directory.
 *
 * Returns the path written. Trailing newline so the file is diffable, and keys
 * are emitted in a stable order by construction so two runs over an unchanged
 * bundle differ only in `generatedAt`.
 */
export function writeDiagnosticsDocument(
  bundleRoot: string,
  document: BundleDiagnosticsDocument
): string {
  const path = join(bundleRoot, DIAGNOSTICS_FILE);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
  return path;
}
