/**
 * Loaders for the four corpus surfaces this repo actually contains.
 *
 * Deliberately tolerant parsers: `.prime` is a custom DSL with two mutually
 * incompatible dialects in-tree (see `docs/analysis/corpus-reconciliation/`),
 * and the legacy markdown corpus has 34 uncontrolled `domain` values. A strict
 * parse would abort on real data, so every loader records what it could not read
 * instead of throwing, and the counts are reported.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

export interface LegacyUnit {
  id: string;
  slug: string;
  ns: string;
  file: string;
  tree: "atoms" | "modules";
  name?: string;
  description?: string;
  type?: string;
  subtype?: string;
  domain?: string;
  status?: string;
  module?: string;
  claim?: string;
  rationale?: string;
  /**
   * Every other scalar prose field the document carried, keyed by its own field
   * name. Deliberately open: a reconciler must not hold a list of the prose
   * fields a corpus is allowed to have. Naming one here (`anti_pattern` was the
   * original offender) copies vocabulary the MODEL owns into engine source —
   * ZDS-CORE-VOCABULARY — and silently ignores any field the list forgot.
   * `legacyDigests` consumes this in sorted key order so the tier stays
   * reproducible.
   */
  prose: Record<string, string>;
  license?: string;
  sourceRepo?: string;
  sourceFile?: string;
  sourceSection?: string;
  sourceSkill?: string;
  sourceUrl?: string;
  extraProvenance: string[];
  deprecatedAt?: string | null;
  supersededBy?: string | null;
  mergedFrom: string[];
}

export interface MigratedUnit {
  name: string;
  file: string;
  base: string;
  module?: string;
  subtype?: string;
}

export interface V3Unit {
  id: string;
  slug: string;
  ns: string;
  kind: string;
  file: string;
  description?: string;
  statement?: string;
  claim?: string;
  label?: string;
  rationale?: string;
  domain?: string;
  contentHash?: string;
  sourceRepo?: string;
  sourceFile?: string;
  sourceSection?: string;
  urls: string[];
  related: string[];
}

export interface LoadReport {
  scanned: number;
  parsed: number;
  skipped: { file: string; reason: string }[];
}

function walk(dir: string, pred: (f: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, pred));
    else if (pred(e)) out.push(p);
  }
  return out.sort();
}

function frontmatter(raw: string): string | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  return raw.slice(raw.indexOf("\n") + 1, end + 1);
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Structural frontmatter keys: identity, classification, provenance and
 * lifecycle. Everything a document carries OUTSIDE this set and outside the
 * fields already lifted onto `LegacyUnit` is treated as prose and becomes a
 * digest candidate.
 *
 * This is an exclusion list of the RECONCILER's own vocabulary, not an
 * inclusion list of the corpus's. That direction matters: a corpus is free to
 * invent a prose field and it will be compared without a code change, while
 * naming its fields here would put model-owned vocabulary into engine source.
 *
 * For the same reason no model-declared TYPE name appears in this set. A
 * classification field like the one holding a unit's category is excluded by
 * SHAPE instead — `collectProse` keeps only multi-word values, and a
 * classification label is one word — so the reconciler never has to spell it.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "version",
  "name",
  "description",
  "claim",
  "rationale",
  "tags",
  "domain",
  "module",
  "activation",
  "priority",
  "severity",
  "status",
  "source",
  "sources",
  "provenance",
  "lifecycle",
  "relations",
  "projection",
  "quality",
  "visibility",
]);

/**
 * Every scalar prose field the document carries that the reconciler does not
 * already model, longest-lived first by sorted key so two runs agree.
 */
function collectProse(doc: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(doc).sort()) {
    if (STRUCTURAL_KEYS.has(key)) continue;
    const v = str(doc[key]);
    // A digest of two words is not evidence of shared ancestry; textDigest
    // applies its own floor, so only obvious non-prose is dropped here.
    if (v !== undefined && v.includes(" ")) out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------- legacy md

export function loadLegacy(root: string): { units: LegacyUnit[]; report: LoadReport } {
  const units: LegacyUnit[] = [];
  const report: LoadReport = { scanned: 0, parsed: 0, skipped: [] };

  for (const tree of ["atoms", "modules"] as const) {
    const files = walk(join(root, "primes", tree), (f) => f.endsWith(".md"));
    for (const file of files) {
      report.scanned += 1;
      const raw = readFileSync(file, "utf8");
      const fm = frontmatter(raw);
      if (!fm) {
        report.skipped.push({ file, reason: "no-frontmatter" });
        continue;
      }
      let doc: Record<string, unknown>;
      try {
        doc = (parseYaml(fm) ?? {}) as Record<string, unknown>;
      } catch (err) {
        report.skipped.push({ file, reason: `yaml-error: ${(err as Error).message.slice(0, 80)}` });
        continue;
      }
      const id = str(doc.id);
      if (!id) {
        report.skipped.push({ file, reason: "no-id" });
        continue;
      }
      const src = (doc.source ?? {}) as Record<string, unknown>;
      const srcList = Array.isArray(doc.sources) ? (doc.sources as Record<string, unknown>[]) : [];
      const life = (doc.lifecycle ?? {}) as Record<string, unknown>;
      const prov = (doc.provenance ?? {}) as Record<string, unknown>;
      const i = id.indexOf("/");

      units.push({
        id,
        slug: i === -1 ? id.replace(/^@/, "") : id.slice(i + 1),
        ns: /^@([^/]+)\//.exec(id)?.[1] ?? "",
        file,
        tree,
        name: str(doc.name),
        description: str(doc.description),
        type: str(doc.type),
        subtype: str(doc.subtype),
        domain: str(doc.domain),
        status: str(doc.status),
        module: str(doc.module),
        claim: str(doc.claim),
        rationale: str(doc.rationale),
        prose: collectProse(doc),
        license: str(src.license),
        sourceRepo: str(src.repo),
        sourceFile: str(src.file),
        sourceSection: str(src.section),
        sourceSkill: str(src.skill),
        sourceUrl: str(src.url),
        extraProvenance: srcList
          .map((s) => `${str(s.repo) ?? ""}|${str(s.file) ?? ""}|${str(s.section) ?? ""}`)
          .filter((s) => s !== "||"),
        deprecatedAt: str(life.deprecated_at) ?? null,
        supersededBy: str(life.superseded_by) ?? null,
        mergedFrom: Array.isArray(prov.merged_from)
          ? (prov.merged_from as unknown[]).map((x) => String(x))
          : [],
      });
      report.parsed += 1;
    }
  }
  return { units, report };
}

// -------------------------------------------------- migrated .prime fixtures

export function loadMigrated(root: string): { units: MigratedUnit[]; report: LoadReport } {
  const units: MigratedUnit[] = [];
  const report: LoadReport = { scanned: 0, parsed: 0, skipped: [] };
  const dir = join(root, "packages", "compiler", "fixtures", "migrated");
  for (const file of walk(dir, (f) => f.endsWith(".prime"))) {
    report.scanned += 1;
    const raw = readFileSync(file, "utf8");
    const name = /^\s*name:\s*"([^"]+)"/m.exec(raw)?.[1];
    if (!name) {
      report.skipped.push({ file, reason: "no-name" });
      continue;
    }
    units.push({
      name,
      file,
      base: basename(file, ".prime"),
      module: /^\s*module:\s*"([^"]+)"/m.exec(raw)?.[1],
      subtype: /^\s*subtype:\s*"([^"]+)"/m.exec(raw)?.[1],
    });
    report.parsed += 1;
  }
  return { units, report };
}

