/**
 * SPDX license expressions and corpus-level license policy.
 *
 * Why this exists as parsed structure rather than a string field: the corpora in
 * this repo are genuinely mixed-licence. Measured on the legacy source atoms
 * (`primes/atoms/*.md` frontmatter `source.license`):
 *
 * ```
 *   357 MIT · 165 GPL-3.0 · 136 MPL-2.0 · 77 Apache-2.0 · 19 non-SPDX prose
 * ```
 *
 * A single `license:` string cannot express that, and the two answers a corpus
 * owner actually needs from it — "may this corpus be redistributed under policy
 * P" and "which units force the answer to be no" — are conjunction/disjunction
 * questions. `GPL-3.0 AND MIT` and `GPL-3.0 OR MIT` have opposite verdicts under
 * a permissive-only policy, so the operator has to survive into the check.
 *
 * The grammar is the SPDX expression subset actually needed:
 * ```
 *   expression := term ( ("AND" | "OR") term )*
 *   term       := "(" expression ")" | licenseId [ "WITH" exceptionId ] | "NOASSERTION"
 * ```
 * `AND` binds tighter than `OR`, as SPDX Annex D specifies. Anything else — the
 * 19 prose values above included — parses as `NOASSERTION`-equivalent
 * `unparsable`, which a policy can then reject explicitly instead of silently
 * treating as compliant.
 */

export type LicenseExpression =
  | { readonly kind: "id"; readonly id: string; readonly orLater: boolean; readonly exception?: string }
  | { readonly kind: "and"; readonly operands: readonly LicenseExpression[] }
  | { readonly kind: "or"; readonly operands: readonly LicenseExpression[] }
  | { readonly kind: "unparsable"; readonly raw: string };

const IDENTIFIER = /^[A-Za-z0-9.+-]+$/;

interface Cursor { readonly tokens: readonly string[]; index: number }

function tokenize(input: string): readonly string[] {
  return input.replace(/([()])/g, " $1 ").split(/\s+/).filter(token => token.length > 0);
}

function parseExpression(cursor: Cursor, raw: string): LicenseExpression | undefined {
  const operands: LicenseExpression[] = [parseConjunction(cursor, raw) as LicenseExpression];
  if (operands[0] === undefined) return undefined;
  while (cursor.tokens[cursor.index]?.toUpperCase() === "OR") {
    cursor.index += 1;
    const next = parseConjunction(cursor, raw);
    if (next === undefined) return undefined;
    operands.push(next);
  }
  return operands.length === 1 ? operands[0]! : { kind: "or", operands };
}

function parseConjunction(cursor: Cursor, raw: string): LicenseExpression | undefined {
  const first = parseTerm(cursor, raw);
  if (first === undefined) return undefined;
  const operands: LicenseExpression[] = [first];
  while (cursor.tokens[cursor.index]?.toUpperCase() === "AND") {
    cursor.index += 1;
    const next = parseTerm(cursor, raw);
    if (next === undefined) return undefined;
    operands.push(next);
  }
  return operands.length === 1 ? operands[0]! : { kind: "and", operands };
}

function parseTerm(cursor: Cursor, raw: string): LicenseExpression | undefined {
  const token = cursor.tokens[cursor.index];
  if (token === undefined) return undefined;
  if (token === "(") {
    cursor.index += 1;
    const inner = parseExpression(cursor, raw);
    if (inner === undefined || cursor.tokens[cursor.index] !== ")") return undefined;
    cursor.index += 1;
    return inner;
  }
  if (token === ")" || /^(?:AND|OR|WITH)$/i.test(token)) return undefined;
  if (!IDENTIFIER.test(token)) return undefined;
  cursor.index += 1;
  const orLater = token.endsWith("+");
  const id = orLater ? token.slice(0, -1) : token;
  if (cursor.tokens[cursor.index]?.toUpperCase() === "WITH") {
    const exception = cursor.tokens[cursor.index + 1];
    if (exception === undefined || !IDENTIFIER.test(exception)) return undefined;
    cursor.index += 2;
    return { kind: "id", id, orLater, exception };
  }
  return { kind: "id", id, orLater };
}

/** Parse an SPDX expression. Unrecognisable input yields `unparsable`, never a throw. */
export function parseLicenseExpression(input: string): LicenseExpression {
  const raw = input.trim();
  if (raw === "" || raw.toUpperCase() === "NOASSERTION") return { kind: "unparsable", raw };
  const cursor: Cursor = { tokens: tokenize(raw), index: 0 };
  const parsed = parseExpression(cursor, raw);
  if (parsed === undefined || cursor.index !== cursor.tokens.length) return { kind: "unparsable", raw };
  return parsed;
}

