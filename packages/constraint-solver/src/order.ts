/**
 * Load ordering over the selected set, driven by `loadOrder` and `cyclePolicy`.
 *
 * Cycles are resolved on strongly connected components, not on the DFS path that
 * happened to find them: `collapse` genuinely contracts an SCC into one ordering
 * node (`collapsedInto` maps every member onto the component key), which is what
 * distinguishes it from `allow`.
 *
 * When one SCC contains edges from relations with different cycle policies the
 * most conservative one wins (reject > collapse > allow). A model that declares a
 * relation acyclic must not lose that guarantee because another relation is lax.
 */
import type { DiagnosticIR } from "@aoe/ir";
import type { ConstraintRef, OrderingObligation } from "./constraints.ts";
import type { CyclePolicyIR } from "@aoe/ir";

export interface UnitComponent {
  readonly key: string;
  readonly members: readonly string[];
  readonly cyclic: boolean;
  readonly collapsed: boolean;
  readonly cyclePolicy: CyclePolicyIR;
}

export interface RejectedCycle {
  readonly members: readonly string[];
  readonly refs: readonly ConstraintRef[];
  readonly relationRefs: readonly string[];
}

export type OrderResult =
  | { readonly ok: true; readonly order: readonly string[]; readonly components: readonly UnitComponent[]; readonly collapsedInto: Readonly<Record<string, string>>; readonly diagnostics: readonly DiagnosticIR[] }
  | { readonly ok: false; readonly cycle: RejectedCycle; readonly diagnostics: readonly DiagnosticIR[] };

const POLICY_RANK: Readonly<Record<CyclePolicyIR, number>> = { allow: 0, collapse: 1, reject: 2 };

function must<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error("Internal ordering state is incomplete");
  return value;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildAdjacency(nodes: readonly string[], orderings: readonly OrderingObligation[]): ReadonlyMap<string, readonly string[]> {
  const present = new Set(nodes);
  const adjacency = new Map<string, string[]>(nodes.map(node => [node, []]));
  for (const ordering of [...orderings].sort((a, b) => compare(a.ref, b.ref))) {
    if (!present.has(ordering.before) || !present.has(ordering.after)) continue;
    must(adjacency, ordering.before).push(ordering.after);
  }
  for (const list of adjacency.values()) list.sort(compare);
  return adjacency;
}

