/**
 * The solver. Selection is decided in strict class order:
 *
 *   1. hard requirements   -> the mandatory closure, never budget- or weight-gated
 *   2. hard prohibitions   -> a hit inside the mandatory closure is unsatisfiable
 *   3. runtime policies    -> principal / capability / side-effect, never scored
 *   4. soft preferences    -> only these compete for the remaining budget
 *
 * A soft preference can therefore only ever *lose*. It has no path by which to
 * admit a unit that a hard constraint forbids, which is the §17.3 invariant
 * "hard constraint is never overridden by weight".
 *
 * When the mandatory part is unsatisfiable the solver returns a minimal unsat
 * core: the candidate set is seeded from the blocker and its support chains, then
 * shrunk by deletion until every remaining ref is load-bearing.
 */
import type { ConstraintKindIR, ConstraintRefIR, DiagnosticIR, GraphEdgeIR, RelationDefIR, SelectionCandidateIR, SelectionPlanIR, SnapshotRef, UnitIR, ValueIR } from "@skill-wiki/ir";
import {
  type ConstraintRef,
  type ConstraintSet,
  type HardProhibitionConstraint,
  type HardRequirementConstraint,
  type OrderingObligation,
  type RuntimePolicyConstraint,
  type SideEffect,
  type SoftPreferenceConstraint,
} from "./constraints.ts";
import { type PolicyRequirement, deriveConstraints } from "./derive.ts";
import { type UnitComponent, planLoadOrder } from "./order.ts";
import { maxHops } from "./semantics.ts";

export interface PrincipalView {
  readonly capabilities: readonly string[];
  /** Fail closed: an unstated principal may only touch `none`. */
  readonly allowedSideEffects?: readonly SideEffect[];
}

export interface SolveRequest {
  readonly requestId: string;
  readonly snapshot: SnapshotRef;
  readonly relations: Readonly<Record<string, RelationDefIR>>;
  readonly units: readonly UnitIR[];
  readonly edges: readonly GraphEdgeIR[];
  /** Unit ids the caller demands. They are the problem statement, not constraints. */
  readonly mandatory: readonly string[];
  readonly preferences?: readonly { readonly unitId: string; readonly weight: number }[];
  readonly principal?: PrincipalView;
  readonly policyRequirements?: Readonly<Record<string, PolicyRequirement>>;
  readonly undeclaredPolicyLabels?: "deny" | "ignore";
  readonly defaultExpansionWeight?: number;
  readonly budget?: { readonly maxTokens: number };
  readonly unitCost?: Readonly<Record<string, number>>;
  readonly query?: Readonly<Record<string, ValueIR>>;
}

export type BlockerKind = "missing-target" | "hard-prohibition" | "runtime-policy" | "cycle";

/**
 * Compile-time proof that `ConstraintKindIR` still names exactly the classes that
 * can block a plan. If a new constraint class is added here, this stops compiling
 * rather than letting a core silently mis-label an entry.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type _CoreKindsAreTheBlockingClasses = Equals<ConstraintKindIR, Exclude<ConstraintSetKind, "soft-preference" | "advisory-exclusion">>;
const _coreKindsMatch: _CoreKindsAreTheBlockingClasses = true;
void _coreKindsMatch;

type ConstraintSetKind = "hard-requirement" | "hard-prohibition" | "runtime-policy" | "ordering" | "soft-preference" | "advisory-exclusion";

export type SolveResult =
  | { readonly ok: true; readonly plan: SelectionPlanIR; readonly order: readonly string[]; readonly components: readonly UnitComponent[]; readonly collapsedInto: Readonly<Record<string, string>>; readonly constraints: ConstraintSet; readonly diagnostics: readonly DiagnosticIR[] }
  | { readonly ok: false; readonly reason: "unsat"; readonly blocker: BlockerKind; readonly plan: SelectionPlanIR; readonly unsatCore: readonly ConstraintRefIR[]; readonly constraints: ConstraintSet; readonly diagnostics: readonly DiagnosticIR[] }
  | { readonly ok: false; readonly reason: "invalid-input"; readonly diagnostics: readonly DiagnosticIR[] };

interface ActiveSet {
  readonly hardRequirements: readonly HardRequirementConstraint[];
  readonly hardProhibitions: readonly HardProhibitionConstraint[];
  readonly runtimePolicies: readonly RuntimePolicyConstraint[];
  readonly orderings: readonly OrderingObligation[];
}

interface Blocker {
  readonly kind: BlockerKind;
  readonly refs: readonly ConstraintRef[];
  readonly diagnostic: DiagnosticIR;
}

interface ClosureOutcome {
  readonly included: readonly string[];
  readonly support: ReadonlyMap<string, readonly ConstraintRef[]>;
  readonly expansions: readonly { readonly relationRef: string; readonly from: string; readonly discovered: readonly string[]; readonly depth: number }[];
  readonly blocker?: Blocker;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function restrict(set: ConstraintSet, allowed: ReadonlySet<ConstraintRef> | null): ActiveSet {
  const keep = <T extends { readonly ref: ConstraintRef }>(items: readonly T[]): readonly T[] => (allowed === null ? items : items.filter(item => allowed.has(item.ref)));
  return { hardRequirements: keep(set.hardRequirements), hardProhibitions: keep(set.hardProhibitions), runtimePolicies: keep(set.runtimePolicies), orderings: keep(set.orderings) };
}

function permits(principal: PrincipalView | undefined, policy: RuntimePolicyConstraint): boolean {
  const granted = new Set(principal?.capabilities ?? []);
  const effects = new Set<SideEffect>(principal?.allowedSideEffects ?? ["none"]);
  return policy.capabilities.every(capability => granted.has(capability)) && effects.has(policy.sideEffect);
}

/**
 * Mandatory closure. `traversal` is enforced per relation: a unit reached by one
 * hop of relation R does not itself re-fire R, so `one-hop` cannot become
 * transitive by chaining, while a different relation may still hop from it.
 */
