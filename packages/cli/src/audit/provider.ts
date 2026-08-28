/**
 * The deterministic evaluator behind the audit action (plan §16 Phase 4 action 4:
 * "接真实 deterministic evaluator").
 *
 * The provider is **pure**: it reads the corpus view it was handed, runs the
 * model-derived checks and returns a value. It performs no I/O at all, which is
 * what lets the action honestly declare `sideEffects: none`. Writing the report
 * artifact is the CLI's act, not the action's — see `report.ts` — and conflating
 * the two would make a `sideEffects: none` action write to the filesystem.
 */

import type { ActionProvider, RequestContext } from '@skill-wiki/action-runtime';
import type { ActionDefinition, LoadedModel, TypeDefinition } from '@skill-wiki/model-schema';
import type { AuditedCorpus } from './corpus';
import { runAudit, type AuditFindings, type AuditMetrics } from './checks';

export interface AuditProviderOptions {
  readonly model: LoadedModel;
  readonly corpus: AuditedCorpus;
  /**
   * The model-declared object the *caller* attests, used when the audited
   * action's declared output is a model type. The engine never invents a value
   * for a domain-declared field: a verdict vocabulary belongs to the model and
   * its operator, so those bytes come in from outside.
   */
  readonly attestation?: Readonly<Record<string, unknown>>;
}

const METRIC_KEYS = ['total', 'passed', 'failed', 'skipped', 'score'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
const NUMERIC_REFS = ['number', 'integer'] as const;

function metricFor(name: string, metrics: AuditMetrics): number | undefined {
  return (METRIC_KEYS as readonly string[]).includes(name) ? metrics[name as MetricKey] : undefined;
}

/**
 * Fit the findings to whatever output the model declared, without the engine
 * learning a domain vocabulary.
 *
 * A scalar output is filled entirely by the engine, because the mapping from an
 * audit to a number/boolean/string needs no domain knowledge. An object output is
 * the caller's attestation with the engine's *metrics* merged in by name: a model
 * that declares a numeric field called `score` opts into receiving the score, and
 * one that does not gets nothing extra. Caller-supplied values always win, so the
 * merge can never overwrite an attestation.
 */
export function shapeOutput(
  model: LoadedModel,
  definition: ActionDefinition,
  findings: AuditFindings,
  attestation: Readonly<Record<string, unknown>> | undefined,
): unknown {
  const ref = definition.output;
  if (ref === 'number' || ref === 'integer') return findings.metrics.score;
  if (ref === 'boolean') return findings.metrics.failed === 0;
  if (ref === 'string') return findings.digest;
  const type = model.definitions.find((d): d is TypeDefinition => d.kind === 'type' && d.name === ref);
  if (!type) return attestation ?? {};
  const shaped: Record<string, unknown> = { ...(attestation ?? {}) };
  for (const field of type.fields) {
    if (shaped[field.name] !== undefined) continue;
    if (!(NUMERIC_REFS as readonly string[]).includes(field.typeRef)) continue;
    const value = metricFor(field.name, findings.metrics);
    if (value !== undefined) shaped[field.name] = value;
  }
  return shaped;
}

/**
 * One provider instance serves one audit subject. `findings` is exposed so the
 * caller can persist the report *after* the runtime has validated the output —
 * the provider itself must not reach outside its own computation.
 */
export class AuditActionProvider implements ActionProvider {
  private last: AuditFindings | undefined;

  constructor(
    private readonly definition: ActionDefinition,
    private readonly options: AuditProviderOptions,
  ) {}

  /** Findings of the most recent execution, or undefined if it never ran. */
  get findings(): AuditFindings | undefined {
    return this.last;
  }

  execute(input: unknown, _context: RequestContext): Promise<unknown> {
    const findings = runAudit(this.options.model, this.options.corpus, this.definition.name);
    this.last = findings;
    void input;
    return Promise.resolve(shapeOutput(this.options.model, this.definition, findings, this.options.attestation));
  }
}