export function formatLicenseExpression(expression: LicenseExpression): string {
  switch (expression.kind) {
    case "id": return `${expression.id}${expression.orLater ? "+" : ""}${expression.exception === undefined ? "" : ` WITH ${expression.exception}`}`;
    case "and": return expression.operands.map(operand => wrap(operand, "and")).join(" AND ");
    case "or": return expression.operands.map(operand => wrap(operand, "or")).join(" OR ");
    case "unparsable": return expression.raw;
  }
}

function wrap(expression: LicenseExpression, parent: "and" | "or"): string {
  const needsParens = parent === "and" && expression.kind === "or";
  return needsParens ? `(${formatLicenseExpression(expression)})` : formatLicenseExpression(expression);
}

/** Every distinct license identifier mentioned anywhere in the expression. */
export function licenseIdentifiers(expression: LicenseExpression): readonly string[] {
  switch (expression.kind) {
    case "id": return [expression.id];
    case "and": case "or": return [...new Set(expression.operands.flatMap(licenseIdentifiers))];
    case "unparsable": return [];
  }
}

export interface LicensePolicy {
  /** Identifiers this corpus may redistribute. Empty means "no allow-list declared". */
  readonly allow: readonly string[];
  /** Identifiers that are refused even when they also appear in `allow`. */
  readonly deny: readonly string[];
  /** Whether a unit or source set with no declared license is a violation. */
  readonly requireDeclared: boolean;
  /**
   * Whether an expression that names licences outside `allow` may still pass
   * because an `OR` branch is inside it. `false` is the conservative reading and
   * the default: the downstream consumer, not the corpus, picks the branch.
   */
  readonly allowDisjunctiveEscape: boolean;
}

export type LicenseVerdict =
  | { readonly ok: true; readonly satisfyingBranch: string }
  | { readonly ok: false; readonly code: "LICENSE_UNPARSABLE" | "LICENSE_DENIED" | "LICENSE_NOT_ALLOWED"; readonly message: string; readonly offending: readonly string[] };

/**
 * Evaluate one expression against a policy.
 *
 * `AND` requires every operand to pass, `OR` requires one — that asymmetry is
 * the whole reason the expression is parsed. A denied identifier anywhere in an
 * `AND` chain sinks the chain even if the rest is permissive, because a
 * conjunctive obligation cannot be dropped.
 */
export function evaluateLicense(expression: LicenseExpression, policy: LicensePolicy): LicenseVerdict {
  const deny = new Set(policy.deny);
  const allow = new Set(policy.allow);

  const walk = (node: LicenseExpression): LicenseVerdict => {
    switch (node.kind) {
      case "unparsable":
        return { ok: false, code: "LICENSE_UNPARSABLE", message: `license is not an SPDX expression: "${node.raw}"`, offending: [node.raw] };
      case "id": {
        if (deny.has(node.id)) return { ok: false, code: "LICENSE_DENIED", message: `license is on the deny list: ${node.id}`, offending: [node.id] };
        if (allow.size > 0 && !allow.has(node.id))
          return { ok: false, code: "LICENSE_NOT_ALLOWED", message: `license is outside the allow list: ${node.id}`, offending: [node.id] };
        return { ok: true, satisfyingBranch: formatLicenseExpression(node) };
      }
      case "and": {
        const failures = node.operands.map(walk).filter((verdict): verdict is Extract<LicenseVerdict, { ok: false }> => !verdict.ok);
        const first = failures[0];
        if (first !== undefined)
          return { ...first, message: `conjunctive license ${formatLicenseExpression(node)} cannot be satisfied: ${first.message}`, offending: failures.flatMap(f => f.offending) };
        return { ok: true, satisfyingBranch: formatLicenseExpression(node) };
      }
      case "or": {
        const verdicts = node.operands.map(walk);
        const satisfied = verdicts.find((verdict): verdict is Extract<LicenseVerdict, { ok: true }> => verdict.ok);
        if (satisfied !== undefined && policy.allowDisjunctiveEscape) return satisfied;
        if (satisfied !== undefined)
          return {
            ok: false, code: "LICENSE_NOT_ALLOWED",
            message: `disjunctive license ${formatLicenseExpression(node)} has a satisfying branch (${satisfied.satisfyingBranch}) but allowDisjunctiveEscape is false, so the choice must be recorded explicitly`,
            offending: verdicts.flatMap(verdict => (verdict.ok ? [] : verdict.offending)),
          };
        const failures = verdicts.filter((verdict): verdict is Extract<LicenseVerdict, { ok: false }> => !verdict.ok);
        return {
          ok: false, code: failures.every(f => f.code === "LICENSE_DENIED") ? "LICENSE_DENIED" : "LICENSE_NOT_ALLOWED",
          message: `no branch of ${formatLicenseExpression(node)} satisfies the policy`,
          offending: failures.flatMap(f => f.offending),
        };
      }
    }
  };
  return walk(expression);
}
