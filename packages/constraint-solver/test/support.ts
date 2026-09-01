/** Synthetic fixtures. Every name is neutral on purpose: no relation or type name from any domain. */
import type { GraphEdgeIR, RelationDefIR, RelationSemanticsIR, SnapshotRef, UnitIR, ValueIR } from "@aoe/ir";

export const snapshot: SnapshotRef = { modelRelease: "m-1", modelDigest: "md-1", corpusRelease: "c-1", corpusDigest: "cd-1" };

export function semantics(overrides: Partial<RelationSemanticsIR> = {}): RelationSemanticsIR {
  return { traversal: "none", selection: "informational", loadOrder: "none", cyclePolicy: "allow", conflictSeverity: "none", ...overrides };
}

export function relation(name: string, view: Partial<RelationSemanticsIR> = {}): RelationDefIR {
  // `cardinality` and `directional` are stated because the IR requires them; the
  // solver reads neither, so a fixture that varied them would prove nothing.
  return { name, version: "1.0.0", from: "t-1", to: "t-1", cardinality: "many-to-many", directional: true, semantics: { ...semantics(view) } };
}

export function relations(...entries: readonly RelationDefIR[]): Readonly<Record<string, RelationDefIR>> {
  return Object.fromEntries(entries.map(entry => [entry.name, entry]));
}

export function unit(id: string, policyLabels: readonly string[] = []): UnitIR {
  return {
    identity: { id, version: "1.0.0", digest: `d-${id}`, corpus: "c-1" },
    typeRef: "t-1",
    implements: [],
    fields: {},
    relations: [],
    citations: [],
    policyLabels,
    lifecycle: "active",
    visibility: "public",
    provenance: { source: { loc: { line: 1, column: 1, offset: 0 } } },
    projections: {},
  };
}

export function edge(id: string, relationRef: string, from: string, to: string, attributes?: Readonly<Record<string, ValueIR>>): GraphEdgeIR {
  return attributes === undefined ? { id, relationRef, from, to } : { id, relationRef, from, to, attributes };
}
