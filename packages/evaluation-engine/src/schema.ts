import type { DiagnosticIR } from "@skill-wiki/ir";
import { z } from "zod";

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SemVer = z.string().regex(semver, "must be strict SemVer");

/**
 * Severity is `DiagnosticIR`'s closed set, not a second copy of it. The two
 * assertions below make drift a compile error in both directions: `satisfies`
 * rejects a value this list has that the IR does not, and the assignment rejects
 * an IR severity missing from this list. D-12's second-generation defect is a
 * duplicated closed set that stays legal while it goes stale, so the duplicate is
 * replaced by a checked derivation.
 */
const SEVERITIES = ["error", "warning", "info"] as const satisfies readonly DiagnosticIR["severity"][];
const _everyIrSeverityIsListed: readonly (typeof SEVERITIES)[number][] = [] as readonly DiagnosticIR["severity"][];
void _everyIrSeverityIsListed;

export const EvaluationCheckSchema = z.object({
  id: z.string().min(1),
  /** The provider id this check is addressed to. Nothing here says which provider *classes* exist; that is the registry's business. */
  provider: z.string().min(1),
  severity: z.enum(SEVERITIES),
  description: z.string().min(1).optional(),
  /**
   * Provider-specific configuration, opaque to this schema. Naming a field
   * `expression` here would privilege one of §9.7's six provider classes in the
   * document format, and every later class would either be second-class or force
   * a schema change.
   */
  with: z.record(z.string(), z.unknown()).default({}),
}).strict();

/**
 * `checks` is `min(1)`: a suite with no checks would produce an outcome with
 * nothing failing, which is the "default all pass" §9.7 forbids, arrived at
 * through an empty document rather than through a mock evaluator.
 */
export const EvaluationSuiteSchema = z.object({
  protocol: z.literal("prime/evaluation/v1"),
  name: z.string().min(1),
  version: SemVer,
  checks: z.array(EvaluationCheckSchema).min(1),
}).strict();

export type EvaluationSeverity = (typeof SEVERITIES)[number];
export type EvaluationCheck = z.infer<typeof EvaluationCheckSchema>;
export type EvaluationSuite = z.infer<typeof EvaluationSuiteSchema>;
