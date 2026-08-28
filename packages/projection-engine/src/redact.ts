/**
 * Field-level redaction (plan §12.3: "Secret 不进入 event payload" / output).
 *
 * What counts as a secret is a *policy* question, so the label vocabulary is
 * supplied by the caller from model/policy data. This module knows only how to
 * apply a rule set — it contains no label names, no field names, and no notion
 * of which domain fields are sensitive.
 *
 * Redaction is applied to both the structured fields and the rendered text of a
 * projection, because a secret that is scrubbed from `fields` but left in
 * `content` is still disclosed.
 */

import type { TypedValueIR, UnitIR } from "@skill-wiki/ir";

/** One policy rule: when a unit carries `label`, treat these fields as secret. */
export interface RedactionRule {
  readonly label: string;
  /** Field paths, dot-joined. `"*"` denies the whole unit body. */
  readonly fields: readonly string[];
  /** Replacement marker. Defaults to `REDACTION_MARKER`. */
  readonly replacement?: string;
}

export const REDACTION_MARKER = "[redacted]";

export interface RedactionPolicy {
  readonly rules: readonly RedactionRule[];
}

export interface RedactionOutcome<T> {
  readonly value: T;
  /** Dot-joined paths actually removed, sorted. Evidence for the audit trail. */
  readonly redactedPaths: readonly string[];
  /** Labels that triggered at least one removal, sorted. */
  readonly appliedLabels: readonly string[];
}

const WILDCARD = "*";

interface ActiveRule {
  readonly label: string;
  readonly field: string;
  readonly replacement: string;
}

/** Only rules whose label the unit actually carries are in force. */
function activeRules(policy: RedactionPolicy, labels: readonly string[]): readonly ActiveRule[] {
  const held = new Set(labels);
  const active: ActiveRule[] = [];
  for (const rule of policy.rules) {
    if (!held.has(rule.label)) continue;
    for (const field of rule.fields) {
      active.push({ label: rule.label, field, replacement: rule.replacement ?? REDACTION_MARKER });
    }
  }
  return active;
}

/**
 * A rule on `a.b` must also remove `a.b.c`: redacting a parent and leaking its
 * children is the classic partial-redaction bug.
 */
function matches(rule: string, path: string): boolean {
  if (rule === WILDCARD) return true;
  return path === rule || path.startsWith(`${rule}.`);
}

function redactValue(value: TypedValueIR, replacement: string): TypedValueIR {
  return { kind: "string", value: replacement, source: value.source };
}

export function redactUnitFields(
  unit: UnitIR,
  policy: RedactionPolicy,
): RedactionOutcome<Readonly<Record<string, TypedValueIR>>> {
  const rules = activeRules(policy, unit.policyLabels);
  if (rules.length === 0) {
    return { value: unit.fields, redactedPaths: [], appliedLabels: [] };
  }
  const redactedPaths = new Set<string>();
  const appliedLabels = new Set<string>();

  const walk = (
    fields: Readonly<Record<string, TypedValueIR>>,
    prefix: string,
  ): Readonly<Record<string, TypedValueIR>> => {
    const output: Record<string, TypedValueIR> = {};
    for (const [key, value] of Object.entries(fields)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const hit = rules.find((rule) => matches(rule.field, path));
      if (hit) {
        redactedPaths.add(path);
        appliedLabels.add(hit.label);
        output[key] = redactValue(value, hit.replacement);
        continue;
      }
      // Descend so a rule on a nested path still reaches it.
      if (value.kind === "object") {
        output[key] = { ...value, fields: walk(value.fields, path) };
        continue;
      }
      output[key] = value;
    }
    return output;
  };

  return {
    value: walk(unit.fields, ""),
    redactedPaths: [...redactedPaths].sort(),
    appliedLabels: [...appliedLabels].sort(),
  };
}

/**
 * Scrub rendered text. Only literal values that were actually redacted are
 * removed, so this cannot invent matches from unrelated fields.
 */
export function redactText(
  content: string,
  unit: UnitIR,
  policy: RedactionPolicy,
): RedactionOutcome<string> {
  const rules = activeRules(policy, unit.policyLabels);
  if (rules.length === 0) return { value: content, redactedPaths: [], appliedLabels: [] };

  const redactedPaths = new Set<string>();
  const appliedLabels = new Set<string>();
  let output = content;

  const walk = (fields: Readonly<Record<string, TypedValueIR>>, prefix: string): void => {
    for (const [key, value] of Object.entries(fields)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const hit = rules.find((rule) => matches(rule.field, path));
      if (hit) {
        redactedPaths.add(path);
        appliedLabels.add(hit.label);
        for (const literal of literalsOf(value)) {
          if (literal === "") continue;
          output = output.split(literal).join(hit.replacement);
        }
        continue;
      }
      if (value.kind === "object") walk(value.fields, path);
    }
  };

  walk(unit.fields, "");
  return { value: output, redactedPaths: [...redactedPaths].sort(), appliedLabels: [...appliedLabels].sort() };
}

/** Every scalar literal reachable from a value, so nested secrets are covered. */
function literalsOf(value: TypedValueIR): readonly string[] {
  switch (value.kind) {
    case "string":
      return [value.value];
    case "number":
    case "boolean":
      return [String(value.value)];
    case "reference":
      return [value.target];
    case "array":
      return value.items.flatMap(literalsOf);
    case "object":
      return Object.values(value.fields).flatMap(literalsOf);
  }
}
