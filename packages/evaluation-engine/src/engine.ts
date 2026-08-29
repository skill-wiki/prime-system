import type { PolicyDecision } from "@skill-wiki/policy-engine";
import { EvaluationProviderError, type EvaluationProvider, type EvaluationProviderRegistry, type EvaluationRequestContext, type Evidence } from "./providers.ts";
import type { EvaluationCheck, EvaluationSeverity, EvaluationSuite } from "./schema.ts";

/**
 * §9.7's result envelope, field for field. `skipped` and `skipReason` are part of
 * the envelope rather than an out-of-band error channel precisely so that a check
 * which did not run cannot be serialised into something indistinguishable from one
 * that passed (§17.5).
 */
export interface EvaluationResult {
  readonly check: string;
  readonly provider: string;
  readonly deterministic: boolean;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly satisfied: boolean;
  readonly severity: EvaluationSeverity;
  readonly confidence: number;
  readonly evidence: readonly Evidence[];
  readonly modelVersion: string;
  readonly policyDecision?: PolicyDecision;
  readonly detail?: string;
}

export interface EvaluationMetrics { readonly total: number; readonly satisfied: number; readonly failed: number; readonly skipped: number }

export interface EvaluationOutcome {
  readonly suite: string;
  readonly suiteVersion: string;
  /** True only when every check ran and no `error`-severity check failed. See `isSatisfied` for why a skip always sinks it. */
  readonly satisfied: boolean;
  /** False as soon as one check did not run. Reported separately from `satisfied` so a caller can tell "something failed" from "something was not measured". */
  readonly complete: boolean;
  readonly results: readonly EvaluationResult[];
  readonly metrics: EvaluationMetrics;
}

export interface EvaluateOptions {
  readonly subject: unknown;
  readonly context: EvaluationRequestContext;
  /**
   * Provenance for the envelope's `modelVersion`. Required, and rejected when
   * blank: an evaluation whose result cannot say what it was evaluated against is
   * not evidence of anything later.
   */
  readonly modelVersion: string;
  /**
   * The policy decision this evaluation runs under. §12.3 forbids a validator
   * from being a fail-open gate, so it is also the authority a *non-deterministic*
   * provider needs before its verdict may satisfy a check.
   */
  readonly policyDecision?: PolicyDecision;
}

export class EvaluationEngineError extends Error {}

/**
 * Why a skip always sinks the outcome, whatever the check's severity.
 *
 * Severity says how bad it is that a check *failed*. It does not say anything
 * about a check that never ran, and treating "informational and absent" as "fine"
 * is how "no provider registered" becomes "everything passed" — the one outcome
 * §9.7 rules out by name. So `satisfied` requires completeness, and severity only
 * governs which failures count.
 */
const isSatisfied = (results: readonly EvaluationResult[]): boolean =>
  results.length > 0 && results.every(result => !result.skipped) && !results.some(result => result.severity === "error" && !result.satisfied);

export class EvaluationEngine {
  constructor(private readonly providers: EvaluationProviderRegistry) {}

  /** The registered provider ids, so a caller can report *which* providers a suite is missing rather than that it failed. */
  registered(): readonly string[] { return this.providers.ids() }

  async evaluate(suite: EvaluationSuite, options: EvaluateOptions): Promise<EvaluationOutcome> {
    if (options.modelVersion.trim() === "") throw new EvaluationEngineError("modelVersion is required: a result that cannot name what it evaluated is not evidence");
    const results: EvaluationResult[] = [];
    for (const check of suite.checks) results.push(await this.one(check, options));
    const skipped = results.filter(result => result.skipped).length;
    const failed = results.filter(result => !result.skipped && !result.satisfied).length;
    return {
      suite: suite.name,
      suiteVersion: suite.version,
      satisfied: isSatisfied(results),
      complete: skipped === 0,
      results,
      metrics: { total: results.length, satisfied: results.filter(result => !result.skipped && result.satisfied).length, failed, skipped },
    };
  }

  private skip(check: EvaluationCheck, options: EvaluateOptions, provider: EvaluationProvider | undefined, skipReason: string, evidence: readonly Evidence[]): EvaluationResult {
    return {
      check: check.id,
      provider: check.provider,
      deterministic: provider?.deterministic ?? false,
      skipped: true,
      skipReason,
      // A skipped check is never satisfied, and its confidence is zero. Both are
      // spelled out rather than left absent, because a reader that only looked at
      // `satisfied` would otherwise have to know to look at `skipped` too.
      satisfied: false,
      severity: check.severity,
      confidence: 0,
      evidence,
      modelVersion: options.modelVersion,
      ...(options.policyDecision === undefined ? {} : { policyDecision: options.policyDecision }),
    };
  }

  private async one(check: EvaluationCheck, options: EvaluateOptions): Promise<EvaluationResult> {
    const provider = this.providers.get(check.provider);
    if (!provider) return this.skip(check, options, undefined, `No evaluation provider registered for ${check.provider}; registered: ${this.providers.ids().join(", ") || "none"}`, [{ kind: "provider-missing", value: check.provider }]);

    // §12.3: an LLM or external validator may not be a fail-open gate. Without a
    // policy decision that allows it, a non-deterministic provider's verdict is
    // not permitted to satisfy a check — so the check is recorded as not run
    // rather than run and passed.
    if (!provider.deterministic && options.policyDecision?.allowed !== true) {
      const why = options.policyDecision === undefined ? "no policy decision was supplied" : `policy denied it: ${options.policyDecision.reason}`;
      return this.skip(check, options, provider, `Provider ${provider.id} is non-deterministic (${provider.kind}) and ${why}, so its verdict may not gate this check`, [{ kind: "provider-non-deterministic", value: provider.id }]);
    }

    try {
      const verdict = await provider.evaluate({ check, subject: options.subject, context: options.context });
      if (!Number.isFinite(verdict.confidence) || verdict.confidence < 0 || verdict.confidence > 1) return this.skip(check, options, provider, `Provider ${provider.id} returned a confidence outside 0..1`, [{ kind: "provider-contract", value: String(verdict.confidence) }]);
      return {
        check: check.id,
        provider: provider.id,
        deterministic: provider.deterministic,
        skipped: false,
        satisfied: verdict.satisfied,
        severity: check.severity,
        confidence: verdict.confidence,
        evidence: verdict.evidence,
        modelVersion: options.modelVersion,
        ...(options.policyDecision === undefined ? {} : { policyDecision: options.policyDecision }),
        ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
      };
    } catch (error) {
      // A provider that threw did not answer. Recording that as a skip keeps the
      // distinction §17.5 asks for; recording it as `satisfied: false` would claim
      // a measurement that was never taken.
      const message = error instanceof EvaluationProviderError || error instanceof Error ? error.message : String(error);
      return this.skip(check, options, provider, `Provider ${provider.id} could not answer: ${message}`, [{ kind: "provider-error", value: message }]);
    }
  }
}