function closeOver(seeds: readonly string[], active: ActiveSet, universe: ReadonlySet<string>): ClosureOutcome {
  const bySubject = new Map<string, HardRequirementConstraint[]>();
  for (const requirement of [...active.hardRequirements].sort((a, b) => compare(a.ref, b.ref))) {
    const list = bySubject.get(requirement.subject);
    if (list === undefined) bySubject.set(requirement.subject, [requirement]); else list.push(requirement);
  }
  const support = new Map<string, readonly ConstraintRef[]>();
  const hops = new Map<string, Map<string, number>>();
  const included: string[] = [];
  let frontier = [...new Set(seeds)].sort(compare);
  for (const seed of frontier) { support.set(seed, []); included.push(seed) }
  const expansions: { readonly relationRef: string; readonly from: string; readonly discovered: readonly string[]; readonly depth: number }[] = [];
  const depthOf = (relationRef: string, unitId: string): number => hops.get(relationRef)?.get(unitId) ?? 0;
  const setDepth = (relationRef: string, unitId: string, depth: number): void => {
    const perRelation = hops.get(relationRef) ?? new Map<string, number>();
    perRelation.set(unitId, depth);
    hops.set(relationRef, perRelation);
  };
  const seen = new Set(included);
  while (frontier.length > 0) {
    const discovered = new Map<string, { readonly relationRef: string; readonly from: string; readonly depth: number }>();
    for (const subject of frontier) {
      for (const requirement of bySubject.get(subject) ?? []) {
        if (depthOf(requirement.relationRef, subject) >= maxHops(requirement.traversal)) continue;
        if (!universe.has(requirement.target)) {
          return {
            included: [...included].sort(compare),
            support,
            expansions,
            blocker: {
              kind: "missing-target",
              refs: [requirement.ref, ...(support.get(subject) ?? [])],
              diagnostic: { code: "HARD_REQUIREMENT_TARGET_MISSING", message: `Unit '${requirement.target}' demanded by '${subject}' is absent from the graph`, path: ["constraints", requirement.ref], severity: "error" },
            },
          };
        }
        if (seen.has(requirement.target)) continue;
        const existing = discovered.get(requirement.target);
        if (existing === undefined) {
          discovered.set(requirement.target, { relationRef: requirement.relationRef, from: subject, depth: depthOf(requirement.relationRef, subject) + 1 });
          support.set(requirement.target, [...(support.get(subject) ?? []), requirement.ref]);
        }
      }
    }
    const nextFrontier: string[] = [];
    const grouped = new Map<string, string[]>();
    for (const target of [...discovered.keys()].sort(compare)) {
      const origin = discovered.get(target);
      if (origin === undefined) continue;
      seen.add(target);
      included.push(target);
      nextFrontier.push(target);
      setDepth(origin.relationRef, target, origin.depth);
      const key = [origin.relationRef, origin.from, String(origin.depth)].join("\u0000");
      const list = grouped.get(key);
      if (list === undefined) grouped.set(key, [target]); else list.push(target);
    }
    for (const key of [...grouped.keys()].sort(compare)) {
      const [relationRef, from, depth] = key.split("\u0000");
      expansions.push({ relationRef, from, discovered: (grouped.get(key) ?? []).sort(compare), depth: Number(depth) });
    }
    frontier = nextFrontier.sort(compare);
  }
  return { included: [...included].sort(compare), support, expansions };
}

