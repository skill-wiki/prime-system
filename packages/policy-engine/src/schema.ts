import { ActionDefinitionSchema } from "@aoe/model-schema";
import { z } from "zod";

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SemVer = z.string().regex(semver, "must be strict SemVer");

/**
 * The three governance axes are read off `ActionDefinitionSchema` rather than
 * re-listed here. A second copy of a closed set is the exact defect D-12 named:
 * it stays legal, it stays silent, and it drifts. Reading the shape means a new
 * `sideEffects` value in the protocol is matchable by a policy the day it lands,
 * and a removed one stops parsing instead of matching nothing forever.
 */
const actionShape = ActionDefinitionSchema.shape;

/**
 * Every axis is optional and, when present, non-empty. `min(1)` is what keeps
 * "the author did not constrain this axis" (absent) distinguishable from "the
 * author constrained it to nothing" (`[]`) — the latter would be a rule that can
 * never match, which is a mistake worth rejecting rather than silently obeying.
 */
const Names = z.array(z.string().min(1)).min(1);

/**
 * Scope axes permit the empty string, which the others do not: `""` is the
 * canonical value for "no tenant" in the §12.4 scope tuple the runtime and the
 * event store already share. Without it the untenanted case would be unmatchable
 * by any rule and could only be governed by the set's default.
 */
const ScopeNames = z.array(z.string()).min(1);

export const PolicyMatchSchema = z.object({
  actions: Names.optional(),
  sideEffects: z.array(actionShape.sideEffects).min(1).optional(),
  idempotency: z.array(actionShape.idempotency).min(1).optional(),
  approval: z.array(actionShape.approval).min(1).optional(),
  principals: Names.optional(),
  /** Principal must hold at least one of these roles. */
  anyRole: Names.optional(),
  /** Principal must hold all of these roles. */
  allRoles: Names.optional(),
  /** Request must carry at least one of these capabilities. */
  anyCapability: Names.optional(),
  /** Request must carry all of these capabilities. */
  allCapabilities: Names.optional(),
  /** Capabilities the action requires that the request must also be granted; empty declaration means "all of them". */
  requiresDeclaredCapabilities: z.boolean().optional(),
  tenants: ScopeNames.optional(),
  workspaces: ScopeNames.optional(),
}).strict();

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  effect: z.enum(["allow", "deny"]),
  description: z.string().min(1).optional(),
  /** An absent `match` matches every request. Written as an explicit `{}` when that is meant. */
  match: PolicyMatchSchema.default({}),
}).strict();

/**
 * `default` has no schema default value on purpose. A policy set that forgets to
 * state what happens to an unmatched request must fail to parse, because the one
 * value a reader would assume — allow — is the §9.7 failure this engine exists to
 * remove, and the other — deny — is a decision the author should have to write
 * down rather than inherit.
 */
export const PolicySetSchema = z.object({
  protocol: z.literal("prime/policy/v1"),
  name: z.string().min(1),
  version: SemVer,
  default: z.enum(["allow", "deny"]),
  rules: z.array(PolicyRuleSchema).default([]),
}).strict();

export type PolicyMatch = z.infer<typeof PolicyMatchSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicySet = z.infer<typeof PolicySetSchema>;
