import type { ActionDefinition, Diagnostic, LoadedModel } from "@aoe/model-schema";
import type { PolicyMatch, PolicyRule, PolicySet } from "./schema.ts";

export interface Evidence { readonly kind: string; readonly value: string }
export interface PolicyDecision { readonly allowed: boolean; readonly reason: string; readonly evidence?: readonly Evidence[] }

/**
 * The narrow view of a request this engine needs, declared here rather than
 * imported from `action-runtime`. Same reason `action-runtime` declares
 * `IdempotencyLedger` itself: the consumer owns the contract, so the engine that
 * satisfies it structurally does not have to depend on its consumer, and §15.4's
 * direction is not inverted to get a shared type. A policy engine that could read
 * an action's *input* would also be able to base a decision on payload contents,
 * which is not one of the axes §15.2 gives this package.
 */
export interface PolicyRequestContext {
  readonly principal: string;
  readonly roles: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly tenant?: string;
  readonly workspace?: string;
  readonly policyRef?: string;
}

/** Every axis a rule can constrain, paired with the value the request presented. Returning the pairs rather than a boolean is what lets a decision carry evidence instead of a verdict. */
interface AxisOutcome { readonly axis: string; readonly matched: boolean; readonly value: string }

const holdsAll = (held: readonly string[], required: readonly string[]): boolean => required.every(one => held.includes(one));
const holdsAny = (held: readonly string[], required: readonly string[]): boolean => required.some(one => held.includes(one));

/**
 * `tenant`/`workspace` collapse to `""` when absent, matching the scope tuple the
 * runtime and the event store already agree on. A policy that wants to name the
 * untenanted case writes `tenants: [""]` — which is a declaration, where treating
 * absent as "matches any tenant" would be a built-in policy.
 */
function axes(match: PolicyMatch, action: ActionDefinition, context: PolicyRequestContext): readonly AxisOutcome[] {
  const out: AxisOutcome[] = [];
  const add = (axis: string, value: string, matched: boolean) => out.push({ axis, matched, value });
  if (match.actions) add("actions", action.name, match.actions.includes(action.name));
  if (match.sideEffects) add("sideEffects", action.sideEffects, match.sideEffects.includes(action.sideEffects));
  if (match.idempotency) add("idempotency", action.idempotency, match.idempotency.includes(action.idempotency));
  if (match.approval) add("approval", action.approval, match.approval.includes(action.approval));
  if (match.principals) add("principals", context.principal, match.principals.includes(context.principal));
  if (match.anyRole) add("anyRole", context.roles.join(","), holdsAny(context.roles, match.anyRole));
  if (match.allRoles) add("allRoles", context.roles.join(","), holdsAll(context.roles, match.allRoles));
  if (match.anyCapability) add("anyCapability", context.allowedCapabilities.join(","), holdsAny(context.allowedCapabilities, match.anyCapability));
  if (match.allCapabilities) add("allCapabilities", context.allowedCapabilities.join(","), holdsAll(context.allowedCapabilities, match.allCapabilities));
  if (match.requiresDeclaredCapabilities === true) add("requiresDeclaredCapabilities", action.capabilities.join(","), holdsAll(context.allowedCapabilities, action.capabilities));
  if (match.tenants) add("tenants", context.tenant ?? "", match.tenants.includes(context.tenant ?? ""));
  if (match.workspaces) add("workspaces", context.workspace ?? "", match.workspaces.includes(context.workspace ?? ""));
  return out;
}

export interface PolicyRuleEvaluation { readonly rule: PolicyRule; readonly matched: boolean; readonly axes: readonly AxisOutcome[] }
export interface PolicyExplanation { readonly set: string; readonly version: string; readonly evaluations: readonly PolicyRuleEvaluation[]; readonly decision: PolicyDecision }

/**
 * Nothing in this class knows a single policy: every name it compares — action,
 * principal, role, capability, tenant — arrives from the declared set and from the
 * request. The only knowledge built in is the *shape* of a decision (deny wins,
 * unmatched falls to the declared default) and the fact that a set must be present
 * at all, which is the §9.7 fail-closed requirement rather than a policy.
 */
