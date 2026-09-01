/**
 * Conformance for a COMPILED bundle directory, as opposed to a source corpus.
 *
 * `corpus` / `corpus-v1` both read inputs: a declaration, or a `.prime` tree run
 * through the v1 adapter. Nothing read the artifact that is actually published.
 * That gap is not cosmetic — the two disagree in ways only the artifact can
 * show: `_index.xml` can advertise a different unit count than the directory
 * holds, a projection path recorded in `atom.yaml` can point at a chunk the
 * emitter never wrote, and a relation target can survive into the bundle after
 * its unit failed to compile. A source suite passes in all three cases.
 *
 * Nothing here parses `.prime` or invokes the compiler; nothing here knows a
 * domain word. Unit kinds, relation types and projection level names are read
 * out of the artifact, never listed in this file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { NAMESPACE } from "@skill-wiki/corpus-schema";
import {
  CORPUS_INDEX_FILE, CORPUS_MANIFEST_FILE, PrimeBundleError, loadCorpusSnapshot, verifyCorpusSignature,
  type LoadedCorpusSnapshot,
} from "@skill-wiki/runtime";
import { check, finding, report, skipped, type CheckOutcome, type Finding, type SuiteReport } from "./diagnostics.ts";

/** The per-unit artifact every emitted unit directory carries. */
const UNIT_FILE = "atom.yaml";

export interface BundleConformanceOptions {
  /**
   * License identifiers a published unit may declare. Supplied by the caller:
   * the protocol has no license policy of its own, so an empty list means the
   * check reports presence only and a non-empty list also enforces membership.
   */
  readonly allowedLicenses?: readonly string[];
  /** Key in a unit's artifact that carries its license. Defaults to `license`. */
  readonly licenseField?: string;
  /** Require a valid detached signature over the exact release manifest. */
  readonly requireSignature?: boolean;
}

interface BundleUnit {
  readonly id: string;
  /** Bundle-root-relative directory, e.g. `@community/persona-airbnb`. */
  readonly dir: string;
  readonly document: Record<string, unknown>;
}

/** Every directory holding an `atom.yaml`, keyed by the id the artifact states. */
function readUnits(root: string): { units: readonly BundleUnit[]; findings: readonly Finding[] } {
  const units: BundleUnit[] = [];
  const findings: Finding[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (entry.name !== UNIT_FILE) continue;
      const rel = relative(root, dirname(absolute)).split(/[\\/]/).join("/");
      let document: unknown;
      try { document = parseYaml(readFileSync(absolute, "utf8")); } catch (cause) {
        findings.push(finding("BUNDLE_UNIT_UNPARSEABLE", `Unit artifact is not readable YAML: ${String(cause)}`, "error", { path: rel }));
        continue;
      }
      if (document === null || typeof document !== "object" || Array.isArray(document)) {
        findings.push(finding("BUNDLE_UNIT_UNPARSEABLE", "Unit artifact is not a YAML mapping.", "error", { path: rel }));
        continue;
      }
      const record = document as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : undefined;
      if (id === undefined || id.trim() === "") {
        findings.push(finding("BUNDLE_UNIT_ID_MISSING", "Unit artifact declares no `id`, so nothing can reference it.", "error", { path: rel }));
        continue;
      }
      units.push({ id, dir: rel, document: record });
    }
  };
  visit(root);
  return { units, findings };
}

/** Atom ids the published index advertises, in document order. */
function indexAtomIds(indexXml: string): readonly string[] {
  return [...indexXml.matchAll(/<atom\b[^>]*\bid="([^"]+)"/g)].map(match => match[1] as string);
}

function declaredTotal(indexXml: string): number | undefined {
  const hit = /<prime_index\b[^>]*\btotal="(\d+)"/.exec(indexXml);
  return hit === undefined || hit === null ? undefined : Number(hit[1]);
}

/**
 * The manifest gate. Delegates to the production loader rather than re-reading
 * the manifest: a suite that validated the bundle with its own parser would pass
 * artifacts the thing that serves them rejects, which is the opposite of useful.
 */
