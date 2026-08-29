/**
 * Capability authorization, deny-by-default (plan §3.5, §12.3).
 *
 * Two properties this module exists to make structural rather than habitual:
 *
 * 1. **A capability is a grammar, not an enumeration.** `network:https` and
 *    `secrets:read:scoped` appear in §12.1 as *examples*. Turning them into a
 *    union type would put the host in the business of knowing which capabilities
 *    exist, which is the same failure as the engine knowing a domain's type
 *    names (§3.1): every new adapter would need an engine edit. So the shape is
 *    validated (`ns:verb[:qualifier…]`, lowercase segments) and the vocabulary
 *    is not.
 *
 * 2. **Nothing is granted implicitly.** A capability is exercisable only when it
 *    is BOTH declared by the plugin's manifest AND present in the host's grant
 *    set. Two independent gates, because they answer different questions: the
 *    manifest is the plugin's public claim about what it needs (auditable before
 *    install), the grant set is the operator's decision. A plugin that quietly
 *    starts using `secrets:read` cannot, because it never declared it; an
 *    operator who never granted `network:https` is not overridden by a manifest
 *    that asks for it.
 *
 * Deliberately NOT implemented: prefix widening and wildcards. `network` does
 * not imply `network:https`, and there is no `network:*`. A grant set is a set of
 * exact strings. Prefix widening reads as convenient and is how a
 * `secrets:read:scoped` grant silently becomes `secrets:read:all` the day
 * someone adds a qualifier — the widening happens in the checker, invisibly,
 * with no diff at the call site. Being explicit costs one line per capability.
 */

/** Why a capability request was refused. */
export type CapabilityRefusalCode =
  | "CAPABILITY_MALFORMED"
  | "CAPABILITY_NOT_DECLARED"
  | "CAPABILITY_NOT_GRANTED";

/**
 * `ns:verb[:qualifier…]`, at least two segments. Lowercase alphanumerics plus
 * `-` and `.` per segment: a hostname qualifier (`network:https:api.example.com`)
 * has to be expressible, and mixed case would make two spellings of one grant.
 */
const CAPABILITY_SHAPE = /^[a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*){1,}$/;

export function isWellFormedCapability(candidate: string): boolean {
  return CAPABILITY_SHAPE.test(candidate);
}

/** The segments of a capability, for callers that route on the namespace. */
export function capabilitySegments(capability: string): readonly string[] {
  return capability.split(":");
}

export function capabilityNamespace(capability: string): string {
  return capability.split(":", 1)[0]!;
}

export type CapabilityDecision =
  | { readonly granted: true; readonly capability: string }
  | { readonly granted: false; readonly capability: string; readonly code: CapabilityRefusalCode; readonly reason: string };

export interface CapabilityGrantSet {
  /** Exactly the capabilities the operator authorized. Empty means nothing. */
  readonly granted: ReadonlySet<string>;
  /** Exactly the capabilities the plugin's manifest declared. */
  readonly declared: ReadonlySet<string>;
}

/**
 * Build the two-gate set for one plugin.
 *
 * A grant that the plugin never declared is *dropped*, not honoured: the
 * effective authority of a plugin can never exceed its own published claim, so
 * an over-broad operator grant cannot silently arm a plugin that did not ask.
 * The dropped grants are returned so the caller can surface them — a grant with
 * no matching declaration is usually a typo in the operator's configuration, and
 * silently ignoring it is how an operator believes a plugin is armed when it is
 * not.
 */
export function authorizeCapabilities(
  declared: readonly string[],
  operatorGrants: readonly string[],
): {
  readonly grants: CapabilityGrantSet;
  readonly malformed: readonly string[];
  readonly grantsWithoutDeclaration: readonly string[];
  readonly declarationsWithoutGrant: readonly string[];
} {
  const malformed = [...new Set([...declared, ...operatorGrants])].filter(c => !isWellFormedCapability(c)).sort();
  const declaredSet = new Set(declared.filter(isWellFormedCapability));
  const grantedSet = new Set(operatorGrants.filter(c => isWellFormedCapability(c) && declaredSet.has(c)));
  return {
    grants: { granted: grantedSet, declared: declaredSet },
    malformed,
    grantsWithoutDeclaration: operatorGrants.filter(c => isWellFormedCapability(c) && !declaredSet.has(c)).sort(),
    declarationsWithoutGrant: [...declaredSet].filter(c => !grantedSet.has(c)).sort(),
  };
}

/**
 * The single question every effect-bearing path asks. There is no variant that
 * returns a boolean: a refusal carries the reason, and a call site that only
 * needs yes/no still has to name which of the two gates closed when it logs.
 */
export function checkCapability(grants: CapabilityGrantSet, requested: string): CapabilityDecision {
  if (!isWellFormedCapability(requested)) {
    return { granted: false, capability: requested, code: "CAPABILITY_MALFORMED", reason: `Not a capability: ${JSON.stringify(requested)}` };
  }
  if (!grants.declared.has(requested)) {
    return { granted: false, capability: requested, code: "CAPABILITY_NOT_DECLARED", reason: `Plugin never declared ${requested} in its manifest` };
  }
  if (!grants.granted.has(requested)) {
    return { granted: false, capability: requested, code: "CAPABILITY_NOT_GRANTED", reason: `${requested} is declared but not granted by the host` };
  }
  return { granted: true, capability: requested };
}

/** Empty grant set: what a plugin gets before authorization runs, and after it fails. */
export const NO_CAPABILITIES: CapabilityGrantSet = { granted: new Set<string>(), declared: new Set<string>() };
