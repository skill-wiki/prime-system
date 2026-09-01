/**
 * Turns a graph plus its relation semantics into the four constraint classes.
 *
 * Every decision here reads a narrowed `RelationSemanticsIR` field. There is no
 * table of relation names anywhere: two relations with identical semantics are
 * indistinguishable to this module, which is the whole point of the refactor.
 */
import type { DiagnosticIR, GraphEdgeIR, RelationDefIR, RelationSemanticsIR, UnitIR } from "@aoe/ir";
import {
  type AdvisoryExclusion,
  type ConstraintSet,
  type HardProhibitionConstraint,
  type HardRequirementConstraint,
  type OrderingObligation,
  type RuntimePolicyConstraint,
  type SideEffect,
  type SoftPreferenceConstraint,
  orderingDirection,
  sortedPair,
} from "./constraints.ts";
import { readRelationSemantics } from "./semantics.ts";

/** What a policy label demands of the principal. Supplied by the caller, never inferred. */
export interface PolicyRequirement {
  readonly capabilities: readonly string[];
  readonly sideEffect: SideEffect;
}

export interface DeriveInput {
  readonly relations: Readonly<Record<string, RelationDefIR>>;
  readonly edges: readonly GraphEdgeIR[];
  readonly units: readonly UnitIR[];
  readonly policyRequirements?: Readonly<Record<string, PolicyRequirement>>;
  /** A label with no declared requirement denies by default: an undeclared policy is not a permissive one. */
  readonly undeclaredPolicyLabels?: "deny" | "ignore";
  readonly requestPreferences?: readonly { readonly unitId: string; readonly weight: number }[];
  /** Weight used for an `expand` edge that carries no numeric `weight` attribute. */
  readonly defaultExpansionWeight?: number;
}

export type DeriveResult =
  | { readonly ok: true; readonly constraints: ConstraintSet; readonly semantics: ReadonlyMap<string, RelationSemanticsIR>; readonly diagnostics: readonly DiagnosticIR[] }
  | { readonly ok: false; readonly diagnostics: readonly DiagnosticIR[] };

const UNDECLARED_LABEL_CAPABILITY = "__undeclared-policy-label__";

function info(code: string, message: string, path: readonly string[]): DiagnosticIR {
  return { code, message, path, severity: "info" };
}

function edgeSortKey(edge: GraphEdgeIR): string {
  return [edge.relationRef, edge.from, edge.to, edge.id].join("\u0000");
}

function readEdgeWeight(edge: GraphEdgeIR, fallback: number, diagnostics: DiagnosticIR[]): number | undefined {
  const raw = edge.attributes?.["weight"];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    diagnostics.push({ code: "EDGE_WEIGHT_INVALID", message: "Edge attribute 'weight' must be a finite number", path: ["edges", edge.id, "attributes", "weight"], severity: "error" });
    return undefined;
  }
  return raw;
}

