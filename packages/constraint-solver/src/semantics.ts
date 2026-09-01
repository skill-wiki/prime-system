/**
 * The runtime witness of the semantics vocabulary that `@aoe/ir` types.
 *
 * `RelationSemanticsIR` states the closed five-field set once, for every engine.
 * That type is a claim about a JSON payload, not a check of it: an IR value that
 * arrived from a transport, a file or a `JSON.parse` is typed by assertion, so the
 * solver still has to check it before deciding anything. This module is where that
 * check lives, and the arrays below are the only executable copy of the value sets
 * — kept honest against the IR unions by the witnesses at the bottom of the file.
 *
 * The vocabulary is protocol vocabulary, not domain vocabulary: no relation name
 * and no type name appears in this package.
 */
import type {
  ConflictSeverityIR,
  CyclePolicyIR,
  DiagnosticIR,
  LoadOrderIR,
  RelationSemanticsIR,
  SelectionSemanticsIR,
  TraversalIR,
  ValueIR,
} from "@aoe/ir";

export const TRAVERSAL_VALUES = ["none", "one-hop", "transitive"] as const;
export const SELECTION_VALUES = ["informational", "expand", "closure", "exclude"] as const;
export const LOAD_ORDER_VALUES = ["none", "before", "after"] as const;
export const CYCLE_POLICY_VALUES = ["allow", "reject", "collapse"] as const;
export const CONFLICT_SEVERITY_VALUES = ["none", "warning", "error"] as const;

/** Field name -> its closed value set. Used for both narrowing and unknown-key rejection. */
const FIELD_VALUES = {
  traversal: TRAVERSAL_VALUES,
  selection: SELECTION_VALUES,
  loadOrder: LOAD_ORDER_VALUES,
  cyclePolicy: CYCLE_POLICY_VALUES,
  conflictSeverity: CONFLICT_SEVERITY_VALUES,
} as const satisfies { readonly [K in keyof RelationSemanticsIR]: readonly RelationSemanticsIR[K][] };

/**
 * Compile-time proof that the executable value sets and the IR unions have not
 * drifted apart. `satisfies` above catches an array holding a value the IR does not
 * allow; this catches the other direction — an IR union member no array offers,
 * which would make `readRelationSemantics` reject a legal model.
 */
type Missing<K extends keyof RelationSemanticsIR> = Exclude<RelationSemanticsIR[K], (typeof FIELD_VALUES)[K][number]>;
type _NoMissingValue = { readonly [K in keyof RelationSemanticsIR]: Missing<K> extends never ? true : Missing<K> };
const _valueSetsAreExhaustive: _NoMissingValue = { traversal: true, selection: true, loadOrder: true, cyclePolicy: true, conflictSeverity: true };
void _valueSetsAreExhaustive;

const FIELD_NAMES = Object.keys(FIELD_VALUES).sort() as readonly (keyof RelationSemanticsIR)[];

export type SemanticsReadResult =
  | { readonly ok: true; readonly value: RelationSemanticsIR }
  | { readonly ok: false; readonly diagnostics: readonly DiagnosticIR[] };

function member<T extends string>(values: readonly T[], raw: ValueIR | undefined): T | undefined {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

function invalid(relationRef: string, field: string, message: string): DiagnosticIR {
  return { code: "RELATION_SEMANTICS_INVALID", message, path: ["relations", relationRef, "semantics", field], severity: "error" };
}

/**
 * Fail closed: an unreadable or over-specified semantics block yields diagnostics
 * rather than a defaulted view, because a silently defaulted `conflictSeverity`
 * would turn a blocking conflict into a passing plan.
 */
/**
 * Fail closed: an unreadable or over-specified semantics block yields diagnostics
 * rather than a defaulted view, because a silently defaulted `conflictSeverity`
 * would turn a blocking conflict into a passing plan.
 *
 * The parameter is `unknown` on purpose. Taking a `RelationDefIR` would let the
 * caller's static type stand in for the check, which is precisely the mistake this
 * function exists to prevent now that `RelationDefIR.semantics` is typed.
 */
export function readRelationSemantics(relationRef: string, semantics: unknown): SemanticsReadResult {
  if (semantics === undefined || semantics === null || typeof semantics !== "object" || Array.isArray(semantics)) {
    return { ok: false, diagnostics: [{ code: "RELATION_SEMANTICS_INVALID", message: "Relation semantics must be an object", path: ["relations", relationRef, "semantics"], severity: "error" }] };
  }
  const raw = semantics as Readonly<Record<string, ValueIR>>;
  const diagnostics: DiagnosticIR[] = [];
  for (const key of Object.keys(raw).sort()) {
    if (!(FIELD_NAMES as readonly string[]).includes(key)) diagnostics.push({ code: "RELATION_SEMANTICS_UNKNOWN_FIELD", message: `Unknown semantics field '${key}'`, path: ["relations", relationRef, "semantics", key], severity: "error" });
  }
  const narrowed: Partial<Record<keyof RelationSemanticsIR, string>> = {};
  for (const field of FIELD_NAMES) {
    const value = member(FIELD_VALUES[field], raw[field]);
    if (value === undefined) diagnostics.push(invalid(relationRef, field, `Field '${field}' must be one of ${FIELD_VALUES[field].join(" | ")}`));
    else narrowed[field] = value;
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    value: {
      traversal: narrowed.traversal as TraversalIR,
      selection: narrowed.selection as SelectionSemanticsIR,
      loadOrder: narrowed.loadOrder as LoadOrderIR,
      cyclePolicy: narrowed.cyclePolicy as CyclePolicyIR,
      conflictSeverity: narrowed.conflictSeverity as ConflictSeverityIR,
    },
  };
}

/** `none` means the relation never hops; the other two differ in how far one step may chain. */
export function maxHops(traversal: TraversalIR): number {
  return traversal === "none" ? 0 : traversal === "one-hop" ? 1 : Number.POSITIVE_INFINITY;
}

/** Conflict severity is the model's own decision about whether a hit blocks or is merely recorded. */
export function severityOf(conflictSeverity: ConflictSeverityIR): DiagnosticIR["severity"] {
  return conflictSeverity === "error" ? "error" : conflictSeverity === "warning" ? "warning" : "info";
}
