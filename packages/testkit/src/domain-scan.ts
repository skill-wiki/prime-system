import { readdirSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { LoadedModel } from "@aoe/model-schema";
import { check, finding, type CheckOutcome, type Finding, type Severity } from "./diagnostics.ts";

/**
 * §3.1 made executable: the engine must not know what a domain calls things.
 *
 * The audit vocabulary is *input*, never a constant in this file — otherwise the
 * ruler would itself violate the rule it measures. Callers either derive the
 * vocabulary from a model package (so every type/relation name a model declares
 * becomes a forbidden word inside the engine) or load a vocabulary data file.
 */

export type HitContext = "comment" | "string" | "code";

/**
 * Whether a module can influence what the engine decides.
 *
 * The naive criterion is the path (`test/`, `fixtures/`), and it is worthless as
 * a completion gate because it is bypassed by moving a fixture into `src/`. The
 * criterion here is **reachability from the package's declared entry points**,
 * which is the same question asked structurally: a model name only constrains
 * the engine if the module holding it is loaded when the engine is loaded.
 *
 * - `engine`      reachable by static import from `main`/`types`/`exports`/`bin`.
 *                 A closed set here is a §3.1 violation. Gates.
 * - `test`        unreachable AND test-shaped (a test/fixture module, or one that
 *                 imports a test runner). `Control`/`Threat` in a fixture is the
 *                 reason the fixture exists. Reported as `info`.
 * - `unreachable` unreachable and NOT test-shaped: a module carrying a closed set
 *                 that nothing loads. Reported as `warning`, never silence —
 *                 fail-closed, because import resolution can under-approximate
 *                 (dynamic `import()`, a package with no entry) and a silent tier
 *                 would turn that into a hidden violation.
 *
 * When a file has no resolvable package entry at all the tier is `engine`: the
 * scanner may not weaken its own gate on the strength of a failed lookup.
 */
export type SourceTier = "engine" | "test" | "unreachable";

/**
 * Whether the quoted name IS the string, or merely a word inside it.
 *
 * `"contradicts"` declares a closed-set member. `"scope=related requires \`id\`."`
 * is an English sentence in which `requires` happens to be the verb, and
 * `"Every type is covered by a projection rule"` is a diagnostic message in which
 * `type` and `rule` happen to be two v1 type names — which is enough to trip an
 * enumeration heuristic. Both fixes are real but they are different in kind (read
 * the model vs. reword the message), so per D-6 they get separate codes rather
 * than being merged into one number.
 */
export type LiteralShape = "exact" | "embedded";

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
  /** Whether the module holding this hit can influence engine behaviour. */
  readonly tier: SourceTier;
  /** Only meaningful for `string` context: is the name the whole literal, or a word in it? */
  readonly shape: LiteralShape;
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
  /** Engine-tier closed-set hits per package: the number that actually gates. */
  readonly closedSetByPackage: Readonly<Record<string, number>>;
  /** All three tiers, so a demotion is visible rather than looking like progress. */
  readonly closedSetByTier: Readonly<Record<SourceTier, number>>;
  /**
   * A model name embedded in a longer string — a diagnostic message, an LLM
   * prompt, a usage line, a SQL column list. Real documentation-level coupling in
   * some cases, pure English in others, but never a declared closed set, so it
   * carries its own code at `warning` instead of inflating the gate.
   */
  readonly proseHits: readonly DomainHit[];
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

function spanAt(spans: readonly Span[], column: number): Span | undefined {
  return spans.find(s => column >= s.start && column <= s.end);
}

function classify(spans: readonly Span[], column: number): HitContext {
  return spanAt(spans, column)?.kind ?? "code";
}

/** Case- and separator-insensitive, so `see-also` / `see_also` / `SeeAlso` compare equal. */
function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_\s]+/g, "");
}

