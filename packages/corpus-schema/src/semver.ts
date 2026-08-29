/**
 * SemVer comparison and range resolution for Corpus Package model bindings.
 *
 * Plan §13.5 requires "正确的 semver resolution" for the model versions a
 * Corpus Package binds to. Before this module the only version handling on the
 * corpus side was `validateCorpusManifest`, which checks that
 * `manifest.models[name]` is a non-empty string
 * (`runtime/src/corpus-snapshot.ts:224-229`) — an exact pin that is never
 * parsed, let alone matched against a range.
 *
 * Implemented here rather than taken from the `semver` npm package on purpose:
 * this repo declares zero runtime dependencies beyond `yaml`, `zod` and the MCP
 * SDK, and a version comparator that a boot-time gate fails closed on should be
 * readable in the tree that depends on it. The supported grammar is stated
 * exhaustively below and anything outside it is a parse error rather than a
 * silent accept — a range nobody can parse must never resolve to "any version".
 */

/** A parsed strict SemVer. Build metadata is parsed and then ignored in ordering, per SemVer §10. */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; empty for a release version. */
  readonly prerelease: readonly (string | number)[];
  readonly build?: string;
  /** The exact input, so diagnostics can quote what was written. */
  readonly raw: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export class SemVerError extends Error {
  constructor(readonly code: "INVALID_VERSION" | "INVALID_RANGE", message: string) {
    super(message);
    this.name = "SemVerError";
  }
}

export function parseSemVer(input: string): SemVer {
  const match = SEMVER.exec(input.trim());
  if (match === null) throw new SemVerError("INVALID_VERSION", `not a strict SemVer version: "${input}"`);
  const [, major, minor, patch, prerelease, build] = match;
  return {
    major: Number(major), minor: Number(minor), patch: Number(patch),
    prerelease: prerelease === undefined
      ? []
      : prerelease.split(".").map(part => (/^(?:0|[1-9]\d*)$/.test(part) ? Number(part) : part)),
    ...(build === undefined ? {} : { build }),
    raw: input.trim(),
  };
}

export function tryParseSemVer(input: string): SemVer | undefined {
  try { return parseSemVer(input); } catch { return undefined; }
}

function comparePrerelease(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  // SemVer §11.3: a version with a prerelease has lower precedence than one without.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    // §11.4.4: a larger set of fields has higher precedence when all preceding are equal.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = typeof a === "number";
    const numericB = typeof b === "number";
    if (numericA && numericB) { if (a !== b) return a < b ? -1 : 1; continue; }
    // §11.4.3: numeric identifiers always have lower precedence than alphanumeric ones.
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (a !== b) return (a as string) < (b as string) ? -1 : 1;
  }
  return 0;
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

type Operator = "<" | "<=" | ">" | ">=" | "=";

interface Comparator {
  readonly operator: Operator;
  readonly version: SemVer;
}

/**
 * A conjunction of comparators (one whitespace-separated clause of a range),
 * plus whether the clause was written with an explicit prerelease. A range
 * written without one must not select a prerelease build, which is the rule that
 * stops `^1.0.0` from resolving to `2.0.0-rc.1`.
 */
interface Clause {
  readonly comparators: readonly Comparator[];
  readonly allowsPrerelease: boolean;
}

/** A parsed range: a disjunction (`||`) of conjunctive clauses. */
export interface VersionRange {
  readonly clauses: readonly Clause[];
  readonly raw: string;
}

const PARTIAL = /^(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*])(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)?)?$/;

interface Partial {
  readonly major?: number;
  readonly minor?: number;
  readonly patch?: number;
  readonly prerelease?: string;
}

function parsePartial(token: string, raw: string): Partial {
  const match = PARTIAL.exec(token);
  if (match === null) throw new SemVerError("INVALID_RANGE", `unparsable version in range "${raw}": "${token}"`);
  const wild = (part: string | undefined): number | undefined =>
    part === undefined || part === "x" || part === "X" || part === "*" ? undefined : Number(part);
  const major = wild(match[1]);
  const minor = major === undefined ? undefined : wild(match[2]);
  const patch = minor === undefined ? undefined : wild(match[3]);
  return {
    ...(major === undefined ? {} : { major }),
    ...(minor === undefined ? {} : { minor }),
    ...(patch === undefined ? {} : { patch }),
    ...(match[4] === undefined || patch === undefined ? {} : { prerelease: match[4] }),
  };
}