function manifestCheck(root: string): { outcome: CheckOutcome; loaded?: LoadedCorpusSnapshot } {
  if (!existsSync(join(root, CORPUS_INDEX_FILE))) {
    return { outcome: check("BC-MANIFEST", "Bundle loads through the production loader", [
      finding("BUNDLE_INDEX_MISSING", `Bundle directory has no ${CORPUS_INDEX_FILE}.`, "error", { path: root }),
    ]) };
  }
  try {
    const loaded = loadCorpusSnapshot(root, { requireManifest: true });
    const findings = loaded.diagnostics.map(d => finding(d.code, d.message, d.severity, { path: root }));
    return { outcome: check("BC-MANIFEST", "Bundle loads through the production loader", findings), loaded };
  } catch (cause) {
    const code = cause instanceof PrimeBundleError ? cause.code : "BUNDLE_LOAD_FAILED";
    return { outcome: check("BC-MANIFEST", "Bundle loads through the production loader", [
      finding(code, cause instanceof Error ? cause.message : String(cause), "error", { path: root }),
    ]) };
  }
}

/**
 * The check that could not be put at the production entry.
 *
 * `manifest.corpus` is the corpus segment of every §11.3 `aoe://` URI, and
 * `loadCorpusSnapshot` accepts any non-empty string there — so a bundle whose
 * identity was derived from its output directory basename publishes a
 * machine-local name as corpus identity. Enforcing `NAMESPACE` inside the loader
 * rejects bundles that are checked in and depended on today, so the grammar is
 * enforced here, where a gate can require it of the bundles that are published
 * without taking every fixture bundle with it.
 */
function namespaceCheck(loaded: LoadedCorpusSnapshot | undefined): CheckOutcome {
  if (loaded === undefined) return skipped("BC-NAMESPACE", "Manifest corpus is a formal namespace", "bundle manifest did not load");
  const corpus = loaded.snapshot.corpus;
  return check("BC-NAMESPACE", "Manifest corpus is a formal namespace", NAMESPACE.test(corpus) ? [] : [
    finding("BUNDLE_CORPUS_NOT_NAMESPACE",
      `Manifest corpus "${corpus}" is not a formal namespace ("domain.tld/path"), so serving this bundle publishes a machine-local name in its aoe:// URIs.`,
      "error", { subject: corpus }),
  ]);
}

/** `_index.xml` and the unit directories must describe the same set. */
function indexParityCheck(root: string, units: readonly BundleUnit[]): CheckOutcome {
  const indexPath = join(root, CORPUS_INDEX_FILE);
  if (!existsSync(indexPath)) return skipped("BC-INDEX-PARITY", "Index and unit directories agree", `no ${CORPUS_INDEX_FILE}`);
  const xml = readFileSync(indexPath, "utf8");
  const advertised = new Set(indexAtomIds(xml));
  const present = new Set(units.map(u => u.id));
  const findings: Finding[] = [];
  for (const id of [...advertised].sort()) {
    if (!present.has(id)) findings.push(finding("BUNDLE_INDEX_ORPHAN", "Index advertises an atom with no unit directory in the bundle.", "error", { subject: id }));
  }
  for (const unit of [...units].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!advertised.has(unit.id)) findings.push(finding("BUNDLE_UNIT_UNINDEXED", "Unit directory is not advertised in the index, so retrieval cannot reach it.", "error", { subject: unit.id, path: unit.dir }));
  }
  const total = declaredTotal(xml);
  if (total !== undefined && total !== advertised.size) {
    findings.push(finding("BUNDLE_INDEX_TOTAL_MISMATCH", `Index declares total="${total}" but carries ${advertised.size} atom entries.`, "error", { path: CORPUS_INDEX_FILE }));
  }
  return check("BC-INDEX-PARITY", "Index and unit directories agree", findings);
}

/** Every projection a unit records must exist as a non-empty file. */
function projectionCheck(root: string, units: readonly BundleUnit[]): CheckOutcome {
  const findings: Finding[] = [];
  let recorded = 0;
  for (const unit of units) {
    const projection = unit.document.projection;
    if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
      findings.push(finding("BUNDLE_PROJECTION_ABSENT", "Unit records no projection map, so no rendered content can be served for it.", "error", { subject: unit.id, path: unit.dir }));
      continue;
    }
    for (const [level, value] of Object.entries(projection as Record<string, unknown>)) {
      if (typeof value !== "string" || value.trim() === "") {
        findings.push(finding("BUNDLE_PROJECTION_PATH_INVALID", `Projection "${level}" is not a path.`, "error", { subject: unit.id, path: unit.dir }));
        continue;
      }
      recorded += 1;
      const absolute = join(root, unit.dir, value);
      if (!existsSync(absolute)) {
        findings.push(finding("BUNDLE_PROJECTION_MISSING", `Projection "${level}" points at ${value}, which the bundle does not contain.`, "error", { subject: unit.id, path: join(unit.dir, value) }));
        continue;
      }
      if (statSync(absolute).size === 0) {
        findings.push(finding("BUNDLE_PROJECTION_EMPTY", `Projection "${level}" is an empty file.`, "error", { subject: unit.id, path: join(unit.dir, value) }));
      }
    }
  }
  return recorded === 0 && findings.length === 0
    ? skipped("BC-PROJECTIONS", "Recorded projections exist and carry bytes", "no unit records a projection")
    : check("BC-PROJECTIONS", "Recorded projections exist and carry bytes", findings);
}

