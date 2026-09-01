import type { LoadedModel, ModelDefinition, ProjectionDefinition, RelationDefinition, TypeDefinition } from "@aoe/model-schema";
import { check, finding, report, skipped, type CheckOutcome, type Finding, type SuiteReport } from "./diagnostics.ts";
import { computeContentDigest, computeUnitDigest, type CorpusPackage, type CorpusUnitRecord } from "./corpus.ts";

/** §17.2 Corpus Conformance. All policy is data: nothing below names a domain. */

export interface GoldenQuery {
  readonly name: string;
  readonly request: Readonly<Record<string, unknown>>;
  /** Expected result ids, in rank order. */
  readonly expectedUnitIds: readonly string[];
  /**
   * Expected diagnostic codes on the plan's `conflicts`, in the order the plan
   * reports them. Only checked when `runQueryPlan` is the injected implementation:
   * `runQuery` returns ids alone and has nothing to say about conflicts.
   */
  readonly expectedConflictCodes?: readonly string[];
  /**
   * Expected budget verdict. `state` is the explicit over-budget marker coordinator
   * decision D-2 requires — freezing it here is what stops a later change from
   * turning a reported over-budget plan back into a silent one.
   */
  readonly expectedBudget?: {
    readonly maxTokens: number;
    readonly consumedTokens?: number;
    readonly state?: string;
    readonly shortfall?: number;
  };
}

/**
 * What a query implementation reports back. Richer than `runQuery`'s id list
 * because §16 Phase 3 names three dimensions, not one: top-k, conflicts, budget.
 */
export interface GoldenQueryObservation {
  readonly unitIds: readonly string[];
  readonly conflictCodes: readonly string[];
  readonly budget: {
    readonly maxTokens: number;
    readonly consumedTokens?: number;
    readonly state?: string;
    readonly shortfall?: number;
  };
}

export interface CorpusConformanceOptions {
  /** When set, a unit whose `license` is absent or outside the list is reported. */
  readonly allowedLicenses?: readonly string[];
  /**
   * Citation requirements come from the model, never from the engine:
   * a type opts in with `extensions.requiresCitation: true`.
   */
  readonly requireCitationForAllTypes?: boolean;
  readonly goldenQueries?: readonly GoldenQuery[];
  /** Injected so the suite never imports a query engine. */
  readonly runQuery?: (request: Readonly<Record<string, unknown>>) => readonly string[];
  /**
   * Injected for the same reason as `runQuery`, but reports conflicts and budget
   * as well. Takes precedence when both are supplied, because it can answer every
   * expectation a `GoldenQuery` may carry while `runQuery` can only answer one.
   */
  readonly runQueryPlan?: (request: Readonly<Record<string, unknown>>) => GoldenQueryObservation;
  /** Ids that are legitimately outside this corpus (cross-corpus references). */
  readonly externalIds?: readonly string[];
}

function byKind<K extends ModelDefinition["kind"]>(model: LoadedModel, kind: K): readonly Extract<ModelDefinition, { kind: K }>[] {
  return model.definitions.filter((d): d is Extract<ModelDefinition, { kind: K }> => d.kind === kind);
}

const BUILTIN_SCALARS = new Set(["string", "number", "boolean", "integer", "unknown", "*", "generic"]);

function identityCheck(units: readonly CorpusUnitRecord[]): CheckOutcome {
  const findings: Finding[] = [];
  const byIdVersion = new Set<string>();
  const digestOwners = new Map<string, string>();
  for (const u of units) {
    const key = `${u.id}@${u.version}`;
    if (byIdVersion.has(key)) findings.push(finding("DUPLICATE_UNIT_VERSION", "id/version pair appears more than once", "error", { subject: key }));
    byIdVersion.add(key);
    const computed = computeUnitDigest(u);
    if (u.digest !== undefined && u.digest !== computed)
      findings.push(finding("DIGEST_MISMATCH", `declared digest does not match content (declared=${u.digest} computed=${computed})`, "error", { subject: key }));
    const content = computeContentDigest(u);
    const owner = digestOwners.get(content);
    if (owner !== undefined && owner !== key)
      findings.push(finding("DIGEST_COLLISION", `identical content under two identities: ${owner} and ${key}`, "warning", { subject: key }));
    digestOwners.set(content, key);
  }
  return check("CC-IDENTITY", "Unit id / version / digest uniqueness and digest integrity", findings);
}

