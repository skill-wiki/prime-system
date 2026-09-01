/**
 * Steps 1, 3 and 4 of the plan §16 Phase 4 audit pipeline: **select rules**,
 * **run checks**, **aggregate**.
 *
 * Every rule below is *derived from the Model Package*, never listed here. The
 * catalogue is a fixed set of six rule **families**; which concrete rules exist,
 * what they compare against and how severe a violation is all come from the
 * loaded model's `TypeDefinition` / `RelationDefinition` / `ProjectionDefinition`
 * records. A model that declares no relations produces no relation rules; a model
 * that declares a relation as `cyclePolicy: reject` produces a cycle rule for it
 * and one that declares `allow` does not.
 *
 * Two deliberate consequences:
 *
 *  - The checks are **not** the input validation `ActionRuntime` already performs.
 *    The runtime validates the action's *input* against the model before the
 *    provider is ever called, so a provider that re-checked its own input would
 *    report a vacuous pass. The subject here is the compiled corpus, which
 *    nothing on the action path has validated.
 *  - A rule that cannot be decided is **skipped and says why** (§17.5: an optional
 *    check that did not run is reported, never counted as a pass).
 */

import { createHash } from 'node:crypto';
import type { LoadedModel, ProjectionDefinition, RelationDefinition, TypeDefinition } from '@aoe/model-schema';
import type { AuditedCorpus, AuditedEdge } from './corpus';

/** Model-declared severity, plus the structural default for rules the model does not grade. */
export type CheckSeverity = RelationDefinition['semantics']['conflictSeverity'];

/**
 * A rule the audit will run, with the definition that put it there. `declaredBy`
 * is what makes the selection auditable: a reader can ask "why is this rule in my
 * run?" and get a definition name rather than a line of engine source.
 */
export interface RuleSpec {
  readonly id: string;
  readonly family: RuleFamily;
  readonly declaredBy: string;
  readonly severity: CheckSeverity;
}

export type RuleFamily =
  | 'unit-type-declared'
  | 'relation-declared'
  | 'relation-endpoint-type'
  | 'relation-target-resolvable'
  | 'relation-cycle-policy'
  | 'projection-present';

/**
 * One check result, carrying every field plan §9.7 requires of an evaluation
 * result. `policyDecision` is absent on purpose: a policy decision belongs to the
 * *run* (the Action Runtime records one on `ActionRun.policyDecision`), and
 * copying it onto each check would imply the evaluator made it.
 */
export interface CheckResult {
  readonly rule: string;
  readonly family: RuleFamily;
  readonly subject: string;
  readonly provider: string;
  readonly deterministic: boolean;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly satisfied: boolean;
  readonly severity: CheckSeverity;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly modelVersion: string;
  readonly detail?: string;
}

export interface AuditMetrics {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** Integer 0..100 over decided checks only. 100 when nothing was decidable. */
  readonly score: number;
}

export interface AuditFindings {
  readonly action: string;
  readonly model: { readonly name: string; readonly version: string };
  readonly corpusRoot: string;
  readonly rules: readonly RuleSpec[];
  readonly results: readonly CheckResult[];
  readonly metrics: AuditMetrics;
  /**
   * Digest over the canonical findings. Two runs against the same snapshot and
   * input must produce the same value — that is what §16 Phase 4's "same snapshot
   * plus input can be replayed" means for the *result*, as opposed to the log.
   */
  readonly digest: string;
}

/** The evaluator's identity, recorded on every result per §9.7. */
export const DETERMINISTIC_PROVIDER = 'evaluator/structural-deterministic';

function isType(definition: LoadedModel['definitions'][number]): definition is TypeDefinition {
  return definition.kind === 'type';
}
function isRelation(definition: LoadedModel['definitions'][number]): definition is RelationDefinition {
  return definition.kind === 'relation';
}
function isProjection(definition: LoadedModel['definitions'][number]): definition is ProjectionDefinition {
  return definition.kind === 'projection';
}

/** Relation name or declared alias -> the definition it resolves to. */
function relationLookup(model: LoadedModel): ReadonlyMap<string, RelationDefinition> {
  const byName = new Map<string, RelationDefinition>();
  for (const relation of model.definitions.filter(isRelation)) {
    byName.set(relation.name, relation);
    for (const alias of relation.aliases ?? []) byName.set(alias, relation);
  }
  return byName;
}

/**
 * Step 1 — **select rules**. The result is a function of the model alone, so the
 * same model always selects the same rule set regardless of what corpus follows.
 */