function firstProhibitionHit(active: ActiveSet, selected: ReadonlySet<string>): HardProhibitionConstraint | undefined {
  for (const prohibition of [...active.hardProhibitions].sort((a, b) => compare(a.ref, b.ref))) {
    if (selected.has(prohibition.left) && selected.has(prohibition.right)) return prohibition;
  }
  return undefined;
}

function firstPolicyDenial(active: ActiveSet, selected: ReadonlySet<string>, principal: PrincipalView | undefined): RuntimePolicyConstraint | undefined {
  for (const policy of [...active.runtimePolicies].sort((a, b) => compare(a.ref, b.ref))) {
    if (selected.has(policy.target) && !permits(principal, policy)) return policy;
  }
  return undefined;
}

/** One evaluation of the mandatory half of the problem under a constraint subset. */
function evaluate(seeds: readonly string[], active: ActiveSet, universe: ReadonlySet<string>, principal: PrincipalView | undefined): ClosureOutcome {
  const closure = closeOver(seeds, active, universe);
  if (closure.blocker !== undefined) return closure;
  const selected = new Set(closure.included);
  const support = closure.support;
  const chain = (unitId: string): readonly ConstraintRef[] => support.get(unitId) ?? [];
  const prohibition = firstProhibitionHit(active, selected);
  if (prohibition !== undefined) {
    return {
      ...closure,
      blocker: {
        kind: "hard-prohibition",
        refs: [prohibition.ref, ...chain(prohibition.left), ...chain(prohibition.right)],
        diagnostic: { code: "HARD_PROHIBITION_VIOLATED", message: `Units '${prohibition.left}' and '${prohibition.right}' may not co-occur`, path: ["constraints", prohibition.ref], severity: "error" },
      },
    };
  }
  const denial = firstPolicyDenial(active, selected, principal);
  if (denial !== undefined) {
    return {
      ...closure,
      blocker: {
        kind: "runtime-policy",
        refs: [denial.ref, ...chain(denial.target)],
        diagnostic: { code: "RUNTIME_POLICY_DENIED", message: `Principal may not load '${denial.target}' under policy label '${denial.label}'`, path: ["constraints", denial.ref], severity: "error" },
      },
    };
  }
  const ordering = planLoadOrder(closure.included, active.orderings);
  if (!ordering.ok) {
    return {
      ...closure,
      blocker: {
        kind: "cycle",
        refs: [...ordering.cycle.refs, ...ordering.cycle.members.flatMap(member => chain(member))],
        diagnostic: { code: "CYCLE_REJECTED", message: `Load-order cycle over ${ordering.cycle.members.join(", ")} is rejected by its cycle policy`, path: ["constraints", ordering.cycle.refs[0] ?? ""], severity: "error" },
      },
    };
  }
  return closure;
}

/**
 * The core as `ConstraintRefIR`, with each `kind` read off the constraint object
 * that produced the ref rather than parsed back out of the ref string. Prefix
 * parsing had no way to tell an unrecognised prefix from a real class, so a new ref
 * format would have silently relabelled every entry as `ordering`.
 *
 * Only the four blocking classes are searched, so a soft preference or an advisory
 * exclusion cannot reach a core even if its ref were somehow passed in.
 */
function coreEntries(refs: readonly ConstraintRef[], set: ConstraintSet): readonly ConstraintRefIR[] {
  const wanted = new Set(refs);
  return [...set.hardRequirements, ...set.hardProhibitions, ...set.runtimePolicies, ...set.orderings]
    .filter(constraint => wanted.has(constraint.ref))
    .map(constraint => ({ ref: constraint.ref, kind: constraint.kind }))
    .sort((a, b) => compare(a.ref, b.ref));
}

/**
 * Deletion-based minimisation. Every ref left in the core is load-bearing: removing
 * it makes the subset satisfiable, which is exactly the minimality property the
 * plan asks for. Soft preferences are structurally absent — they never enter here.
 */