/** Iterative Tarjan. Node and neighbour iteration are both sorted, so components are reproducible. */
function stronglyConnectedComponents(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): readonly (readonly string[])[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const pending: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const open = (node: string): void => { index.set(node, counter); low.set(node, counter); counter += 1; pending.push(node); onStack.add(node) };
  for (const root of nodes) {
    if (index.has(root)) continue;
    open(root);
    const frames: { readonly node: string; next: number }[] = [{ node: root, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const child = neighbours[frame.next];
        frame.next += 1;
        if (!index.has(child)) { open(child); frames.push({ node: child, next: 0 }) }
        else if (onStack.has(child)) low.set(frame.node, Math.min(must(low, frame.node), must(index, child)));
        continue;
      }
      frames.pop();
      if (must(low, frame.node) === must(index, frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = pending.pop();
          if (popped === undefined) throw new Error("Internal ordering state is incomplete");
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        components.push(component.sort(compare));
      }
      const parent = frames[frames.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(must(low, parent.node), must(low, frame.node)));
    }
  }
  return components.sort((a, b) => compare(a[0] ?? "", b[0] ?? ""));
}

export function planLoadOrder(selected: readonly string[], orderings: readonly OrderingObligation[]): OrderResult {
  const nodes = [...new Set(selected)].sort(compare);
  const adjacency = buildAdjacency(nodes, orderings);
  const sccs = stronglyConnectedComponents(nodes, adjacency);
  const componentOf = new Map<string, number>();
  sccs.forEach((component, position) => { for (const member of component) componentOf.set(member, position) });

  const inScope = [...orderings].filter(ordering => componentOf.has(ordering.before) && componentOf.has(ordering.after)).sort((a, b) => compare(a.ref, b.ref));
  const internal = new Map<number, OrderingObligation[]>();
  for (const ordering of inScope) {
    const owner = must(componentOf, ordering.before);
    if (owner !== must(componentOf, ordering.after)) continue;
    const list = internal.get(owner);
    if (list === undefined) internal.set(owner, [ordering]); else list.push(ordering);
  }

  const diagnostics: DiagnosticIR[] = [];
  const components: UnitComponent[] = [];
  const collapsedInto: Record<string, string> = {};
  const rejected: { readonly position: number; readonly cycle: RejectedCycle }[] = [];
  sccs.forEach((members, position) => {
    const cycleEdges = internal.get(position) ?? [];
    const cyclic = members.length > 1 || cycleEdges.length > 0;
    const policy = cycleEdges.reduce<CyclePolicyIR>((worst, edge) => (POLICY_RANK[edge.cyclePolicy] > POLICY_RANK[worst] ? edge.cyclePolicy : worst), "allow");
    const key = members[0] ?? "";
    if (cyclic && policy === "reject") {
      rejected.push({ position, cycle: { members, refs: cycleEdges.map(edge => edge.ref).sort(compare), relationRefs: [...new Set(cycleEdges.map(edge => edge.relationRef))].sort(compare) } });
      return;
    }
    const collapsed = cyclic && policy === "collapse";
    if (collapsed) {
      for (const member of members) collapsedInto[member] = key;
      diagnostics.push({ code: "CYCLE_COLLAPSED", message: `Cycle of ${members.length} unit(s) collapsed into component '${key}'`, path: ["components", key], severity: "info" });
    } else if (cyclic) diagnostics.push({ code: "CYCLE_ALLOWED", message: `Cycle of ${members.length} unit(s) retained in component '${key}'`, path: ["components", key], severity: "info" });
    components.push({ key, members, cyclic, collapsed, cyclePolicy: policy });
  });
  const firstRejection = rejected[0];
  if (firstRejection !== undefined) {
    const cycle = firstRejection.cycle;
    return { ok: false, cycle, diagnostics: [...diagnostics, { code: "CYCLE_REJECTED", message: `Relation cycle over ${cycle.members.length} unit(s) is rejected by its cycle policy`, path: ["components", cycle.members[0] ?? ""], severity: "error" }] };
  }

  const positionOfKey = new Map<string, number>(components.map((component, at) => [component.key, at]));
  const outgoing = new Map<string, Set<string>>(components.map(component => [component.key, new Set<string>()]));
  const inDegree = new Map<string, number>(components.map(component => [component.key, 0]));
  const keyOf = (unitId: string): string => {
    const owner = must(componentOf, unitId);
    const component = sccs[owner];
    return component[0] ?? "";
  };
  for (const ordering of inScope) {
    const from = keyOf(ordering.before);
    const to = keyOf(ordering.after);
    if (from === to) continue;
    const targets = outgoing.get(from);
    if (targets === undefined || !positionOfKey.has(to) || targets.has(to)) continue;
    targets.add(to);
    inDegree.set(to, must(inDegree, to) + 1);
  }

  const ready = components.filter(component => must(inDegree, component.key) === 0).map(component => component.key).sort(compare);
  const ordered: UnitComponent[] = [];
  while (ready.length > 0) {
    const key = ready.shift() as string;
    const at = positionOfKey.get(key);
    if (at === undefined) continue;
    const component = components[at];
    ordered.push(component);
    for (const next of [...(outgoing.get(key) ?? [])].sort(compare)) {
      const remaining = must(inDegree, next) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) { ready.push(next); ready.sort(compare) }
    }
  }
  if (ordered.length !== components.length) throw new Error("Condensed ordering graph still contains a cycle");
  return { ok: true, order: ordered.flatMap(component => component.members), components: ordered, collapsedInto, diagnostics };
}