export function selectRules(model: LoadedModel): readonly RuleSpec[] {
  const rules: RuleSpec[] = [];
  const types = model.definitions.filter(isType);
  const relations = model.definitions.filter(isRelation);
  const projections = model.definitions.filter(isProjection);
  const modelRef = `${model.manifest.name}@${model.manifest.version}`;

  if (types.length > 0) {
    rules.push({ id: 'unit-type-declared', family: 'unit-type-declared', declaredBy: modelRef, severity: 'error' });
  }
  if (relations.length > 0) {
    rules.push({ id: 'relation-declared', family: 'relation-declared', declaredBy: modelRef, severity: 'error' });
  }
  for (const relation of relations) {
    rules.push({
      id: `relation-endpoint-type:${relation.name}`,
      family: 'relation-endpoint-type',
      declaredBy: `relation:${relation.name}`,
      severity: 'error',
    });
    rules.push({
      id: `relation-target-resolvable:${relation.name}`,
      family: 'relation-target-resolvable',
      declaredBy: `relation:${relation.name}`,
      // The model grades its own referential integrity. A relation declared
      // `conflictSeverity: none` is one the model says may dangle.
      severity: relation.semantics.conflictSeverity,
    });
    // Only a relation whose model *rejects* cycles gets a cycle rule. Enumerating
    // it for every relation would assert a policy the model did not declare.
    if (relation.semantics.cyclePolicy === 'reject') {
      rules.push({
        id: `relation-cycle-policy:${relation.name}`,
        family: 'relation-cycle-policy',
        declaredBy: `relation:${relation.name}`,
        severity: 'error',
      });
    }
  }
  for (const projection of projections) {
    rules.push({
      id: `projection-present:${projection.name}`,
      family: 'projection-present',
      declaredBy: `projection:${projection.name}`,
      severity: 'warning',
    });
  }
  return rules;
}

interface Emitter {
  (result: Omit<CheckResult, 'provider' | 'deterministic' | 'confidence' | 'modelVersion'>): void;
}