function relationChecks(units: readonly CorpusUnitRecord[], relations: readonly RelationDefinition[], externalIds: readonly string[]): readonly CheckOutcome[] {
  const known = new Map(units.map(u => [u.id, u]));
  const external = new Set(externalIds);
  const defs = new Map<string, RelationDefinition>();
  for (const r of relations) {
    defs.set(r.name, r);
    for (const alias of r.aliases ?? []) defs.set(alias, r);
  }
  const dangling: Finding[] = [];
  const endpoints: Finding[] = [];
  for (const u of units) for (const edge of u.relations) {
    const subject = `${u.id} -${edge.relation}-> ${edge.to}`;
    const def = defs.get(edge.relation);
    if (def === undefined) { dangling.push(finding("UNKNOWN_RELATION", `relation is not declared by the model: ${edge.relation}`, "error", { subject })); continue; }
    const target = known.get(edge.to);
    if (target === undefined) {
      if (!external.has(edge.to)) dangling.push(finding("DANGLING_RELATION_TARGET", "relation target is not a unit in this corpus", "error", { subject }));
      continue;
    }
    if (def.from !== "*" && def.from !== u.typeRef)
      endpoints.push(finding("RELATION_SOURCE_TYPE_MISMATCH", `relation declares from=${def.from} but source unit is ${u.typeRef}`, "error", { subject }));
    if (def.to !== "*" && def.to !== target.typeRef)
      endpoints.push(finding("RELATION_TARGET_TYPE_MISMATCH", `relation declares to=${def.to} but target unit is ${target.typeRef}`, "error", { subject }));
  }
  return [
    check("CC-DANGLING-RELATIONS", "Every relation instance resolves to a declared relation and an existing unit", dangling),
    check("CC-RELATION-ENDPOINTS", "Relation instances respect declared endpoint types", endpoints),
  ];
}

/** Cycle policy is the model's, not the engine's: only `reject` relations are searched. */
function cycleCheck(units: readonly CorpusUnitRecord[], relations: readonly RelationDefinition[]): CheckOutcome {
  const findings: Finding[] = [];
  const rejecting = relations.filter(r => r.semantics.cyclePolicy === "reject" && r.directional);
  for (const def of rejecting) {
    const names = new Set([def.name, ...(def.aliases ?? [])]);
    const adjacency = new Map<string, string[]>();
    for (const u of units) for (const e of u.relations) if (names.has(e.relation)) adjacency.set(u.id, [...(adjacency.get(u.id) ?? []), e.to]);
    const state = new Map<string, "open" | "done">();
    const walk = (id: string, stack: readonly string[]): void => {
      const seen = state.get(id);
      if (seen === "done") return;
      if (seen === "open") {
        const start = stack.indexOf(id);
        findings.push(finding("CYCLE_POLICY_VIOLATION", `cycle on relation ${def.name}: ${[...stack.slice(start < 0 ? 0 : start), id].join(" -> ")}`, "error", { subject: `relation:${def.name}` }));
        return;
      }
      state.set(id, "open");
      for (const next of adjacency.get(id) ?? []) walk(next, [...stack, id]);
      state.set(id, "done");
    };
    for (const id of adjacency.keys()) walk(id, []);
  }
  return rejecting.length === 0
    ? skipped("CC-CYCLE-POLICY", "Relations with cyclePolicy=reject are acyclic", "no directional relation declares cyclePolicy=reject")
    : check("CC-CYCLE-POLICY", "Relations with cyclePolicy=reject are acyclic", findings);
}

function instanceSchemaCheck(units: readonly CorpusUnitRecord[], types: readonly TypeDefinition[]): CheckOutcome {
  const findings: Finding[] = [];
  const defs = new Map(types.map(t => [t.name, t]));
  const idsByType = new Map<string, Set<string>>();
  for (const u of units) idsByType.set(u.typeRef, (idsByType.get(u.typeRef) ?? new Set()).add(u.id));
  for (const u of units) {
    const def = defs.get(u.typeRef);
    if (def === undefined) { findings.push(finding("UNKNOWN_UNIT_TYPE", `unit type is not declared by the model: ${u.typeRef}`, "error", { subject: u.id })); continue; }
    const declared = new Map(def.fields.map(f => [f.name, f]));
    for (const f of def.fields) if (f.required === true && !(f.name in u.fields))
      findings.push(finding("MISSING_REQUIRED_FIELD", `required field absent: ${f.name}`, "error", { subject: u.id }));
    for (const [name, value] of Object.entries(u.fields)) {
      const field = declared.get(name);
      if (field === undefined) {
        if (def.additionalFields === "reject") findings.push(finding("UNDECLARED_FIELD", `field is not declared and additionalFields=reject: ${name}`, "error", { subject: u.id }));
        continue;
      }
      const ref = field.typeRef;
      const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const scalarOk =
        ref === "string" ? actual === "string" :
        ref === "number" ? actual === "number" :
        ref === "integer" ? typeof value === "number" && Number.isInteger(value) :
        ref === "boolean" ? actual === "boolean" : true;
      if (BUILTIN_SCALARS.has(ref) && !scalarOk)
        findings.push(finding("FIELD_TYPE_MISMATCH", `field ${name} declares ${ref} but holds ${actual}`, "error", { subject: u.id }));
      if (!BUILTIN_SCALARS.has(ref)) {
        const targets = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
        if (targets.length === 0)
          findings.push(finding("FIELD_REFERENCE_NOT_AN_ID", `field ${name} declares type ${ref} so it must hold unit id(s)`, "error", { subject: u.id }));
        for (const t of targets) if (!(idsByType.get(ref)?.has(t) ?? false))
          findings.push(finding("FIELD_REFERENCE_UNRESOLVED", `field ${name} points at ${t}, which is not a ${ref} unit in this corpus`, "error", { subject: u.id }));
      }
    }
  }
  return check("CC-INSTANCE-SCHEMA", "Units validate against their declared type schema", findings);
}