/** A relation target that is not a unit in the bundle is unreachable at serve time. */
function relationTargetCheck(units: readonly BundleUnit[]): CheckOutcome {
  const present = new Set(units.map(u => u.id));
  const findings: Finding[] = [];
  let edges = 0;
  for (const unit of units) {
    const relations = unit.document.relations;
    if (!Array.isArray(relations)) continue;
    for (const edge of relations) {
      if (edge === null || typeof edge !== "object" || Array.isArray(edge)) continue;
      const record = edge as Record<string, unknown>;
      const target = record.target;
      const type = typeof record.type === "string" ? record.type : "?";
      if (typeof target !== "string" || target.trim() === "") {
        findings.push(finding("BUNDLE_RELATION_TARGET_INVALID", `Relation "${type}" records no target.`, "error", { subject: unit.id, path: unit.dir }));
        continue;
      }
      edges += 1;
      if (!present.has(target)) {
        findings.push(finding("BUNDLE_DANGLING_RELATION", `Relation "${type}" targets "${target}", which is not a unit in this bundle.`, "error", { subject: `${unit.id} -${type}-> ${target}` }));
      }
    }
  }
  return edges === 0 && findings.length === 0
    ? skipped("BC-RELATION-TARGETS", "Relation targets resolve inside the bundle", "no unit records a relation")
    : check("BC-RELATION-TARGETS", "Relation targets resolve inside the bundle", findings);
}

/**
 * Published units must say what they may be redistributed under.
 *
 * Presence is checked unconditionally; membership only when the caller supplies
 * a policy, because the protocol declares no license vocabulary of its own.
 */
function licenseCheck(units: readonly BundleUnit[], options: BundleConformanceOptions): CheckOutcome {
  const field = options.licenseField ?? "license";
  const allowed = options.allowedLicenses ?? [];
  const findings: Finding[] = [];
  for (const unit of units) {
    const declared = unit.document[field];
    if (typeof declared !== "string" || declared.trim() === "") {
      findings.push(finding("BUNDLE_LICENSE_MISSING", `Published unit declares no \`${field}\`, so its redistribution terms are unstated.`, "error", { subject: unit.id, path: unit.dir }));
      continue;
    }
    if (allowed.length > 0 && !allowed.includes(declared)) {
      findings.push(finding("BUNDLE_LICENSE_DENIED", `Unit declares license "${declared}", which the supplied policy does not allow.`, "error", { subject: unit.id, path: unit.dir }));
    }
  }
  return check("BC-LICENSE", "Published units declare redistribution terms", findings);
}

function signatureCheck(root: string, required: boolean): CheckOutcome {
  try {
    const signature = verifyCorpusSignature(root, { required });
    return signature === undefined
      ? skipped("BC-SIGNATURE", "Release manifest carries a valid detached signature", "signature policy is optional and no signature is present")
      : check("BC-SIGNATURE", "Release manifest carries a valid detached signature", []);
  } catch (cause) {
    return check("BC-SIGNATURE", "Release manifest carries a valid detached signature", [
      finding("BUNDLE_SIGNATURE_INVALID", cause instanceof Error ? cause.message : String(cause), "error", { path: root }),
    ]);
  }
}

/** Run every artifact-level check against one compiled bundle directory. */
export function runBundleConformance(bundleDir: string, options: BundleConformanceOptions = {}): SuiteReport {
  const root = resolve(bundleDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return report("bundle-conformance", basename(root), [
      check("BC-MANIFEST", "Bundle loads through the production loader", [
        finding("BUNDLE_ROOT_MISSING", "Bundle directory does not exist.", "error", { path: root }),
      ]),
    ]);
  }
  const { outcome: manifest, loaded } = manifestCheck(root);
  const { units, findings: unitFindings } = readUnits(root);
  const inventory = check("BC-UNIT-INVENTORY", "Every unit directory carries a readable, identified artifact", unitFindings);
  return report("bundle-conformance", loaded?.snapshot.corpus ?? basename(root), [
    manifest,
    namespaceCheck(loaded),
    inventory,
    indexParityCheck(root, units),
    projectionCheck(root, units),
    relationTargetCheck(units),
    licenseCheck(units, options),
    signatureCheck(root, options.requireSignature === true),
  ]);
}
