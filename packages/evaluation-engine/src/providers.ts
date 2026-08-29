import { ExpressionError, evaluateExpression } from "./expression.ts";
import type { EvaluationCheck } from "./schema.ts";

export interface Evidence { readonly kind: string; readonly value: string }

/**
 * §9.7's six provider classes, as a closed set of *classes* rather than of
 * providers. It is protocol vocabulary — the plan lists exactly these — and the
 * engine only ever reads `deterministic` off a provider, never branches on the
 * kind, so adding a class does not change any decision here.
 */
export type EvaluationProviderKind = "deterministic-expression" | "script" | "rule-engine" | "external-api" | "llm-judge" | "human-review";

/** The narrow request view a provider receives. It cannot see the suite, the other checks, or any other subject. */
export interface EvaluationRequestContext {
  readonly principal: string;
  readonly roles: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly tenant?: string;
  readonly workspace?: string;
  readonly policyRef?: string;
}

export interface EvaluationRequest { readonly check: EvaluationCheck; readonly subject: unknown; readonly context: EvaluationRequestContext }

/** A provider says whether the check held and how sure it is. It does not get to say "skipped" — an absent answer is the engine's finding, not the provider's. */
export interface ProviderVerdict { readonly satisfied: boolean; readonly confidence: number; readonly evidence: readonly Evidence[]; readonly detail?: string }

export interface EvaluationProvider {
  readonly id: string;
  readonly kind: EvaluationProviderKind;
  /** Whether the same subject and configuration must produce the same verdict. Read by the engine to decide whether §12.3's gate applies. */
  readonly deterministic: boolean;
  evaluate(request: EvaluationRequest): Promise<ProviderVerdict>;
}

export class EvaluationProviderRegistry {
  private readonly values = new Map<string, EvaluationProvider>();
  register(provider: EvaluationProvider): this { if (this.values.has(provider.id)) throw new Error(`Evaluation provider already registered: ${provider.id}`); this.values.set(provider.id, provider); return this }
  get(id: string): EvaluationProvider | undefined { return this.values.get(id) }
  ids(): readonly string[] { return [...this.values.keys()].sort() }
}

/** Thrown by a provider that cannot answer. The engine turns it into a recorded skip, never into a pass. */
export class EvaluationProviderError extends Error {}

/**
 * The only provider class this lane implements for real (§9.7's "Deterministic
 * expression"). The other five are registrable — the registry takes any provider
 * — and un-registered, which is why an un-registered provider must fail closed:
 * that state is the normal state today, not an edge case.
 *
 * `subject` and `context` are the whole scope. An expression cannot name anything
 * else, so a check cannot reach the host, the filesystem or another subject.
 */
export class DeterministicExpressionProvider implements EvaluationProvider {
  readonly kind = "deterministic-expression" as const;
  readonly deterministic = true;
  constructor(readonly id = "expression/default") {}
  async evaluate(request: EvaluationRequest): Promise<ProviderVerdict> {
    const source = request.check.with.expression;
    if (typeof source !== "string") throw new EvaluationProviderError(`Check ${request.check.id} does not declare a string 'expression' for provider ${this.id}`);
    try {
      const satisfied = evaluateExpression(source, { subject: request.subject, context: request.context });
      // Confidence is 1 either way: a deterministic evaluator is exactly as sure
      // that a check failed as that it passed. Reporting a lower confidence for a
      // failure is how a real failure gets discounted downstream.
      return { satisfied, confidence: 1, evidence: [{ kind: "expression", value: source }, { kind: "provider", value: this.id }] };
    } catch (error) {
      if (error instanceof ExpressionError) throw new EvaluationProviderError(`Check ${request.check.id} has an expression this evaluator cannot answer: ${error.message}`);
      throw error;
    }
  }
}