/** Detect a cycle among the edges of one relation. Returns the offending path, if any. */
function findCycle(edges: readonly AuditedEdge[]): readonly string[] | undefined {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const walk = (node: string): readonly string[] | undefined => {
    const seen = state.get(node);
    if (seen === 'done') return undefined;
    if (seen === 'open') return [...path, node];
    state.set(node, 'open');
    path.push(node);
    for (const next of outgoing.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(node, 'done');
    return undefined;
  };
  for (const node of [...outgoing.keys()].sort()) {
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * Steps 3 and 4 — **run the checks and aggregate**. Pure: same model plus same
 * corpus view yields the same findings, which is what makes `digest` meaningful.
 */
export function runAudit(model: LoadedModel, corpus: AuditedCorpus, action: string): AuditFindings {
  const rules = selectRules(model);
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const typeNames = new Set(model.definitions.filter(isType).map((type) => type.name));
  const relationsByName = relationLookup(model);
  const projections = model.definitions.filter(isProjection);
  const unitById = new Map(corpus.units.map((unit) => [unit.id, unit]));
  const modelVersion = `${model.manifest.name}@${model.manifest.version}`;
  const results: CheckResult[] = [];
  const emit: Emitter = (result) => {
    results.push({
      ...result,
      provider: DETERMINISTIC_PROVIDER,
      deterministic: true,
      // A structural comparison either holds or it does not; there is no
      // probabilistic evaluator on this path, and reporting anything below 1
      // would invite a caller to treat a definite failure as a maybe.
      confidence: 1,
      modelVersion,
    });
  };

  const unitTypeRule = byId.get('unit-type-declared');
  if (unitTypeRule) {
    for (const unit of corpus.units) {
      const declared = typeNames.has(unit.type);
      emit({
        rule: unitTypeRule.id,
        family: unitTypeRule.family,
        subject: unit.id,
        skipped: false,
        satisfied: declared,
        severity: unitTypeRule.severity,
        evidence: [`unit:${unit.id}`, `type:${unit.type}`, `contentHash:${unit.contentHash}`],
        ...(declared ? {} : { detail: `Unit declares type ${unit.type}, which the model does not define` }),
      });
    }
  }

  const relationDeclaredRule = byId.get('relation-declared');
  if (relationDeclaredRule) {
    for (const edge of corpus.edges) {
      const declared = relationsByName.has(edge.relation);
      emit({
        rule: relationDeclaredRule.id,
        family: relationDeclaredRule.family,
        subject: `${edge.from}#${edge.relation}->${edge.to}`,
        skipped: false,
        satisfied: declared,
        severity: relationDeclaredRule.severity,
        evidence: [`relation:${edge.relation}`, `from:${edge.from}`, `to:${edge.to}`],
        ...(declared ? {} : { detail: `Edge uses relation ${edge.relation}, which the model does not define` }),
      });
    }
  }

  for (const [name, relation] of [...relationsByName].filter(([name, relation]) => name === relation.name)) {
    const edges = corpus.edges.filter((edge) => relationsByName.get(edge.relation)?.name === name);
    const endpointRule = byId.get(`relation-endpoint-type:${name}`);
    const resolvableRule = byId.get(`relation-target-resolvable:${name}`);
    const cycleRule = byId.get(`relation-cycle-policy:${name}`);

    if (endpointRule) {
      // `'*'` is the model's own way of declaring "any type", so an endpoint check
      // against it is undecidable rather than failing — and undecidable is
      // reported, not silently dropped.
      const wildcard = relation.from === '*' || relation.to === '*';
      if (edges.length === 0 || wildcard) {
        emit({
          rule: endpointRule.id,
          family: endpointRule.family,
          subject: `relation:${name}`,
          skipped: true,
          skipReason: wildcard
            ? `Relation ${name} declares an unconstrained endpoint (from=${relation.from}, to=${relation.to})`
            : `No edge in this corpus uses relation ${name}`,
          satisfied: false,
          severity: endpointRule.severity,
          evidence: [`relation:${name}`, `from:${relation.from}`, `to:${relation.to}`],
        });
      } else {
        for (const edge of edges) {
          const source = unitById.get(edge.from);
          const target = unitById.get(edge.to);
          const fromOk = source === undefined || source.type === relation.from;
          const toOk = target === undefined || target.type === relation.to;
          emit({
            rule: endpointRule.id,
            family: endpointRule.family,
            subject: `${edge.from}#${name}->${edge.to}`,
            skipped: false,
            satisfied: fromOk && toOk,
            severity: endpointRule.severity,
            evidence: [`declared:${relation.from}->${relation.to}`, `actual:${source?.type ?? '?'}->${target?.type ?? '?'}`],
            ...(fromOk && toOk
              ? {}
              : { detail: `Edge endpoints ${source?.type ?? '?'}->${target?.type ?? '?'} do not match declared ${relation.from}->${relation.to}` }),
          });
        }
      }
    }

    if (resolvableRule) {
      for (const edge of edges) {
        const resolved = unitById.has(edge.to);
        emit({
          rule: resolvableRule.id,
          family: resolvableRule.family,
          subject: `${edge.from}#${name}->${edge.to}`,
          skipped: false,
          satisfied: resolved,
          severity: resolvableRule.severity,
          evidence: [`target:${edge.to}`, `conflictSeverity:${relation.semantics.conflictSeverity}`],
          ...(resolved ? {} : { detail: `Edge target ${edge.to} is not a unit of this corpus` }),
        });
      }
    }

    if (cycleRule) {
      const cycle = findCycle(edges);
      emit({
        rule: cycleRule.id,
        family: cycleRule.family,
        subject: `relation:${name}`,
        skipped: false,
        satisfied: cycle === undefined,
        severity: cycleRule.severity,
        evidence: [`cyclePolicy:${relation.semantics.cyclePolicy}`, `edges:${edges.length}`],
        ...(cycle ? { detail: `Cycle: ${cycle.join(' -> ')}` } : {}),
      });
    }
  }

  for (const projection of projections) {
    const rule = byId.get(`projection-present:${projection.name}`);
    if (!rule) continue;
    for (const unit of corpus.units) {
      const path = unit.projections[projection.name];
      emit({
        rule: rule.id,
        family: rule.family,
        subject: unit.id,
        skipped: false,
        satisfied: path !== undefined,
        severity: rule.severity,
        evidence: [`projection:${projection.name}`, `artifact:${path ?? '(absent)'}`],
        ...(path === undefined ? { detail: `Unit has no artifact for projection ${projection.name}` } : {}),
      });
    }
  }

  const skipped = results.filter((result) => result.skipped).length;
  const decided = results.filter((result) => !result.skipped);
  // A `severity: none` rule is evaluated and reported but cannot fail the audit:
  // the model declared that violating it is not a conflict.
  const failed = decided.filter((result) => !result.satisfied && result.severity !== 'none').length;
  const passed = decided.length - failed;
  const metrics: AuditMetrics = {
    total: results.length,
    passed,
    failed,
    skipped,
    score: decided.length === 0 ? 100 : Math.round((passed / decided.length) * 100),
  };
  const findings: Omit<AuditFindings, 'digest'> = {
    action,
    model: { name: model.manifest.name, version: model.manifest.version },
    corpusRoot: corpus.root,
    rules,
    results,
    metrics,
  };
  return { ...findings, digest: `sha256:${createHash('sha256').update(canonical(findings)).digest('hex')}` };
}

/** Key-sorted JSON, so the digest does not depend on property insertion order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}