export function deriveConstraints(input: DeriveInput): DeriveResult {
  const fatal: DiagnosticIR[] = [];
  const notes: DiagnosticIR[] = [];
  const semantics = new Map<string, RelationSemanticsIR>();
  for (const relationRef of Object.keys(input.relations).sort()) {
    const relation = input.relations[relationRef];
    if (relation === undefined) continue;
    const read = readRelationSemantics(relationRef, relation.semantics);
    if (read.ok) semantics.set(relationRef, read.value);
    else fatal.push(...read.diagnostics);
  }

  const seenEdgeIds = new Set<string>();
  const hardRequirements: HardRequirementConstraint[] = [];
  const hardProhibitions: HardProhibitionConstraint[] = [];
  const softPreferences: SoftPreferenceConstraint[] = [];
  const orderings: OrderingObligation[] = [];
  const advisories: AdvisoryExclusion[] = [];
  const fallbackWeight = input.defaultExpansionWeight ?? 1;
  if (!Number.isFinite(fallbackWeight)) fatal.push({ code: "DEFAULT_WEIGHT_INVALID", message: "defaultExpansionWeight must be a finite number", path: ["defaultExpansionWeight"], severity: "error" });

  const edges = [...input.edges].sort((a, b) => (edgeSortKey(a) < edgeSortKey(b) ? -1 : edgeSortKey(a) > edgeSortKey(b) ? 1 : 0));
  for (const edge of edges) {
    if (seenEdgeIds.has(edge.id)) {
      fatal.push({ code: "EDGE_ID_DUPLICATE", message: `Edge id '${edge.id}' is not unique; constraint refs would collide`, path: ["edges", edge.id], severity: "error" });
      continue;
    }
    seenEdgeIds.add(edge.id);
    const view = semantics.get(edge.relationRef);
    if (view === undefined) {
      // Fail closed: an edge whose relation semantics are unknown or unreadable
      // must not be silently treated as informational.
      fatal.push({ code: "EDGE_RELATION_UNRESOLVED", message: `Edge '${edge.id}' names relation '${edge.relationRef}', which has no readable semantics`, path: ["edges", edge.id, "relationRef"], severity: "error" });
      continue;
    }
    if (view.selection === "closure") {
      if (view.traversal === "none") notes.push(info("SELECTION_WITHOUT_TRAVERSAL", `Relation '${edge.relationRef}' selects a closure but never traverses; edge '${edge.id}' adds nothing`, ["edges", edge.id]));
      else hardRequirements.push({ kind: "hard-requirement", ref: `hr:${edge.id}`, relationRef: edge.relationRef, edgeId: edge.id, subject: edge.from, target: edge.to, traversal: view.traversal });
    } else if (view.selection === "expand") {
      if (view.traversal === "none") notes.push(info("SELECTION_WITHOUT_TRAVERSAL", `Relation '${edge.relationRef}' expands but never traverses; edge '${edge.id}' adds nothing`, ["edges", edge.id]));
      else {
        const weight = readEdgeWeight(edge, fallbackWeight, fatal);
        if (weight !== undefined) softPreferences.push({ kind: "soft-preference", ref: `sp:${edge.id}`, relationRef: edge.relationRef, edgeId: edge.id, subject: edge.from, target: edge.to, weight });
      }
    } else if (view.selection === "exclude") {
      const [left, right] = sortedPair(edge.from, edge.to);
      if (view.traversal === "transitive") notes.push(info("EXCLUSION_IS_PAIRWISE", `Relation '${edge.relationRef}' declares transitive traversal; exclusion is enforced on the declared pair only`, ["edges", edge.id]));
      if (view.conflictSeverity === "error") hardProhibitions.push({ kind: "hard-prohibition", ref: `hp:${edge.id}`, relationRef: edge.relationRef, edgeId: edge.id, left, right });
      else advisories.push({ kind: "advisory-exclusion", ref: `ax:${edge.id}`, relationRef: edge.relationRef, edgeId: edge.id, left, right, severity: view.conflictSeverity });
    }
    if (view.loadOrder !== "none") {
      const { before, after } = orderingDirection(view.loadOrder, edge.from, edge.to);
      orderings.push({ kind: "ordering", ref: `ord:${edge.id}`, relationRef: edge.relationRef, edgeId: edge.id, before, after, cyclePolicy: view.cyclePolicy });
    }
  }

  const runtimePolicies: RuntimePolicyConstraint[] = [];
  const declared = input.policyRequirements ?? {};
  const undeclared = input.undeclaredPolicyLabels ?? "deny";
  for (const unit of [...input.units].sort((a, b) => (a.identity.id < b.identity.id ? -1 : a.identity.id > b.identity.id ? 1 : 0))) {
    for (const label of [...unit.policyLabels].sort()) {
      const requirement = declared[label];
      if (requirement !== undefined) runtimePolicies.push({ kind: "runtime-policy", ref: `rp:${unit.identity.id}:${label}`, target: unit.identity.id, label, capabilities: [...requirement.capabilities].sort(), sideEffect: requirement.sideEffect });
      else if (undeclared === "deny") {
        notes.push(info("POLICY_LABEL_UNDECLARED", `Unit '${unit.identity.id}' carries policy label '${label}' with no declared requirement; denying`, ["units", unit.identity.id, "policyLabels", label]));
        runtimePolicies.push({ kind: "runtime-policy", ref: `rp:${unit.identity.id}:${label}`, target: unit.identity.id, label, capabilities: [UNDECLARED_LABEL_CAPABILITY], sideEffect: "none" });
      }
    }
  }

  for (const preference of input.requestPreferences ?? []) {
    if (!Number.isFinite(preference.weight)) { fatal.push({ code: "PREFERENCE_WEIGHT_INVALID", message: `Preference weight for '${preference.unitId}' must be a finite number`, path: ["requestPreferences", preference.unitId], severity: "error" }); continue }
    softPreferences.push({ kind: "soft-preference", ref: `sp:request:${preference.unitId}`, target: preference.unitId, weight: preference.weight });
  }

  if (fatal.length > 0) return { ok: false, diagnostics: [...fatal, ...notes] };
  return {
    ok: true,
    semantics,
    diagnostics: notes,
    constraints: {
      hardRequirements,
      hardProhibitions,
      softPreferences: softPreferences.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
      runtimePolicies,
      orderings,
      advisories,
    },
  };
}

export { UNDECLARED_LABEL_CAPABILITY };
