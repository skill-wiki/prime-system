/**
 * Projection selection (plan §9.5).
 *
 * §9.5 lists six inputs; all six are explicit parameters here so that a missing
 * one is a type error rather than a silent default:
 *
 *   1. Model declaration          → `ProjectionCatalog`
 *   2. Request purpose            → `ProjectionRequest.purpose`
 *   3. Unit type/interface        → `UnitIR.typeRef` / `UnitIR.implements`
 *   4. Token/latency budget       → `ProjectionRequest.budget`
 *   5. Consumer capability        → `ProjectionRequest.consumer`
 *   6. Security/redaction policy  → `ProjectionRequest.policy`
 *
 * Purpose → profile is a *data* mapping (`purposeProfiles`), never a switch on
 * literal purpose names: the engine has no opinion about what purposes exist.
 */

import type { UnitIR } from "@skill-wiki/ir";
import type { ProjectionCatalog, ProjectionLevel } from "./profile.ts";
import type { TransportKind } from "./transport.ts";

export interface ConsumerCapability {
  /** Transports the consumer can actually honour, most preferred first. */
  readonly transports: readonly TransportKind[];
  /** Renderer ids the consumer accepts, matched against `extensions.renderer`. */
  readonly renderers?: readonly string[];
  /** Hard ceiling regardless of the request budget. */
  readonly maxTokensPerUnit?: number;
}

export interface ProjectionBudget {
  readonly maxTokens: number;
  readonly maxLatencyMs?: number;
}

export interface ProjectionRequest {
  readonly purpose: string;
  readonly budget: ProjectionBudget;
  readonly consumer: ConsumerCapability;
  /** Policy identity; the rule set itself lives in `redact.ts`. */
  readonly policy: { readonly refs: readonly string[] };
}

/**
 * Purpose → profile resolution, supplied as data. A purpose may name several
 * profiles in preference order; `default` is consulted only if the purpose has
 * no entry, and is itself a caller-supplied key, not a built-in profile.
 */
export interface PurposeRouting {
  readonly byPurpose: Readonly<Record<string, readonly string[]>>;
  readonly fallback?: readonly string[];
}

export type LevelRejection = {
  readonly level: ProjectionLevel;
  readonly reason: string;
};

export type ProfileResolution =
  | { readonly ok: true; readonly profile: string; readonly levels: readonly ProjectionLevel[] }
  | { readonly ok: false; readonly reason: string; readonly tried: readonly string[] };

export function resolveProfile(
  catalog: ProjectionCatalog,
  routing: PurposeRouting,
  purpose: string,
): ProfileResolution {
  const candidates = routing.byPurpose[purpose] ?? routing.fallback ?? [];
  const tried: string[] = [];
  for (const name of candidates) {
    tried.push(name);
    const levels = catalog.levels(name);
    if (levels.length > 0) return { ok: true, profile: name, levels };
  }
  return {
    ok: false,
    reason:
      candidates.length === 0
        ? `No profile is routed for purpose "${purpose}"`
        : `No routed profile for purpose "${purpose}" exists in the catalog`,
    tried,
  };
}

/**
 * Does this level apply to this unit?
 *
 * A level restricts itself through `typeGroups` and through `rules[].typeRef`.
 * Membership is checked against the unit's own `typeRef` and `implements`, so an
 * interface-typed unit matches a group declared on the interface.
 */
export function levelAppliesToUnit(level: ProjectionLevel, unit: UnitIR): boolean {
  const unitTypes = new Set<string>([unit.typeRef, ...unit.implements]);
  const groupMembers = Object.values(level.typeGroups).flat();
  if (groupMembers.length > 0 && !groupMembers.some((member) => unitTypes.has(member))) {
    // The level declares which types it covers and this unit is not among them.
    return false;
  }
  const ruleTypeRefs = level.rules
    .map((rule) => rule.typeRef)
    .filter((ref): ref is string => ref !== undefined);
  if (ruleTypeRefs.length > 0 && groupMembers.length === 0) {
    return ruleTypeRefs.some((ref) => unitTypes.has(ref));
  }
  return true;
}

export interface CandidateLevels {
  readonly profile: string;
  /** Applicable levels, cheapest first. */
  readonly levels: readonly ProjectionLevel[];
  readonly rejected: readonly LevelRejection[];
}

/**
 * Narrow a profile's levels to those this unit and this consumer can use.
 * Rejections are returned rather than dropped — §3.6 makes explainability a
 * contract, and a silently missing level is unexplainable.
 */
export function candidateLevels(
  levels: readonly ProjectionLevel[],
  unit: UnitIR,
  request: ProjectionRequest,
  profile: string,
): CandidateLevels {
  const kept: ProjectionLevel[] = [];
  const rejected: LevelRejection[] = [];
  const ceiling = request.consumer.maxTokensPerUnit;
  const renderers = request.consumer.renderers;

  for (const level of levels) {
    if (!levelAppliesToUnit(level, unit)) {
      rejected.push({ level, reason: `Level does not apply to unit type ${unit.typeRef}` });
      continue;
    }
    if (ceiling !== undefined && level.targetTokens > ceiling) {
      rejected.push({
        level,
        reason: `Level target ${level.targetTokens} exceeds the consumer ceiling ${ceiling}`,
      });
      continue;
    }
    const required = level.extensions["renderer"];
    if (typeof required === "string" && renderers !== undefined && !renderers.includes(required)) {
      rejected.push({ level, reason: `Consumer does not support renderer ${required}` });
      continue;
    }
    kept.push(level);
  }
  return { profile, levels: kept, rejected };
}