function citationCheck(units: readonly CorpusUnitRecord[], types: readonly TypeDefinition[], requireAll: boolean): CheckOutcome {
  const requiring = new Set(types.filter(t => requireAll || t.extensions?.["requiresCitation"] === true).map(t => t.name));
  if (requiring.size === 0)
    return skipped("CC-CITATION", "Units of citation-requiring types carry a citation", "no type declares extensions.requiresCitation");
  const findings: Finding[] = [];
  for (const u of units) if (requiring.has(u.typeRef) && u.citations.length === 0 && u.lifecycle !== "draft")
    findings.push(finding("MISSING_CITATION", `type ${u.typeRef} requires a citation`, "error", { subject: u.id }));
  return check("CC-CITATION", "Units of citation-requiring types carry a citation", findings);
}

function lifecycleCheck(units: readonly CorpusUnitRecord[], relations: readonly RelationDefinition[]): CheckOutcome {
  const findings: Finding[] = [];
  const known = new Map(units.map(u => [u.id, u]));
  const selectionOf = new Map<string, RelationDefinition["semantics"]["selection"]>();
  for (const r of relations) { selectionOf.set(r.name, r.semantics.selection); for (const a of r.aliases ?? []) selectionOf.set(a, r.semantics.selection); }
  for (const u of units) {
    if (u.lifecycle === "deprecated" && u.supersededBy === undefined)
      findings.push(finding("DEPRECATED_WITHOUT_SUCCESSOR", "deprecated unit declares no supersededBy", "warning", { subject: u.id }));
    if (u.supersededBy !== undefined && !known.has(u.supersededBy))
      findings.push(finding("SUCCESSOR_NOT_FOUND", `supersededBy points at an unknown unit: ${u.supersededBy}`, "error", { subject: u.id }));
    if (u.lifecycle !== "deleted") for (const e of u.relations) {
      const target = known.get(e.to);
      if (target === undefined) continue;
      const selection = selectionOf.get(e.relation);
      const loadBearing = selection === "expand" || selection === "closure";
      if (target.lifecycle === "deleted")
        findings.push(finding("REFERENCES_DELETED_UNIT", `relation ${e.relation} targets a deleted unit: ${e.to}`, "error", { subject: u.id }));
      else if (target.lifecycle === "deprecated" && loadBearing)
        findings.push(finding("LOAD_BEARING_DEPRECATED_TARGET", `relation ${e.relation} (selection=${selection}) targets a deprecated unit: ${e.to}`, "warning", { subject: u.id }));
    }
  }
  return check("CC-LIFECYCLE", "Lifecycle and deprecation consistency", findings);
}

function licenseCheck(units: readonly CorpusUnitRecord[], allowed?: readonly string[]): CheckOutcome {
  if (allowed === undefined || allowed.length === 0)
    return skipped("CC-LICENSE", "Unit licenses satisfy the license policy", "no allowedLicenses policy supplied");
  const set = new Set(allowed);
  const findings = units.flatMap(u =>
    u.license === undefined ? [finding("LICENSE_MISSING", "unit declares no license but a policy is in force", "error", { subject: u.id })]
    : set.has(u.license) ? [] : [finding("LICENSE_NOT_ALLOWED", `license outside policy: ${u.license}`, "error", { subject: u.id })]);
  return check("CC-LICENSE", "Unit licenses satisfy the license policy", findings);
}

