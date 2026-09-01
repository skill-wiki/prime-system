/**
 * @module values
 *
 * Generic access into `UnitIR.fields`. The engine cannot know a model's field
 * names, so it only ever walks a caller-supplied path or harvests *every*
 * reachable string. Both operations are total: an absent path yields nothing
 * rather than an error, because a facet over a field a unit lacks is a
 * non-match, not a fault.
 */

import type { TypedValueIR, ValueIR } from "@aoe/ir";

/**
 * Resolve a field path to the values it addresses. Arrays are traversed rather
 * than indexed, so a path into a list of objects returns one value per element —
 * which is what a facet over a repeated field means.
 */
export function resolvePath(
  fields: Readonly<Record<string, TypedValueIR>>,
  path: readonly string[],
): readonly TypedValueIR[] {
  if (path.length === 0) return [];
  const head = fields[path[0]!];
  if (head === undefined) return [];
  return descend([head], path.slice(1));
}

function descend(current: readonly TypedValueIR[], path: readonly string[]): readonly TypedValueIR[] {
  if (path.length === 0) return current;
  const key = path[0]!;
  const next: TypedValueIR[] = [];
  for (const value of current) {
    if (value.kind === "array") {
      for (const item of descend(value.items, path)) next.push(item);
    } else if (value.kind === "object") {
      const child = value.fields[key];
      if (child !== undefined) next.push(child);
    }
  }
  return path.length === 1 ? next : descend(next, path.slice(1));
}

/**
 * Compare a typed field value against a plain IR value. A `reference` matches on
 * its resolved `target` so a facet can name a related unit id without the caller
 * having to know the value is stored as a reference node.
 */
export function typedValueMatches(value: TypedValueIR, expected: ValueIR): boolean {
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean":
      return value.value === expected;
    case "reference":
      return value.target === expected;
    case "array":
      return value.items.some(item => typedValueMatches(item, expected));
    case "object":
      return false;
  }
}

/** Every string reachable from a typed value, including reference targets. */
export function collectStrings(value: TypedValueIR, out: string[]): void {
  switch (value.kind) {
    case "string":
      out.push(value.value);
      return;
    case "number":
    case "boolean":
      out.push(String(value.value));
      return;
    case "reference":
      out.push(value.target);
      for (const segment of value.path) out.push(segment);
      return;
    case "array":
      for (const item of value.items) collectStrings(item, out);
      return;
    case "object":
      // Object *keys* are model-declared field names, not content: indexing them
      // would let a schema rename change every relevance score.
      for (const key of Object.keys(value.fields).sort()) collectStrings(value.fields[key]!, out);
      return;
  }
}