function versionOf(partial: Partial, fill: 0): SemVer {
  const raw = `${partial.major ?? fill}.${partial.minor ?? fill}.${partial.patch ?? fill}${partial.prerelease === undefined ? "" : `-${partial.prerelease}`}`;
  return parseSemVer(raw);
}

function lowerBound(partial: Partial): Comparator {
  return { operator: ">=", version: versionOf(partial, 0) };
}

/** Exclusive upper bound implied by however many fields a partial actually pinned. */
function upperBound(partial: Partial): Comparator | undefined {
  if (partial.major === undefined) return undefined;
  if (partial.minor === undefined) return { operator: "<", version: parseSemVer(`${partial.major + 1}.0.0`) };
  if (partial.patch === undefined) return { operator: "<", version: parseSemVer(`${partial.major}.${partial.minor + 1}.0`) };
  return undefined;
}

function caretBound(partial: Partial): Comparator {
  // ^0.x and ^0.0.x narrow, matching npm: the leftmost non-zero field is the one held.
  const major = partial.major ?? 0;
  if (major !== 0) return { operator: "<", version: parseSemVer(`${major + 1}.0.0`) };
  if (partial.minor === undefined) return { operator: "<", version: parseSemVer("1.0.0") };
  if (partial.minor !== 0) return { operator: "<", version: parseSemVer(`0.${partial.minor + 1}.0`) };
  if (partial.patch === undefined) return { operator: "<", version: parseSemVer("0.1.0") };
  return { operator: "<", version: parseSemVer(`0.0.${partial.patch + 1}`) };
}

function tildeBound(partial: Partial): Comparator {
  const major = partial.major ?? 0;
  if (partial.minor === undefined) return { operator: "<", version: parseSemVer(`${major + 1}.0.0`) };
  return { operator: "<", version: parseSemVer(`${major}.${partial.minor + 1}.0`) };
}

/**
 * Parse a range.
 *
 * Supported grammar, exhaustively:
 * ```
 *   range      := clause ( "||" clause )*
 *   clause     := "*" | comparator ( <space> comparator )* | partial "-" partial
 *   comparator := ( ">=" | "<=" | ">" | "<" | "=" | "^" | "~" )? partial
 *   partial    := major [ "." minor [ "." patch [ "-" prerelease ] ] ]     (x / X / * wildcards)
 * ```
 * Anything else throws. There is no "be liberal and hope" path.
 */
export function parseRange(input: string): VersionRange {
  const raw = input.trim();
  if (raw === "") throw new SemVerError("INVALID_RANGE", "range must not be empty");
  const clauses = raw.split("||").map(part => parseClause(part.trim(), raw));
  return { clauses, raw };
}

function parseClause(text: string, raw: string): Clause {
  if (text === "") throw new SemVerError("INVALID_RANGE", `empty clause in range "${raw}"`);
  if (text === "*" || text === "x" || text === "X") return { comparators: [], allowsPrerelease: false };
  const hyphen = / - /.exec(text);
  if (hyphen !== null) {
    const left = parsePartial(text.slice(0, hyphen.index).trim(), raw);
    const rightText = text.slice(hyphen.index + 3).trim();
    const right = parsePartial(rightText, raw);
    const upper = upperBound(right);
    return {
      comparators: [lowerBound(left), upper ?? { operator: "<=", version: versionOf(right, 0) }],
      allowsPrerelease: left.prerelease !== undefined || right.prerelease !== undefined,
    };
  }
  const comparators: Comparator[] = [];
  let allowsPrerelease = false;
  for (const token of text.split(/\s+/).filter(t => t.length > 0)) {
    const operatorMatch = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)!;
    const operator = operatorMatch[1] ?? "";
    const body = operatorMatch[2]!;
    if (body === "") throw new SemVerError("INVALID_RANGE", `comparator "${token}" in range "${raw}" names no version`);
    const partial = parsePartial(body, raw);
    if (partial.prerelease !== undefined) allowsPrerelease = true;
    if (operator === "^") { comparators.push(lowerBound(partial), caretBound(partial)); continue; }
    if (operator === "~") { comparators.push(lowerBound(partial), tildeBound(partial)); continue; }
    if (operator === ">" || operator === "<" || operator === ">=" || operator === "<=") {
      comparators.push({ operator, version: versionOf(partial, 0) });
      continue;
    }
    // Bare or `=` partial: an unpinned field widens into a range rather than
    // being filled with 0, so `1.2` means ">=1.2.0 <1.3.0" and not "=1.2.0".
    const upper = upperBound(partial);
    if (upper === undefined) comparators.push({ operator: "=", version: versionOf(partial, 0) });
    else comparators.push(lowerBound(partial), upper);
  }
  if (comparators.length === 0) throw new SemVerError("INVALID_RANGE", `clause "${text}" in range "${raw}" has no comparator`);
  return { comparators, allowsPrerelease };
}