/**
 * `exact` iff the matched term spans the entire string literal.
 *
 * An interpolated template fragment can never be `exact`, which is the desired
 * answer: a name assembled at runtime is not a declared closed-set member.
 */
function literalShape(line: string, span: Span | undefined, term: string): LiteralShape {
  if (span === undefined || span.kind !== "string") return "embedded";
  return normalizeName(line.slice(span.start + 1, span.end)) === normalizeName(term) ? "exact" : "embedded";
}

const TEST_RUNNER_IMPORT = /from\s+["'](?:bun:test|node:test|vitest|@jest\/globals)["']/;
/**
 * Includes the bare side-effect form `import "./x.ts";`. Omitting it made the
 * tier fail *open*: a module loaded only for its side effects is loaded, yet it
 * would read as `unreachable` and have its closed-set violations demoted from
 * error to warning. There are zero such imports in the workspace today, so this
 * changes no current count — it closes the hole before something lands in it.
 */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|;\s*import\s+)["'](\.[^"']*)["']/gm;

/** A module is test-shaped by what it is, not only by where it sits. */
function isTestShaped(relativePath: string, source: string): boolean {
  const parts = relativePath.split(sep);
  const name = parts[parts.length - 1] ?? "";
  return /\.(?:test|spec|fixture)\.[cm]?tsx?$/.test(name)
    || parts.some(p => p === "test" || p === "tests" || p === "__tests__" || p === "fixtures")
    || TEST_RUNNER_IMPORT.test(source);
}

