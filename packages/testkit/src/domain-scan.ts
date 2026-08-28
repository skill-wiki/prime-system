import { readdirSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { LoadedModel } from "@skill-wiki/model-schema";
import { check, finding, type CheckOutcome, type Finding } from "./diagnostics.ts";

/**
 * §3.1 made executable: the engine must not know what a domain calls things.
 *
 * The audit vocabulary is *input*, never a constant in this file — otherwise the
 * ruler would itself violate the rule it measures. Callers either derive the
 * vocabulary from a model package (so every type/relation name a model declares
 * becomes a forbidden word inside the engine) or load a vocabulary data file.
 */

export type HitContext = "comment" | "string" | "code";

export interface DomainHit {
  /** Path relative to the scan root's repository root. */
  readonly path: string;
  readonly package: string;
  readonly line: number;
  readonly column: number;
  readonly term: string;
  /** The literal spelling found, which may be a camel/snake variant of `term`. */
  readonly matched: string;
  readonly context: HitContext;
  readonly ambiguous: boolean;
  /** What the loaded model declared this term as, when it declared it at all. */
  readonly modelRole?: ModelRole;
  /** Name of the exemption that cleared this hit, if any. Exempt hits never gate. */
  readonly exemption?: string;
  readonly snippet: string;
}

export interface DomainScanReport {
  readonly roots: readonly string[];
  readonly filesScanned: number;
  readonly termCount: number;
  readonly hits: readonly DomainHit[];
  /** package -> distinctive, non-exempt code hits: the number that actually gates. */
  readonly distinctiveByPackage: Readonly<Record<string, number>>;
  readonly distinctiveByTerm: Readonly<Record<string, number>>;
  /**
   * Second-generation coupling: a *quoted* model-declared relation or type name.
   * `LINK_VERBS = ["requires", …]`, `outgoing(x, "contradicts")` and
   * `type LinkVerb = "requires" | …` are all this shape, and none of them can be
   * caught by the first-generation gate — that one only counts `code` context and
   * skips `ambiguous` words, and `requires` / `extends` / `conflicts` are exactly
   * the words on the ambiguous list.
   */
  readonly closedSetHits: readonly DomainHit[];
  readonly closedSetByPackage: Readonly<Record<string, number>>;
  /** exemption name -> how many hits it cleared. */
  readonly exemptedByName: Readonly<Record<string, number>>;
  /** Exemptions that matched nothing *and whose anchor file was scanned*. */
  readonly staleExemptions: readonly string[];
}

const ExemptionSchema = z.object({
  /** Stable id. Reports and stale-exemption warnings key on this. */
  name: z.string().min(1),
  /** The vocabulary term this exempts. Matched case-insensitively. */
  term: z.string().min(1),
  /** Why this spelling is not domain semantics. Required: an unexplained exemption is a hole. */
  reason: z.string().min(1),
  /** Repo-relative paths the exemption is anchored to. Omit for a shape-only exemption. */
  paths: z.array(z.string().min(1)).default([]),
  /** Regex the hit's line must match. Omit to exempt every code hit on `paths`. */
  linePattern: z.string().min(1).optional(),
}).strict();

const VocabularySchema = z.object({
  kind: z.literal("domain-vocabulary"),
  name: z.string().min(1),
  terms: z.array(z.string().min(1)).default([]),
  /**
   * Terms that are also ordinary programming vocabulary (`type`, `value`,
   * `source`). They are still reported, but flagged so a gate is not drowned.
   */
  ambiguous: z.array(z.string().min(1)).default([]),
  /**
   * Narrow, evidence-bearing carve-outs for a specific *spelling at a specific
   * site*, as opposed to `ambiguous`, which weakens a word everywhere. Anchored
   * to a path and a line shape so that when the code drifts the hit comes back
   * as an error rather than staying silently suppressed.
   */
  exemptions: z.array(ExemptionSchema).default([]),
}).strict();

export interface Exemption {
  readonly name: string;
  readonly term: string;
  readonly reason: string;
  readonly paths: readonly string[];
  readonly linePattern?: string;
}

export type ModelRole = "relation" | "type";

export interface Vocabulary {
  readonly name: string;
  readonly terms: readonly string[];
  readonly ambiguous: ReadonlySet<string>;
  readonly exemptions: readonly Exemption[];
  /**
   * Lowercased term -> what the *model* declared it as. Only a loaded model
   * populates this; a vocabulary data file cannot, and must not, since the whole
   * point is that the closed set lives outside the engine.
   */
  readonly modelRoles: ReadonlyMap<string, ModelRole>;
}

export function loadVocabulary(path: string): Vocabulary {
  const parsed = VocabularySchema.parse(parse(readFileSync(path, "utf8")));
  return {
    name: parsed.name,
    terms: parsed.terms,
    ambiguous: new Set(parsed.ambiguous),
    exemptions: parsed.exemptions.map(e => ({
      name: e.name, term: e.term, reason: e.reason, paths: e.paths,
      ...(e.linePattern === undefined ? {} : { linePattern: e.linePattern }),
    })),
    modelRoles: new Map(),
  };
}

/** Every name an external model introduces is a word the engine must not contain. */
export function vocabularyFromModel(model: LoadedModel, ambiguous: readonly string[] = []): Vocabulary {
  const terms = new Set<string>();
  const modelRoles = new Map<string, ModelRole>();
  for (const d of model.definitions) {
    if (d.kind === "type" || d.kind === "relation") { terms.add(d.name); modelRoles.set(d.name.toLowerCase(), d.kind); }
    if (d.kind === "relation") for (const alias of d.aliases ?? []) { terms.add(alias); modelRoles.set(alias.toLowerCase(), "relation"); }
  }
  return { name: `${model.manifest.name}@${model.manifest.version}`, terms: [...terms].sort(), ambiguous: new Set(ambiguous), exemptions: [], modelRoles };
}

export function mergeVocabularies(...parts: readonly Vocabulary[]): Vocabulary {
  const terms = new Set<string>();
  const ambiguous = new Set<string>();
  const exemptions: Exemption[] = [];
  const modelRoles = new Map<string, ModelRole>();
  const seen = new Set<string>();
  for (const p of parts) {
    for (const t of p.terms) terms.add(t);
    for (const a of p.ambiguous) ambiguous.add(a);
    for (const e of p.exemptions) { if (!seen.has(e.name)) { seen.add(e.name); exemptions.push(e); } }
    for (const [t, role] of p.modelRoles) modelRoles.set(t, role);
  }
  return { name: parts.map(p => p.name).join("+"), terms: [...terms].sort(), ambiguous, exemptions, modelRoles };
}

/** Mechanical spelling variants of a multi-word term. No domain knowledge involved. */
function variants(term: string): readonly string[] {
  const words = term.split(/[-_\s]+/).filter(w => w.length > 0);
  if (words.length < 2) return [term];
  const lower = words.map(w => w.toLowerCase());
  const pascal = lower.map(w => w[0]!.toUpperCase() + w.slice(1)).join("");
  return [...new Set([
    words.join("-"), lower.join("_"), lower.join(""),
    lower[0]! + pascal.slice(lower[0]!.length), pascal,
  ])];
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: "comment" | "string";
}

/**
 * Per-line comment/string spans for a whole file.
 *
 * A line-local classifier gets three things wrong, and all three showed up as
 * false `code` hits in the W3-2 audit: a trailing `// persona-brutalist`, the
 * body of a multi-line template literal (an LLM prompt), and a `/* … *\/` block
 * spanning lines. Only backtick literals and block comments carry across a line
 * boundary — an unterminated `'` or `"` is a lexical error in TS, so those reset
 * at end of line rather than poisoning the rest of the file.
 */
function spansForFile(lines: readonly string[]): readonly (readonly Span[])[] {
  const perLine: Span[][] = [];
  let inBlockComment = false;
  let inTemplate = false;
  for (const line of lines) {
    const spans: Span[] = [];
    let quote: '"' | "'" | undefined;
    let openStart = inBlockComment || inTemplate ? 0 : -1;
    let i = 0;
    while (i < line.length) {
      const c = line[i]!;
      const next = line[i + 1];
      if (inBlockComment) {
        if (c === "*" && next === "/") { spans.push({ start: openStart, end: i + 1, kind: "comment" }); inBlockComment = false; openStart = -1; i += 2; continue; }
        i += 1; continue;
      }
      if (inTemplate) {
        if (c === "\\") { i += 2; continue; }
        // `${…}` reopens code: the expression inside is real code, so close the
        // string span here and start a fresh one after the matching brace.
        if (c === "$" && next === "{") {
          spans.push({ start: openStart, end: i - 1, kind: "string" });
          let depth = 1;
          i += 2;
          while (i < line.length && depth > 0) {
            if (line[i] === "{") depth += 1;
            else if (line[i] === "}") depth -= 1;
            i += 1;
          }
          openStart = i;
          continue;
        }
        if (c === "`") { spans.push({ start: openStart, end: i, kind: "string" }); inTemplate = false; openStart = -1; i += 1; continue; }
        i += 1; continue;
      }
      if (quote !== undefined) {
        if (c === "\\") { i += 2; continue; }
        if (c === quote) { spans.push({ start: openStart, end: i, kind: "string" }); quote = undefined; openStart = -1; }
        i += 1; continue;
      }
      if (c === "/" && next === "/") { spans.push({ start: i, end: line.length, kind: "comment" }); break; }
      if (c === "/" && next === "*") { inBlockComment = true; openStart = i; i += 2; continue; }
      if (c === "`") { inTemplate = true; openStart = i; i += 1; continue; }
      if (c === '"' || c === "'") { quote = c; openStart = i; i += 1; continue; }
      i += 1;
    }
    if (inBlockComment) spans.push({ start: openStart, end: line.length, kind: "comment" });
    else if (inTemplate) spans.push({ start: openStart, end: line.length, kind: "string" });
    else if (quote !== undefined) spans.push({ start: openStart, end: line.length, kind: "string" });
    perLine.push(spans);
  }
  return perLine;
}

function classify(spans: readonly Span[], column: number): HitContext {
  const hit = spans.find(s => column >= s.start && column <= s.end);
  return hit === undefined ? "code" : hit.kind;
}

function walk(dir: string, extensions: readonly string[], skipDirectories: ReadonlySet<string>, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!skipDirectories.has(entry.name)) walk(join(dir, entry.name), extensions, skipDirectories, out); continue; }
    if (extensions.some(e => entry.name.endsWith(e))) out.push(join(dir, entry.name));
  }
}