export class PolicyEngine {
  constructor(private readonly set: PolicySet) {}

  get name(): string { return this.set.name }
  get version(): string { return this.set.version }

  /**
   * §8.5 binds a snapshot to one policy set, so a request naming a *different*
   * set is refused rather than governed by the set that happens to be loaded. A
   * request naming none is evaluated, with the unbound claim recorded as evidence:
   * refusing it would make `policyRef` mandatory, which is a protocol change this
   * lane is not entitled to make, and pretending it matched would be the silent
   * substitution §8.5 forbids.
   */
  explain(action: ActionDefinition, context: PolicyRequestContext): PolicyExplanation {
    const setEvidence: Evidence = { kind: "policy-set", value: `${this.set.name}@${this.set.version}` };
    const claimed = context.policyRef ?? "";
    if (claimed !== "" && claimed !== this.set.name) {
      return { set: this.set.name, version: this.set.version, evaluations: [], decision: { allowed: false, reason: `Policy set mismatch: request claims ${claimed}, engine holds ${this.set.name}`, evidence: [setEvidence, { kind: "policy-ref-claimed", value: claimed }] } };
    }
    const unbound: readonly Evidence[] = claimed === "" ? [{ kind: "policy-ref-unbound", value: this.set.name }] : [];
    const evaluations = this.set.rules.map(rule => { const outcomes = axes(rule.match, action, context); return { rule, matched: outcomes.every(one => one.matched), axes: outcomes } });
    const decisive = evaluations.find(one => one.matched && one.rule.effect === "deny") ?? evaluations.find(one => one.matched);
    const decision: PolicyDecision = decisive
      ? { allowed: decisive.rule.effect === "allow", reason: `Policy rule ${decisive.rule.id} ${decisive.rule.effect === "allow" ? "allows" : "denies"} ${action.name}${decisive.rule.description ? `: ${decisive.rule.description}` : ""}`, evidence: [setEvidence, ...unbound, { kind: "policy-rule", value: decisive.rule.id }, { kind: "policy-effect", value: decisive.rule.effect }, ...decisive.axes.map(one => ({ kind: `policy-match:${one.axis}`, value: one.value }))] }
      : { allowed: this.set.default === "allow", reason: `No policy rule in ${this.set.name} matches ${action.name}; the set's declared default is ${this.set.default}`, evidence: [setEvidence, ...unbound, { kind: "policy-default", value: this.set.default }, { kind: "policy-rules-evaluated", value: String(evaluations.length) }] };
    return { set: this.set.name, version: this.set.version, evaluations, decision };
  }

  /** Structurally satisfies `action-runtime`'s `PolicyProvider`. `input` is accepted and deliberately unread — see `PolicyRequestContext`. */
  async decide(action: ActionDefinition, _input: unknown, context: PolicyRequestContext): Promise<PolicyDecision> { return this.explain(action, context).decision }
}

/**
 * A policy set is data, so it can name something the model does not have — and a
 * rule pinned to a misspelled action or capability is a rule that never fires,
 * which reads as "policy allowed it" at the point of use. Checking the references
 * is the one thing that catches that before a decision is made.
 */
export function validatePolicySet(set: PolicySet, model: LoadedModel): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const actions = new Set<string>();
  const capabilities = new Set<string>();
  for (const definition of model.definitions) if (definition.kind === "action") { actions.add(definition.name); for (const capability of definition.capabilities) capabilities.add(capability); }
  for (const rule of set.rules) {
    const owner = `${set.name}/${rule.id}`;
    for (const name of rule.match.actions ?? []) if (!actions.has(name)) diagnostics.push({ code: "DANGLING_ACTION_REF", message: `Policy rule names an action the model does not define: ${name}`, path: set.name, definition: owner });
    for (const name of [...(rule.match.anyCapability ?? []), ...(rule.match.allCapabilities ?? [])]) if (!capabilities.has(name)) diagnostics.push({ code: "DANGLING_CAPABILITY_REF", message: `Policy rule names a capability no action in the model requires: ${name}`, path: set.name, definition: owner });
  }
  return diagnostics;
}