/** `dist/index.js` is a build artifact of `src/index.ts`; the scanner reads sources. */
function sourceCandidates(entry: string): readonly string[] {
  const withoutDist = entry.replace(/^(?:\.\/)?dist\//, "src/").replace(/\.[cm]?js$/, ".ts");
  return [...new Set([entry.replace(/^\.\//, ""), withoutDist])];
}

function resolveImport(fromFile: string, specifier: string): readonly string[] {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.[cm]?js$/, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts"), `${base}.ts`, join(base, "index.ts")];
}

function declaredEntries(packageDir: string): readonly string[] {
  const manifestPath = join(packageDir, "package.json");
  const raw: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
  const manifest = raw as { main?: unknown; types?: unknown; bin?: unknown; exports?: unknown } | undefined;
  const declared: string[] = [];
  for (const field of [manifest?.main, manifest?.types]) if (typeof field === "string") declared.push(field);
  if (typeof manifest?.bin === "string") declared.push(manifest.bin);
  else if (manifest?.bin !== null && typeof manifest?.bin === "object") {
    for (const v of Object.values(manifest.bin as Record<string, unknown>)) if (typeof v === "string") declared.push(v);
  }
  const collectExports = (node: unknown): void => {
    if (typeof node === "string") { declared.push(node); return; }
    if (node !== null && typeof node === "object") for (const v of Object.values(node as Record<string, unknown>)) collectExports(v);
  };
  collectExports(manifest?.exports);
  // `src/index.ts` is the workspace convention even where no manifest field points
  // at it (`registry` declares no `main`), so it is always a candidate root.
  declared.push("src/index.ts", "src/cli.ts");
  return [...new Set(declared.flatMap(sourceCandidates).map(e => join(packageDir, e)))].filter(existsSync);
}

/**
 * Static-import closure of a package's entry points.
 *
 * Deliberately follows only relative specifiers: a `@aoe/x` import crosses
 * into another package, and that package is walked from its own entry, so the
 * closure never has to model workspace resolution.
 *
 * Exported because the package-wiring gate must ask the *same* question one
 * level up ("is this package reached by anything that runs?"). Two independent
 * notions of "production code" would let a module be engine-tier for one gate
 * and test-tier for the other, which is how a package ends up 100% tested and
 * still dead.
 */
export function reachableFrom(packageDir: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...declaredEntries(packageDir)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file) || !lstatSync(file).isFile()) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    RELATIVE_IMPORT.lastIndex = 0;
    for (let m = RELATIVE_IMPORT.exec(source); m !== null; m = RELATIVE_IMPORT.exec(source)) {
      for (const candidate of resolveImport(file, m[1]!)) {
        if (!seen.has(candidate) && existsSync(candidate) && lstatSync(candidate).isFile()) { queue.push(candidate); break; }
      }
    }
  }
  return seen;
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
  /**
   * True when the roots cover the whole workspace. Only then can an exemption
   * that fired nowhere be called stale on the strength of the whole repo having
   * been looked at — see `staleExemptions`.
   */
  readonly completeScan?: boolean;
}

function packageOf(relativePath: string): string {
  const parts = relativePath.split(sep);
  const index = parts.indexOf("packages");
  return index >= 0 && parts.length > index + 1 ? parts[index + 1]! : parts[0] ?? "<root>";
}

/** The directory holding the `package.json` that owns `file`, if any. */
function packageDirOf(file: string): string | undefined {
  const parts = file.split(sep);
  const index = parts.lastIndexOf("packages");
  if (index < 0 || parts.length <= index + 1) return undefined;
  const dir = parts.slice(0, index + 2).join(sep);
  return existsSync(join(dir, "package.json")) ? dir : undefined;
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
  /** `path:line` -> the raw line, so the enumeration test can look at what separates two names. */
  const lineByKey = new Map<string, string>();
  // One closure per package, memoised: the walk is the same for every file in it.
  const reachableByPackage = new Map<string, ReadonlySet<string>>();
  for (const file of scanned) {
    const relativePath = relative(resolve(options.reportRoot), file);
    const pkg = packageOf(relativePath);
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    const packageDir = packageDirOf(file);
    let tier: SourceTier = "engine";
    if (packageDir !== undefined) {
      let reachable = reachableByPackage.get(packageDir);
      if (reachable === undefined) { reachable = reachableFrom(packageDir); reachableByPackage.set(packageDir, reachable); }
      tier = reachable.has(file) ? "engine" : isTestShaped(relativePath, source) ? "test" : "unreachable";
    }
    const spans = spansForFile(lines);
    lines.forEach((line, index) => {
      for (const { term, regex } of patterns) {
        regex.lastIndex = 0;
        for (let m = regex.exec(line); m !== null; m = regex.exec(line)) {
          const span = spanAt(spans[index] ?? [], m.index);
          const context = span?.kind ?? "code";
          // A comment is documentation debt, never a gate hit, so it needs no
          // exemption. Code and string literals both gate, so both can be cleared.
          const cleared = context === "comment" ? undefined : exemptions.find(e =>
            e.termLower === term.toLowerCase()
            && (e.paths.length === 0 || e.paths.some(p => relativePath === p || relativePath.endsWith(sep + p)))
            && (e.regex === undefined || e.regex.test(line)));
          if (cleared !== undefined) exemptionUse.set(cleared.spec.name, (exemptionUse.get(cleared.spec.name) ?? 0) + 1);
          const modelRole = options.vocabulary.modelRoles.get(term.toLowerCase());
          lineByKey.set(`${relativePath}:${index + 1}`, line);
          hits.push({
            path: relativePath, package: pkg, line: index + 1, column: m.index + 1,
            term, matched: m[0], context,
            ambiguous: options.vocabulary.ambiguous.has(term.toLowerCase()),
            tier, shape: literalShape(line, span, term),
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
  // Per-site dedup, matching the closed-set path: `validates-with` and
  // `validates_with` are two vocabulary terms whose variants match the same
  // characters, so `validates_with: "VALIDATES"` was counted twice. Left
  // undeduped, the first-generation total reads 27 where 23 sites exist.
  const seenGen1 = new Set<string>();
  for (const h of hits.filter(h => !h.ambiguous && h.context === "code" && h.exemption === undefined)) {
    const site = `${h.path}:${h.line}:${h.column}:${normalizeName(h.term)}`;
    if (seenGen1.has(site)) continue;
    seenGen1.add(site);
    distinctiveByPackage[h.package] = (distinctiveByPackage[h.package] ?? 0) + 1;
    distinctiveByTerm[h.term] = (distinctiveByTerm[h.term] ?? 0) + 1;
  }
  // Deliberately does not simply ignore `ambiguous`: `"type"` and `"value"` are
  // v1 type names AND ordinary protocol strings, and counting every quoted one
  // produced 603 hits — noise a lane cannot act on. Three conditions, in order:
  //   (0) the name is the WHOLE literal. `"contradicts"` declares a set member;
  //       `"scope=related requires \`id\`."` is a sentence. Without this, any
  //       diagnostic message mentioning two model names read as an enumeration —
  //       which is how "Every type is covered by a projection rule" became 12
  //       reported violations in the testkit and 2 in model-schema.
  //   (a) the quoted name is a model name that is NOT ordinary programming
  //       vocabulary (`"contradicts"`, `"supplies_to"`, `"specializes"`);
  //   (b) or the line quotes two or more distinct exact model names of the same
  //       role — an enumeration, which is what a closed set literally is
  //       (`LinkVerb = "requires" | "enhances" | …`, `["requires", "supplies_to"]`).
  const quotedModel = hits.filter(h => h.context === "string" && h.modelRole !== undefined && h.exemption === undefined);
  const exactNames = quotedModel.filter(h => h.shape === "exact");
  const enumeratedSites = new Set<string>();
  const byLine = new Map<string, DomainHit[]>();
  for (const h of exactNames) {
    const key = `${h.path}:${h.line}`;
    byLine.set(key, [...(byLine.get(key) ?? []), h]);
  }
  for (const [key, lineHits] of byLine) {
    const line = lineByKey.get(key) ?? "";
    const ordered = [...lineHits].sort((a, b) => a.column - b.column);
    // A run, not the whole line: `model-schema/src/index.ts:50` is a 1159-char
    // one-liner where `d.kind === "type"` and `` `${owner}/rule` `` sit 880
    // columns apart in unrelated statements, and "two names on one line" called
    // that an enumeration. Members of a real enumeration are separated by
    // nothing but delimiters.
    let run: DomainHit[] = [];
    const flush = (): void => {
      const roles = new Map<ModelRole, Set<string>>();
      for (const h of run) {
        const set = roles.get(h.modelRole!) ?? new Set<string>();
        set.add(normalizeName(h.term));
        roles.set(h.modelRole!, set);
      }
      if ([...roles.values()].some(s => s.size >= 2)) for (const h of run) enumeratedSites.add(`${h.path}:${h.line}:${h.column}`);
      run = [];
    };
    for (const h of ordered) {
      const previous = run[run.length - 1];
      if (previous !== undefined) {
        const between = line.slice(previous.column - 1 + previous.matched.length, h.column - 1);
        if (!/^["'`\s,|\[\]()]*$/.test(between)) flush();
      }
      run.push(h);
    }
    flush();
  }
  // One site, one hit. `"see-also": "see-also"` matches four times (the name and
  // its `see_also` alias, twice each), and a lane acts on the line, not the token.
  const dedupBySite = (list: readonly DomainHit[]): readonly DomainHit[] => {
    const seen = new Set<string>();
    return list.filter(h => { const k = `${h.path}:${h.line}:${normalizeName(h.term)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const closedSetHits = dedupBySite(exactNames.filter(h => !h.ambiguous || enumeratedSites.has(`${h.path}:${h.line}:${h.column}`)));
  // An ambiguous term inside prose is just English and is dropped entirely; a
  // distinctive model name inside prose is real coupling of a different kind.
  // A module specifier is neither: `export * from "./method"` names a file, and
  // renaming the file changes nothing about what the engine knows.
  const isModulePath = (h: DomainHit): boolean => /^\s*(?:import|export)\b[^;]*\bfrom\s*["'`]|^\s*(?:import|export)\s*["'`]/.test(lineByKey.get(`${h.path}:${h.line}`) ?? "");
  const proseHits = dedupBySite(quotedModel.filter(h => h.shape === "embedded" && !h.ambiguous && !isModulePath(h)));
  const closedSetByPackage: Record<string, number> = {};
  for (const h of closedSetHits.filter(h => h.tier === "engine")) closedSetByPackage[h.package] = (closedSetByPackage[h.package] ?? 0) + 1;
  const closedSetByTier: Record<SourceTier, number> = { engine: 0, test: 0, unreachable: 0 };
  for (const h of closedSetHits) closedSetByTier[h.tier] += 1;

  const exemptedByName: Record<string, number> = {};
  for (const [name, count] of [...exemptionUse].sort(([a], [b]) => (a < b ? -1 : 1))) if (count > 0) exemptedByName[name] = count;
  // A path-anchored exemption whose file was not in the scan roots is out of
  // scope, not rotted. Reporting it stale on every scoped run trains the reader
  // to ignore the warning, which is how a real rotted anchor gets missed.
  //
  // A shape-only exemption has no anchor path to check, so on a scoped run it is
  // likewise unjudgeable — but on a COMPLETE scan "matched nothing anywhere in
  // the workspace" is exactly the rot signal, and treating it as permanently
  // unjudgeable left a suppression that can outlive its sites while looking like
  // coverage. `http-request-method` was in that state.
  const scannedRelative = new Set(scanned.map(f => relative(resolve(options.reportRoot), f)));
  const anchorScanned = (e: Exemption): boolean =>
    e.paths.some(p => [...scannedRelative].some(s => s === p.split("/").join(sep) || s.endsWith(sep + p.split("/").join(sep))));
  const judgeable = (e: Exemption): boolean =>
    e.paths.length > 0 ? anchorScanned(e) : options.completeScan === true;
  const staleExemptions = [...exemptionUse]
    .filter(([name, c]) => c === 0 && judgeable(options.vocabulary.exemptions.find(e => e.name === name)!))
    .map(([n]) => n).sort();
  return {
    roots: [...options.roots], filesScanned: scanned.length, termCount: options.vocabulary.terms.length, hits,
    distinctiveByPackage, distinctiveByTerm, closedSetHits, closedSetByPackage, closedSetByTier, proseHits,
    exemptedByName, staleExemptions,
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
 *
 * Four codes, because four different things must be done about them and a single
 * number sends a lane to the wrong one:
 *
 * | code                                 | severity | what it means                          |
 * |--------------------------------------|----------|----------------------------------------|
 * | `MODEL_CLOSED_SET_LITERAL`           | error    | engine-reachable module. §3.1 violation |
 * | `MODEL_CLOSED_SET_IN_UNREACHABLE`    | warning  | nothing loads it — delete or wire it   |
 * | `MODEL_NAME_IN_TEST_FIXTURE`         | info     | fixture data. Legitimate by definition |
 * | `MODEL_NAME_IN_PROSE`                | warning  | a message/prompt, not a declared set   |
 *
 * Only the first gates, so the check can reach `pass` on a repo that still has
 * fixtures naming `Control` and `Threat` — without which it could never be used
 * as a completion criterion at all.
 */
export function closedSetCheck(scan: DomainScanReport): CheckOutcome {
  const engine = scan.closedSetHits.filter(h => h.tier === "engine");
  const byRole = (list: readonly DomainHit[], role: ModelRole): number => list.filter(h => h.modelRole === role).length;
  const perPackage = (list: readonly DomainHit[], code: string, severity: Severity, what: string): readonly Finding[] => {
    const packages = [...new Set(list.map(h => h.package))].sort();
    return packages.map(pkg => {
      const inPkg = list.filter(h => h.package === pkg);
      const relations = byRole(inPkg, "relation");
      return finding(code, `${inPkg.length} ${what} (${relations} relation, ${inPkg.length - relations} type)`, severity, { subject: `package:${pkg}` });
    });
  };
  const findings: Finding[] = [
    ...perPackage(engine, "MODEL_CLOSED_SET_LITERAL", "error", "quoted model-declared name(s) in engine source"),
    ...perPackage(scan.closedSetHits.filter(h => h.tier === "unreachable"), "MODEL_CLOSED_SET_IN_UNREACHABLE", "warning", "quoted model-declared name(s) in a module no entry point reaches"),
    ...perPackage(scan.proseHits.filter(h => h.tier === "engine"), "MODEL_NAME_IN_PROSE", "warning", "model name(s) embedded in message or prompt text"),
    ...perPackage(scan.closedSetHits.filter(h => h.tier === "test"), "MODEL_NAME_IN_TEST_FIXTURE", "info", "model name(s) in test/fixture data, which is what a fixture is for"),
  ];
  const summary: Finding[] = engine.length === 0 ? [] : [finding(
    "MODEL_CLOSED_SET_TOTAL",
    `${byRole(engine, "relation")} relation-name and ${byRole(engine, "type")} type-name literal(s) in engine source`,
    "info",
  )];
  return check("ZDS-CORE-CLOSED-SETS", "Engine source hardcodes no model-declared closed set", [...findings, ...summary]);
}

export function formatDomainScan(
  scan: DomainScanReport,
  options: { readonly maxRows?: number; readonly onlyDistinctive?: boolean; readonly onlyClosedSets?: boolean } = {},
): string {
  // A lane fixing closed sets needs the closed-set rows, and `--all-hits` used to
  // dump every vocabulary match with no column saying which ones the gate counts.
  const rows = options.onlyClosedSets === true
    ? [...scan.closedSetHits, ...scan.proseHits].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
    : (options.onlyDistinctive === true ? scan.hits.filter(h => !h.ambiguous) : scan.hits);
  const gate = (h: DomainHit): string =>
    scan.closedSetHits.includes(h) ? (h.tier === "engine" ? "closed-set/ERROR" : `closed-set/${h.tier}`) : "prose";
  const limit = options.maxRows ?? rows.length;
  const lines = options.onlyClosedSets === true
    ? [
      `closed-set hits: ${scan.closedSetHits.length} (engine ${scan.closedSetByTier.engine}, test-fixture ${scan.closedSetByTier.test}, unreachable ${scan.closedSetByTier.unreachable}); prose: ${scan.proseHits.length}`,
      "",
      "| package | file:line | term | role | verdict | snippet |",
      "|---|---|---|---|---|---|",
      ...rows.slice(0, limit).map(h => `| ${h.package} | ${h.path}:${h.line} | ${h.term} | ${h.modelRole ?? "—"} | ${gate(h)} | \`${h.snippet.replace(/\|/g, "\\|")}\` |`),
    ]
    : [
      `files scanned: ${scan.filesScanned}, vocabulary terms: ${scan.termCount}, total hits: ${scan.hits.length}, gating code hits: ${Object.values(scan.distinctiveByPackage).reduce((a, b) => a + b, 0)}, exempted: ${Object.values(scan.exemptedByName).reduce((a, b) => a + b, 0)}`,
      "",
      "| package | file | line | term | matched | context | tier | ambiguous | exemption |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows.slice(0, limit).map(h => `| ${h.package} | ${h.path} | ${h.line} | ${h.term} | \`${h.matched}\` | ${h.context} | ${h.tier} | ${h.ambiguous ? "yes" : "no"} | ${h.exemption ?? "—"} |`),
    ];
  if (rows.length > limit) lines.push(`| … | ${rows.length - limit} more rows omitted | | | | | | |`);
  return lines.join("\n");
}