function budgetCheck(units: readonly CorpusUnitRecord[], projections: readonly ProjectionDefinition[]): CheckOutcome {
  const budgets = new Map(projections.map(p => [p.name, p.targetTokens]));
  if (budgets.size === 0) return skipped("CC-PROJECTION-BUDGET", "Rendered projections fit their token budget", "model declares no projection");
  const measured = units.filter(u => Object.keys(u.tokens).length > 0);
  if (measured.length === 0) return skipped("CC-PROJECTION-BUDGET", "Rendered projections fit their token budget", "corpus carries no per-projection token measurements");
  const findings: Finding[] = [];
  for (const u of measured) for (const [name, tokens] of Object.entries(u.tokens)) {
    const budget = budgets.get(name);
    if (budget === undefined) { findings.push(finding("TOKENS_FOR_UNKNOWN_PROJECTION", `token count for a projection the model does not declare: ${name}`, "error", { subject: u.id })); continue; }
    if (tokens > budget) findings.push(finding("PROJECTION_BUDGET_EXCEEDED", `projection ${name} uses ${tokens} tokens, budget is ${budget}`, "error", { subject: u.id }));
  }
  return check("CC-PROJECTION-BUDGET", "Rendered projections fit their token budget", findings);
}

function goldenQueryCheck(options: CorpusConformanceOptions): CheckOutcome {
  const { goldenQueries, runQuery, runQueryPlan } = options;
  if (goldenQueries === undefined || goldenQueries.length === 0)
    return skipped("CC-GOLDEN-QUERY", "Golden queries return the expected ranking", "no golden queries supplied");
  if (runQuery === undefined && runQueryPlan === undefined)
    return skipped("CC-GOLDEN-QUERY", "Golden queries return the expected ranking", "no query implementation injected");
  const findings: Finding[] = [];
  for (const q of goldenQueries) {
    const observation = runQueryPlan?.(q.request);
    const actual = observation?.unitIds ?? runQuery!(q.request);
    if (actual.length !== q.expectedUnitIds.length || actual.some((id, i) => id !== q.expectedUnitIds[i]))
      findings.push(finding("GOLDEN_QUERY_MISMATCH", `expected [${q.expectedUnitIds.join(", ")}] got [${actual.join(", ")}]`, "error", { subject: q.name }));
    // An expectation the injected implementation cannot answer is reported, never
    // silently satisfied — §17.5 forbids a skip that reads as a pass, and a golden
    // whose conflict expectation was never evaluated is exactly that.
    if (q.expectedConflictCodes !== undefined) {
      if (observation === undefined)
        findings.push(finding("GOLDEN_QUERY_CONFLICTS_UNCHECKED", "expectedConflictCodes requires the runQueryPlan implementation", "error", { subject: q.name }));
      else if (observation.conflictCodes.length !== q.expectedConflictCodes.length || observation.conflictCodes.some((code, i) => code !== q.expectedConflictCodes![i]))
        findings.push(finding("GOLDEN_QUERY_CONFLICT_MISMATCH", `expected conflicts [${q.expectedConflictCodes.join(", ")}] got [${observation.conflictCodes.join(", ")}]`, "error", { subject: q.name }));
    }
    if (q.expectedBudget !== undefined) {
      if (observation === undefined)
        findings.push(finding("GOLDEN_QUERY_BUDGET_UNCHECKED", "expectedBudget requires the runQueryPlan implementation", "error", { subject: q.name }));
      else {
        const differs = (["maxTokens", "consumedTokens", "state", "shortfall"] as const)
          .filter(field => q.expectedBudget![field] !== undefined && observation.budget[field] !== q.expectedBudget![field]);
        if (differs.length > 0)
          findings.push(finding("GOLDEN_QUERY_BUDGET_MISMATCH", `budget field(s) [${differs.join(", ")}] differ: expected ${JSON.stringify(q.expectedBudget)} got ${JSON.stringify(observation.budget)}`, "error", { subject: q.name }));
      }
    }
  }
  return check("CC-GOLDEN-QUERY", "Golden queries return the expected ranking", findings);
}

export function runCorpusConformance(corpus: CorpusPackage, model: LoadedModel, options: CorpusConformanceOptions = {}): SuiteReport {
  const units = corpus.units;
  const types = byKind(model, "type");
  const relations = byKind(model, "relation");
  const checks: CheckOutcome[] = [
    check("CC-MODEL-BINDING", "Corpus declares the model it was compiled against",
      corpus.model === model.manifest.name ? [] : [finding("CORPUS_MODEL_MISMATCH", `corpus targets model ${corpus.model} but ${model.manifest.name} was supplied`, "error", { subject: corpus.name })]),
    identityCheck(units),
    ...relationChecks(units, relations, options.externalIds ?? []),
    cycleCheck(units, relations),
    instanceSchemaCheck(units, types),
    citationCheck(units, types, options.requireCitationForAllTypes === true),
    lifecycleCheck(units, relations),
    licenseCheck(units, options.allowedLicenses),
    budgetCheck(units, byKind(model, "projection")),
    goldenQueryCheck(options),
  ];
  return report("corpus-conformance", `${corpus.name}@${corpus.version}`, checks);
}