function minimiseCore(candidate: readonly ConstraintRef[], set: ConstraintSet, seeds: readonly string[], universe: ReadonlySet<string>, principal: PrincipalView | undefined): readonly ConstraintRef[] {
  const unsatWith = (refs: readonly ConstraintRef[]): boolean => evaluate(seeds, restrict(set, new Set(refs)), universe, principal).blocker !== undefined;
  let core = [...new Set(candidate)].sort(compare);
  if (!unsatWith(core)) {
    const everything = [...set.hardRequirements, ...set.hardProhibitions, ...set.runtimePolicies, ...set.orderings].map(item => item.ref).sort(compare);
    if (!unsatWith(everything)) return core;
    core = everything;
  }
  for (const ref of [...core]) {
    const trial = core.filter(candidateRef => candidateRef !== ref);
    if (unsatWith(trial)) core = trial;
  }
  return core;
}

function costOf(unitId: string, unitCost: Readonly<Record<string, number>> | undefined): number {
  const cost = unitCost?.[unitId];
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

interface Rejection {
  readonly unitId: string;
  readonly weight: number;
  readonly reasons: readonly string[];
}

export function solve(request: SolveRequest): SolveResult {
  const derived = deriveConstraints({
    relations: request.relations,
    edges: request.edges,
    units: request.units,
    policyRequirements: request.policyRequirements,
    undeclaredPolicyLabels: request.undeclaredPolicyLabels,
    requestPreferences: request.preferences,
    defaultExpansionWeight: request.defaultExpansionWeight,
  });
  if (!derived.ok) return { ok: false, reason: "invalid-input", diagnostics: derived.diagnostics };
  const set = derived.constraints;
  const universe = new Set(request.units.map(unit => unit.identity.id));
  const missingSeeds = [...new Set(request.mandatory)].filter(seed => !universe.has(seed)).sort(compare);
  const rationale: DiagnosticIR[] = [...derived.diagnostics];
  const maxTokens = request.budget?.maxTokens ?? Number.POSITIVE_INFINITY;

  if (missingSeeds.length > 0) {
    return {
      ok: false,
      reason: "invalid-input",
      diagnostics: [...rationale, ...missingSeeds.map((seed): DiagnosticIR => ({ code: "MANDATORY_UNIT_MISSING", message: `Mandatory unit '${seed}' is absent from the graph`, path: ["mandatory", seed], severity: "error" }))],
    };
  }

  const seeds = [...new Set(request.mandatory)].sort(compare);
  const full = restrict(set, null);
  const mandatory = evaluate(seeds, full, universe, request.principal);
  const emptyBudget = { maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0 };

  if (mandatory.blocker !== undefined) {
    const core = minimiseCore(mandatory.blocker.refs, set, seeds, universe, request.principal);
    const entries = coreEntries(core, set);
    const plan: SelectionPlanIR = {
      requestId: request.requestId,
      snapshot: request.snapshot,
      query: request.query ?? {},
      candidates: mandatory.included.map(unitId => candidateOf(unitId, seeds.includes(unitId) ? "seed" : "hard-requirement", {})),
      selected: [],
      rejections: [],
      relationExpansions: mandatory.expansions,
      conflicts: [mandatory.blocker.diagnostic],
      budget: { ...emptyBudget, consumedTokens: 0 },
      projectionLoads: [],
      unsatCore: entries,
      rationale,
    };
    return { ok: false, reason: "unsat", blocker: mandatory.blocker.kind, plan, unsatCore: entries, constraints: set, diagnostics: [mandatory.blocker.diagnostic, ...rationale] };
  }

  const selected = new Set(mandatory.included);
  const support = new Map<string, readonly ConstraintRef[]>(mandatory.support);
  const reasons = new Map<string, string>(mandatory.included.map(unitId => [unitId, seeds.includes(unitId) ? "seed" : "hard-requirement"]));
  const expansions = [...mandatory.expansions];
  let consumed = mandatory.included.reduce((total, unitId) => total + costOf(unitId, request.unitCost), 0);
  if (consumed > maxTokens) rationale.push({ code: "BUDGET_EXCEEDED_BY_HARD_CONSTRAINTS", message: `Mandatory closure costs ${consumed} against a budget of ${maxTokens}; hard constraints are not budget-gated`, path: ["budget"], severity: "warning" });

  // Soft preferences: sorted by descending weight then unit id, so ties never
  // depend on Map insertion order. `arrivedVia` keeps one-hop expansion honest.
  const arrivedVia = new Map<string, Set<string>>();
  const decided = new Set<ConstraintRef>();
  const rejections: Rejection[] = [];
  const accepted = new Map<string, number>();
  const available = (preference: SoftPreferenceConstraint): boolean => {
    if (preference.subject === undefined) return true;
    if (!selected.has(preference.subject)) return false;
    if (preference.relationRef === undefined) return true;
    const view = derived.semantics.get(preference.relationRef);
    if (view === undefined) return false;
    return maxHops(view.traversal) > 1 || !(arrivedVia.get(preference.subject)?.has(preference.relationRef) ?? false);
  };
  const pool = [...set.softPreferences].sort((a, b) => b.weight - a.weight || compare(a.target, b.target) || compare(a.ref, b.ref));
  for (;;) {
    const next = pool.find(preference => !decided.has(preference.ref) && available(preference));
    if (next === undefined) break;
    decided.add(next.ref);
    if (selected.has(next.target)) continue;
    const trialSeeds = [...selected, next.target].sort(compare);
    const trial = evaluate(trialSeeds, full, universe, request.principal);
    if (trial.blocker !== undefined) {
      rejections.push({ unitId: next.target, weight: next.weight, reasons: [blockerReason(trial.blocker.kind), ...trial.blocker.refs.slice(0, 1)] });
      continue;
    }
    const additions = trial.included.filter(unitId => !selected.has(unitId));
    const extra = additions.reduce((total, unitId) => total + costOf(unitId, request.unitCost), 0);
    if (consumed + extra > maxTokens) {
      rejections.push({ unitId: next.target, weight: next.weight, reasons: ["budget-exhausted"] });
      continue;
    }
    for (const unitId of additions) {
      selected.add(unitId);
      support.set(unitId, trial.support.get(unitId) ?? []);
      if (!reasons.has(unitId)) reasons.set(unitId, unitId === next.target ? "soft-preference" : "hard-requirement");
    }
    if (next.relationRef !== undefined) {
      const via = arrivedVia.get(next.target) ?? new Set<string>();
      via.add(next.relationRef);
      arrivedVia.set(next.target, via);
    }
    accepted.set(next.target, next.weight);
    consumed += extra;
    for (const expansion of trial.expansions) if (!expansions.some(existing => existing.relationRef === expansion.relationRef && existing.from === expansion.from && existing.depth === expansion.depth)) expansions.push(expansion);
  }

  const ordering = planLoadOrder([...selected], set.orderings.filter(item => selected.has(item.before) && selected.has(item.after)));
  if (!ordering.ok) throw new Error("Ordering became unsatisfiable after selection; solver invariant violated");
  const advisory = set.advisories.filter(item => selected.has(item.left) && selected.has(item.right)).sort((a, b) => compare(a.ref, b.ref));
  const conflicts = advisory.map((item): DiagnosticIR => ({ code: "EXCLUSION_RECORDED", message: `Units '${item.left}' and '${item.right}' are declared exclusive at severity '${item.severity}'`, path: ["constraints", item.ref], severity: item.severity === "warning" ? "warning" : "info" }));

  const candidates = [...new Set([...selected, ...set.softPreferences.map(preference => preference.target)])]
    .filter(unitId => universe.has(unitId))
    .sort(compare)
    .map(unitId => candidateOf(unitId, reasons.get(unitId) ?? "candidate", accepted.has(unitId) ? { weight: accepted.get(unitId) ?? 0 } : {}));
  const plan: SelectionPlanIR = {
    requestId: request.requestId,
    snapshot: request.snapshot,
    query: request.query ?? {},
    candidates,
    selected: ordering.order.map(unitId => candidateOf(unitId, reasons.get(unitId) ?? "candidate", accepted.has(unitId) ? { weight: accepted.get(unitId) ?? 0 } : {})),
    rejections: rejections.sort((a, b) => compare(a.unitId, b.unitId)).map(rejection => ({ candidate: candidateOf(rejection.unitId, "soft-preference", { weight: rejection.weight }), reasons: rejection.reasons })),
    relationExpansions: expansions,
    conflicts,
    budget: { maxTokens: Number.isFinite(maxTokens) ? maxTokens : consumed, consumedTokens: consumed },
    projectionLoads: [],
    rationale: [...rationale, ...ordering.diagnostics],
  };
  return { ok: true, plan, order: ordering.order, components: ordering.components, collapsedInto: ordering.collapsedInto, constraints: set, diagnostics: [...rationale, ...ordering.diagnostics, ...conflicts] };
}

function blockerReason(kind: BlockerKind): string {
  return kind === "missing-target" ? "hard-requirement-target-missing" : kind === "hard-prohibition" ? "hard-prohibition-violated" : kind === "runtime-policy" ? "runtime-policy-denied" : "cycle-rejected";
}

function candidateOf(unitId: string, reason: string, featureValues: Readonly<Record<string, number>>): SelectionCandidateIR {
  return { unitId, score: featureValues["weight"] ?? 0, featureValues, reasons: [reason] };
}