export interface DomainScanOptions {
  /** Directories to scan. Each is walked recursively. */
  readonly roots: readonly string[];
  readonly vocabulary: Vocabulary;
  /** Paths are reported relative to this. */
  readonly reportRoot: string;
  readonly extensions?: readonly string[];
  readonly skipDirectories?: readonly string[];
  /** Absolute path prefixes to exclude, e.g. the testkit's own vocabulary data. */
  readonly excludePaths?: readonly string[];
}

function packageOf(relativePath: string): string {
  const parts = relativePath.split(sep);
  const index = parts.indexOf("packages");
  return index >= 0 && parts.length > index + 1 ? parts[index + 1]! : parts[0] ?? "<root>";
}

export function scanDomainSemantics(options: DomainScanOptions): DomainScanReport {
  const extensions = options.extensions ?? [".ts"];
  const skipDirectories = new Set(options.skipDirectories ?? ["node_modules", "dist", "coverage", "fixtures", ".git"]);
  const excluded = (options.excludePaths ?? []).map(p => resolve(p));
  const files: string[] = [];
  for (const root of options.roots) {
    const abs = resolve(root);
    if (!existsSync(abs) || !lstatSync(abs).isDirectory()) continue;
    walk(abs, extensions, skipDirectories, files);
  }
  const scanned = files.filter(f => !excluded.some(e => f.startsWith(e))).sort();

  const patterns = options.vocabulary.terms.flatMap(term =>
    variants(term).map(v => ({ term, regex: new RegExp(`(?<![A-Za-z0-9_])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "gi") })));

  const exemptions = options.vocabulary.exemptions.map(e => ({
    spec: e,
    termLower: e.term.toLowerCase(),
    paths: e.paths.map(p => p.split("/").join(sep)),
    ...(e.linePattern === undefined ? {} : { regex: new RegExp(e.linePattern) }),
  }));
  const exemptionUse = new Map<string, number>(exemptions.map(e => [e.spec.name, 0]));

  const hits: DomainHit[] = [];
  for (const file of scanned) {
    const relativePath = relative(resolve(options.reportRoot), file);
    const pkg = packageOf(relativePath);
    const lines = readFileSync(file, "utf8").split("\n");
    const spans = spansForFile(lines);
    lines.forEach((line, index) => {
      for (const { term, regex } of patterns) {
        regex.lastIndex = 0;
        for (let m = regex.exec(line); m !== null; m = regex.exec(line)) {
          const context = classify(spans[index] ?? [], m.index);
          // A comment is documentation debt, never a gate hit, so it needs no
          // exemption. Code and string literals both gate, so both can be cleared.
          const cleared = context === "comment" ? undefined : exemptions.find(e =>
            e.termLower === term.toLowerCase()
            && (e.paths.length === 0 || e.paths.some(p => relativePath === p || relativePath.endsWith(sep + p)))
            && (e.regex === undefined || e.regex.test(line)));
          if (cleared !== undefined) exemptionUse.set(cleared.spec.name, (exemptionUse.get(cleared.spec.name) ?? 0) + 1);
          const modelRole = options.vocabulary.modelRoles.get(term.toLowerCase());
          hits.push({
            path: relativePath, package: pkg, line: index + 1, column: m.index + 1,
            term, matched: m[0], context,
            ambiguous: options.vocabulary.ambiguous.has(term.toLowerCase()),
            ...(modelRole === undefined ? {} : { modelRole }),
            ...(cleared === undefined ? {} : { exemption: cleared.spec.name }),
            snippet: line.trim().slice(0, 120),
          });
        }
      }
    });
  }

  const distinctiveByPackage: Record<string, number> = {};
  const distinctiveByTerm: Record<string, number> = {};
  for (const h of hits.filter(h => !h.ambiguous && h.context === "code" && h.exemption === undefined)) {
    distinctiveByPackage[h.package] = (distinctiveByPackage[h.package] ?? 0) + 1;
    distinctiveByTerm[h.term] = (distinctiveByTerm[h.term] ?? 0) + 1;
  }
  // Deliberately does not simply ignore `ambiguous`: `"type"` and `"value"` are
  // v1 type names AND ordinary protocol strings, and counting every quoted one
  // produced 603 hits — noise a lane cannot act on. Two shapes are evidence of a
  // hardcoded closed set instead of English:
  //   (a) the quoted name is a model name that is NOT ordinary programming
  //       vocabulary (`"contradicts"`, `"supplies_to"`, `"specializes"`);
  //   (b) the line quotes two or more distinct model names of the same role — an
  //       enumeration, which is what a closed set literally is
  //       (`LinkVerb = "requires" | "enhances" | …`, `verbs = ["requires", "supplies_to"]`).
  const quotedModel = hits.filter(h => h.context === "string" && h.modelRole !== undefined && h.exemption === undefined);
  const enumeratedLines = new Set<string>();
  const perLine = new Map<string, Map<ModelRole, Set<string>>>();
  for (const h of quotedModel) {
    const key = `${h.path}:${h.line}`;
    const roles = perLine.get(key) ?? new Map<ModelRole, Set<string>>();
    const terms = roles.get(h.modelRole!) ?? new Set<string>();
    terms.add(h.term.toLowerCase());
    roles.set(h.modelRole!, terms);
    perLine.set(key, roles);
  }
  for (const [key, roles] of perLine) for (const terms of roles.values()) if (terms.size >= 2) enumeratedLines.add(key);
  // One site, one hit. `"see-also": "see-also"` matches four times (the name and
  // its `see_also` alias, twice each), and a lane acts on the line, not the token.
  const seenSite = new Set<string>();
  const closedSetHits = quotedModel
    .filter(h => !h.ambiguous || enumeratedLines.has(`${h.path}:${h.line}`))
    .filter(h => { const k = `${h.path}:${h.line}:${h.term.toLowerCase().replace(/[-_]/g, "")}`; if (seenSite.has(k)) return false; seenSite.add(k); return true; });
  const closedSetByPackage: Record<string, number> = {};
  for (const h of closedSetHits) closedSetByPackage[h.package] = (closedSetByPackage[h.package] ?? 0) + 1;

  const exemptedByName: Record<string, number> = {};
  for (const [name, count] of [...exemptionUse].sort(([a], [b]) => (a < b ? -1 : 1))) if (count > 0) exemptedByName[name] = count;
  // A path-anchored exemption whose file was not in the scan roots is out of
  // scope, not rotted. Reporting it stale on every scoped run trains the reader
  // to ignore the warning, which is how a real rotted anchor gets missed. A
  // shape-only exemption has no anchor to rot, so it is never stale.
  const scannedRelative = new Set(scanned.map(f => relative(resolve(options.reportRoot), f)));
  const inScope = (e: Exemption): boolean =>
    e.paths.length > 0 && e.paths.some(p => [...scannedRelative].some(s => s === p.split("/").join(sep) || s.endsWith(sep + p.split("/").join(sep))));
  const staleExemptions = [...exemptionUse]
    .filter(([name, c]) => c === 0 && inScope(options.vocabulary.exemptions.find(e => e.name === name)!))
    .map(([n]) => n).sort();
  return {
    roots: [...options.roots], filesScanned: scanned.length, termCount: options.vocabulary.terms.length, hits,
    distinctiveByPackage, distinctiveByTerm, closedSetHits, closedSetByPackage, exemptedByName, staleExemptions,
  };
}

/**
 * The gate only counts unambiguous, non-exempt terms in real code: a domain word
 * inside a comment is documentation debt, and `type` inside the engine is English.
 *
 * §17.5 — a suppression must be recorded, never disguised as a pass. Every
 * exemption that fired is emitted as an `info` finding naming its reason, and an
 * exemption that fired zero times is a `warning`, because a rotted anchor would
 * otherwise sit there suppressing nothing while looking like coverage.
 */
export function domainScanCheck(scan: DomainScanReport): CheckOutcome {
  const findings: Finding[] = Object.entries(scan.distinctiveByPackage)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([pkg, count]) => finding("DOMAIN_TERM_IN_CORE", `${count} unambiguous domain-term occurrence(s) in code`, "error", { subject: `package:${pkg}` }));
  const nonCode = scan.hits.filter(h => !h.ambiguous && h.context !== "code").length;
  const warnings: Finding[] = nonCode > 0
    ? [finding("DOMAIN_TERM_IN_COMMENT_OR_STRING", `${nonCode} occurrence(s) in comments or string literals`, "warning")]
    : [];
  const exempted: Finding[] = Object.entries(scan.exemptedByName)
    .map(([name, count]) => finding("DOMAIN_TERM_EXEMPTED", `${count} code occurrence(s) cleared by exemption`, "info", { subject: `exemption:${name}` }));
  const stale: Finding[] = scan.staleExemptions
    .map(name => finding("DOMAIN_TERM_EXEMPTION_STALE", "exemption matched no code occurrence; remove it or fix its anchor", "warning", { subject: `exemption:${name}` }));
  return check("ZDS-CORE-VOCABULARY", "Engine source contains no external-model vocabulary", [...findings, ...warnings, ...exempted, ...stale]);
}

/**
 * Second-generation gate: a quoted model-declared relation or type name.
 *
 * Kept as its own check with its own codes so the two generations of coupling
 * read separately. The first generation is the frontend design stack's
 * vocabulary (`typography`, `motion`); this one is the closed set of relation
 * verbs and atom kinds that plan §3.1 names directly — "the core may not know
 * whether `requires` should be a transitive closure".
 */
export function closedSetCheck(scan: DomainScanReport): CheckOutcome {
  const byRole = (role: ModelRole): number => scan.closedSetHits.filter(h => h.modelRole === role).length;
  const findings: Finding[] = Object.entries(scan.closedSetByPackage)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([pkg, count]) => {
      const inPkg = scan.closedSetHits.filter(h => h.package === pkg);
      const relations = inPkg.filter(h => h.modelRole === "relation").length;
      return [finding(
        "MODEL_CLOSED_SET_LITERAL",
        `${count} quoted model-declared name(s) in engine source (${relations} relation, ${count - relations} type)`,
        "error",
        { subject: `package:${pkg}` },
      )];
    });
  const summary: Finding[] = findings.length === 0 ? [] : [finding(
    "MODEL_CLOSED_SET_TOTAL",
    `${byRole("relation")} relation-name and ${byRole("type")} type-name literal(s) total`,
    "info",
  )];
  return check("ZDS-CORE-CLOSED-SETS", "Engine source hardcodes no model-declared closed set", [...findings, ...summary]);
}

export function formatDomainScan(scan: DomainScanReport, options: { readonly maxRows?: number; readonly onlyDistinctive?: boolean } = {}): string {
  const rows = (options.onlyDistinctive === true ? scan.hits.filter(h => !h.ambiguous) : scan.hits);
  const limit = options.maxRows ?? rows.length;
  const lines = [
    `files scanned: ${scan.filesScanned}, vocabulary terms: ${scan.termCount}, total hits: ${scan.hits.length}, gating code hits: ${Object.values(scan.distinctiveByPackage).reduce((a, b) => a + b, 0)}, exempted: ${Object.values(scan.exemptedByName).reduce((a, b) => a + b, 0)}`,
    "",
    "| package | file | line | term | matched | context | ambiguous | exemption |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.slice(0, limit).map(h => `| ${h.package} | ${h.path} | ${h.line} | ${h.term} | \`${h.matched}\` | ${h.context} | ${h.ambiguous ? "yes" : "no"} | ${h.exemption ?? "—"} |`),
  ];
  if (rows.length > limit) lines.push(`| … | ${rows.length - limit} more rows omitted | | | | | | |`);
  return lines.join("\n");
}