function satisfiesComparator(version: SemVer, comparator: Comparator): boolean {
  const ordering = compareSemVer(version, comparator.version);
  switch (comparator.operator) {
    case "<": return ordering < 0;
    case "<=": return ordering <= 0;
    case ">": return ordering > 0;
    case ">=": return ordering >= 0;
    case "=": return ordering === 0;
  }
}

function satisfiesClause(version: SemVer, clause: Clause): boolean {
  if (clause.comparators.length === 0) return version.prerelease.length === 0;
  if (version.prerelease.length > 0 && !clause.allowsPrerelease) {
    // npm's rule: a prerelease is only ever in range when some comparator in the
    // same clause pinned the identical [major, minor, patch] with a prerelease.
    const tupleMatch = clause.comparators.some(c =>
      c.version.prerelease.length > 0
      && c.version.major === version.major && c.version.minor === version.minor && c.version.patch === version.patch);
    if (!tupleMatch) return false;
  }
  return clause.comparators.every(c => satisfiesComparator(version, c));
}

export function satisfies(version: SemVer | string, range: VersionRange | string): boolean {
  const parsedVersion = typeof version === "string" ? parseSemVer(version) : version;
  const parsedRange = typeof range === "string" ? parseRange(range) : range;
  return parsedRange.clauses.some(clause => satisfiesClause(parsedVersion, clause));
}

export interface ResolutionSuccess {
  readonly ok: true;
  /** Highest available version satisfying the range. */
  readonly version: SemVer;
  /** Every satisfying candidate, highest first — surfaced so a lock can record what it chose over. */
  readonly candidates: readonly SemVer[];
}

export interface ResolutionFailure {
  readonly ok: false;
  readonly code: "NO_MATCHING_VERSION" | "NO_CANDIDATES";
  readonly message: string;
  /** Everything that was offered, highest first. */
  readonly available: readonly SemVer[];
}

export type Resolution = ResolutionSuccess | ResolutionFailure;

/**
 * Resolve a range against the versions actually available, choosing the highest
 * match. Fails closed: an empty candidate set or no match is a diagnostic, never
 * a fallback to "whatever was first".
 */
export function resolveVersion(range: VersionRange | string, available: readonly (SemVer | string)[]): Resolution {
  const parsedRange = typeof range === "string" ? parseRange(range) : range;
  const versions = [...available]
    .map(entry => (typeof entry === "string" ? parseSemVer(entry) : entry))
    .sort((a, b) => compareSemVer(b, a));
  if (versions.length === 0) {
    return { ok: false, code: "NO_CANDIDATES", message: `no version is available to satisfy "${parsedRange.raw}"`, available: [] };
  }
  const candidates = versions.filter(version => satisfies(version, parsedRange));
  const best = candidates[0];
  if (best === undefined) {
    return {
      ok: false, code: "NO_MATCHING_VERSION",
      message: `no available version satisfies "${parsedRange.raw}" (available: ${versions.map(v => v.raw).join(", ")})`,
      available: versions,
    };
  }
  return { ok: true, version: best, candidates };
}