// ------------------------------------------------------- v3 .prime + atom.yaml

function dslField(raw: string, key: string): string | undefined {
  // quoted single-line value
  const q = new RegExp(`^\\s*${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(raw);
  if (q) return q[1].replace(/\\"/g, '"').trim() || undefined;
  // bare single-line value (identifiers, @refs, numbers)
  const b = new RegExp(`^\\s*${key}:\\s*([^"\\n{\\[][^\\n]*)$`, "m").exec(raw);
  if (b) return b[1].trim() || undefined;
  return undefined;
}

export function loadV3(
  root: string,
  sourcesRel: string,
  compiledRel: string
): { units: V3Unit[]; report: LoadReport } {
  const units: V3Unit[] = [];
  const report: LoadReport = { scanned: 0, parsed: 0, skipped: [] };

  // compiled side gives the authoritative kind / content_hash / domain
  const compiled = new Map<string, { kind: string; hash?: string; domain?: string; desc?: string }>();
  const compiledDir = join(root, compiledRel);
  for (const f of walk(compiledDir, (n) => n === "atom.yaml")) {
    try {
      const d = (parseYaml(readFileSync(f, "utf8")) ?? {}) as Record<string, unknown>;
      const id = str(d.id);
      if (!id) continue;
      compiled.set(id, {
        kind: str(d.kind) ?? "",
        hash: str(d.content_hash),
        domain: str(d.domain),
        desc: str(d.description),
      });
    } catch {
      report.skipped.push({ file: f, reason: "atom.yaml yaml-error" });
    }
  }

  for (const file of walk(join(root, sourcesRel), (f) => f.endsWith(".prime"))) {
    report.scanned += 1;
    const raw = readFileSync(file, "utf8");
    const id = /^\s*id:\s*"([^"]+)"/m.exec(raw)?.[1];
    if (!id) {
      report.skipped.push({ file, reason: "no-id" });
      continue;
    }
    const head = /^\s*([a-z][a-z-]*)\s+[A-Za-z0-9_]+\s*\{/m.exec(raw)?.[1] ?? "";
    const c = compiled.get(id);
    const i = id.indexOf("/");
    const srcBlock = /^\s*source:\s*\{([\s\S]*?)\}/m.exec(raw)?.[1] ?? "";
    const urls = [
      ...new Set(
        (raw.match(/https?:\/\/[^\s"',\]}]+/g) ?? []).map((u) => u.replace(/[.,)]+$/, ""))
      ),
    ];
    units.push({
      id,
      slug: i === -1 ? id.replace(/^@/, "") : id.slice(i + 1),
      ns: /^@([^/]+)\//.exec(id)?.[1] ?? "",
      kind: c?.kind || head,
      file,
      description: dslField(raw, "description") ?? c?.desc,
      statement: dslField(raw, "statement"),
      claim: dslField(raw, "claim"),
      label: dslField(raw, "label"),
      rationale: dslField(raw, "rationale"),
      domain: dslField(raw, "domain") ?? c?.domain,
      contentHash: c?.hash,
      sourceRepo: /repo:\s*"?([^",\n}]+)"?/.exec(srcBlock)?.[1]?.trim(),
      sourceFile: /file:\s*"?([^",\n}]+)"?/.exec(srcBlock)?.[1]?.trim(),
      sourceSection: /section:\s*"?([^",\n}]+)"?/.exec(srcBlock)?.[1]?.trim(),
      urls,
      related: [...new Set(raw.match(/@[a-z0-9-]+\/[a-z0-9-]+/gi) ?? [])].filter((r) => r !== id),
    });
    report.parsed += 1;
  }
  return { units, report };
}
