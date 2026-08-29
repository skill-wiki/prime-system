import type { DiagnosticIR, ExecutionPlanIR, ExecutionPlanNodeIR, SnapshotRef, ValueIR } from "@skill-wiki/ir";
import type { ActionDefinition, FunctionDefinition, LoadedModel, TypeDefinition } from "@skill-wiki/model-schema";
/**
 * `snapshot` stays a plain id because it is the scope key of §12.4 — the thing a
 * tenant's index, cache and idempotency record are filed under. `snapshotRef`
 * carries the §8.4 digests, which an id cannot: a runtime that only had the id
 * would have nothing to compare against and so could not fail closed.
 */
export interface RequestContext { principal: string; roles: readonly string[]; allowedCapabilities: readonly string[]; budget: { timeoutMs?: number; maxAttempts?: number }; snapshot: string; trace: string; tenant?: string; workspace?: string; policyRef?: string; snapshotRef?: SnapshotRef }
export type RunStatus = "planned" | "awaiting_approval" | "running" | "succeeded" | "failed" | "denied";
export interface Evidence { kind: string; value: string } export interface PolicyDecision { allowed: boolean; reason: string; evidence?: readonly Evidence[] } export interface AuthorizationDecision extends PolicyDecision {}
export interface EffectPlan { action: string; provider: string; sideEffects: ActionDefinition["sideEffects"]; requiredCapabilities: readonly string[]; approval: "none" | "human" | "policy"; snapshot: string; trace: string; authorizationDecision?: AuthorizationDecision }
/**
 * The §12.4 scope tuple, narrower than `RequestContext` so a ledger cannot read a
 * principal or an input. `tenant`/`workspace` are collapsed to "" here — the same
 * default the runtime's own key uses — so a store and a runtime agree on what
 * "no tenant" means instead of one filing under `undefined`.
 */
export interface RunScopeTuple { readonly tenant: string; readonly workspace: string; readonly snapshot: string }
export interface IdempotencyRecordRef { readonly runId: string; readonly fingerprint: string }
export interface IdempotencyClaimRequest extends IdempotencyRecordRef { readonly scope: RunScopeTuple; readonly action: string; readonly idempotencyKey: string }
/**
 * Deliberately not an import of `@skill-wiki/event-store`: the forced dependency
 * direction is consumer -> store (§15.4), so the runtime declares the narrow
 * surface it needs and any store that happens to satisfy it structurally can be
 * passed in. The method names match `PersistentEventStore` for exactly that
 * reason — a rename here would force an adapter that has nothing to adapt.
 */
export interface IdempotencyLedger {
  claimIdempotency(claim: IdempotencyClaimRequest): { readonly status: "claimed" | "replayed"; readonly record: IdempotencyRecordRef };
  lookupIdempotency(scope: RunScopeTuple, action: string, idempotencyKey: string): IdempotencyRecordRef | undefined;
}
export interface EventRecord { sequence: number; runId: string; type: string; at: number; payload: Readonly<Record<string, unknown>> }
/**
 * Phase 4's acceptance asks for a duration on *every step*, which an event `at`
 * stamp cannot give: an interval between two events is the gap between two
 * writes, not the time a step took, and it disappears entirely for a step that
 * writes no event. So a step keeps its own measurement.
 *
 * `skipped` is a first-class status rather than an absence, because §17.5 forbids
 * a step that did not run from being indistinguishable from one that passed.
 */
export type StepStatus = "succeeded" | "failed" | "denied" | "suspended" | "skipped";
export interface AttemptRecord { readonly attempt: number; readonly startedAt: number; readonly durationMs: number; readonly status: "succeeded" | "failed"; readonly error?: string }
export interface StepRecord { readonly nodeId: string; readonly kind: ExecutionPlanNodeIR["kind"]; readonly target: string; readonly status: StepStatus; readonly startedAt: number; readonly durationMs: number; readonly attempts?: readonly AttemptRecord[]; readonly error?: string; readonly skipReason?: string }
export interface ActionRun { id: string; action: string; input: unknown; context: RequestContext; plan: ExecutionPlanIR; effect: EffectPlan; status: RunStatus; output?: unknown; error?: string; authorizationDecision?: AuthorizationDecision; policyDecision?: PolicyDecision; evidence: readonly Evidence[]; attempts: number; startedAt: number; durationMs?: number; steps: readonly StepRecord[] }
export interface FunctionRun { function: string; output?: unknown; error?: string; evidence: readonly Evidence[] } export interface ApprovalGrant { principal: string; roles?: readonly string[]; evidence?: readonly Evidence[] }
export interface EventStore { append(runId: string, type: string, payload?: Record<string, unknown>): EventRecord; events(runId: string): readonly EventRecord[]; save(run: ActionRun): void; get(runId: string): ActionRun | undefined }
export class InMemoryEventStore implements EventStore { private readonly records = new Map<string, EventRecord[]>(); private readonly runs = new Map<string, ActionRun>(); append(runId: string, type: string, payload: Record<string, unknown> = {}): EventRecord { const prior = this.records.get(runId) ?? []; const event = { sequence: prior.length + 1, runId, type, at: Date.now(), payload }; this.records.set(runId, [...prior, event]); return event } events(runId: string) { return this.records.get(runId) ?? [] } save(run: ActionRun) { this.runs.set(run.id, run) } get(runId: string) { return this.runs.get(runId) } }
export interface ActionProvider { execute(input: unknown, context: RequestContext): Promise<unknown> } export interface FunctionProvider { invoke(input: unknown, context: RequestContext): Promise<unknown> } export interface PreconditionProvider { check(name: string, input: unknown, context: RequestContext): Promise<boolean> } export interface PolicyProvider { decide(action: ActionDefinition, input: unknown, context: RequestContext): Promise<PolicyDecision> } export interface PrincipalAuthorizer { authorize(action: ActionDefinition, input: unknown, context: RequestContext): Promise<AuthorizationDecision> }
export class ActionProviderRegistry { private readonly values = new Map<string, ActionProvider>(); register(id: string, provider: ActionProvider) { this.values.set(id, provider); return this } get(id: string) { return this.values.get(id) } } export class FunctionProviderRegistry { private readonly values = new Map<string, FunctionProvider>(); register(id: string, provider: FunctionProvider) { this.values.set(id, provider); return this } get(id: string) { return this.values.get(id) } }
/**
 * The seam that makes `ExecutionPlanIR` an input rather than a record. The
 * runtime's own derivation is handed over as `derived`, so a planner extends a
 * plan it did not have to reinvent — and so the executor's only source of
 * sequencing is the plan it is given, whoever produced it. Without this seam
 * "the plan drives execution" is unfalsifiable: every plan would be the one the
 * executor's own hardcoded order produced.
 */
export interface ExecutionPlanRequest { readonly runId: string; readonly definition: ActionDefinition; readonly input: unknown; readonly context: RequestContext; readonly effect: EffectPlan; readonly snapshot: SnapshotRef | undefined; readonly derived: ExecutionPlanIR }
export interface ExecutionPlanner { plan(request: ExecutionPlanRequest): ExecutionPlanIR }
export interface RuntimeOptions { actions: ActionProviderRegistry; functions?: FunctionProviderRegistry; events?: EventStore; preconditions?: PreconditionProvider; policy?: PolicyProvider; authorizer?: PrincipalAuthorizer; now?: () => number; idempotency?: IdempotencyLedger; snapshot?: SnapshotRef; planner?: ExecutionPlanner }
export class ActionRuntimeError extends Error {} class PreparationError extends ActionRuntimeError { constructor(message: string, readonly decision?: AuthorizationDecision) { super(message) } } const fail = (message: string): never => { throw new ActionRuntimeError(message) }; const approvalOf = (value: ActionDefinition["approval"]): EffectPlan["approval"] => value === "never" ? "none" : value === "always" ? "human" : "policy";
/**
 * JSON array encoding, not a delimiter join, so `("a|b","c")` and `("a","b|c")`
 * cannot collide. Declared once and used by both the in-flight key and the
 * ledger tuple: two encodings of the same tuple is how a persisted record stops
 * matching the record a running process is looking for.
 */
const idempotencyTuple = (scope: RunScopeTuple, action: string, idempotencyKey: string): string => JSON.stringify([scope.tenant, scope.workspace, scope.snapshot, action, idempotencyKey]);
const scopeOf = (context: RequestContext): RunScopeTuple => ({ tenant: context.tenant ?? "", workspace: context.workspace ?? "", snapshot: context.snapshot });
/** A run whose snapshot could not be established. Every field empty so it matches no real snapshot and therefore cannot pass a digest comparison by accident. */
const UNBOUND_SNAPSHOT: SnapshotRef = { modelRelease: "", modelDigest: "", corpusRelease: "", corpusDigest: "" };
const SNAPSHOT_FIELDS = ["modelRelease", "modelDigest", "corpusRelease", "corpusDigest"] as const;
/**
 * The node-kind → execution-semantics map, stated as the gaps rather than the
 * implementations, because a gap is the thing that must not be silent. A kind
 * listed here is refused with its reason recorded (§17.5: a step that did not run
 * may not be reported as one that passed); a kind absent from here is executed.
 *
 * Four of the five gaps share one cause that is not a missing package: §7.6's
 * `ExecutionNodeIR` has `inputs` and no output binding, so a node's result cannot
 * be named or read by a later node. Until the IR grows that slot, a Query,
 * Materialize, Transform or InvokeFunction node could run and its result would
 * have nowhere to go — which is worse than refusing it.
 */
const NODE_KIND_GAPS: Partial<Record<ExecutionPlanNodeIR["kind"], string>> = {
  Query: "Requires the query engine, and §7.6's node has no output binding for the selection it would return; §15.4 also forbids action-runtime from depending on a consumer-side package",
  Materialize: "Requires the projection engine, and §7.6's node has no output binding for the materialised context; §15.4 forbids the dependency direction",
  Transform: "Requires an evaluation engine expression evaluator (§15.2 lists the package as not yet existing), and §7.6's node has no output binding for the transformed value",
  InvokeFunction: "A FunctionProvider registry exists, but §7.6's node has no output binding, so the function's result could not be consumed by any later node",
  InvokeModel: "Requires an external model provider layer, which this repo does not have; a model call whose result has nowhere to go would be an uncontrolled side effect",
};
/**
 * A precheck is a step that only inspects the request. The idempotency claim
 * fires immediately before the first step that is *not* one, because a malformed
 * input or a denied principal must not burn a key, while anything that suspends,
 * asks policy, or reaches outward must be behind the claim. Deriving the boundary
 * from the node's own kind and inputs keeps it a property of the plan rather than
 * a line number in the executor.
 */
const isPrecheck = (node: ExecutionPlanNodeIR): boolean => (node.kind === "Validate" && ("typeRefs" in node.inputs || "precondition" in node.inputs)) || (node.kind === "Gate" && ("principal" in node.inputs || "capability" in node.inputs));
const nodeString = (node: ExecutionPlanNodeIR, key: string): string => { const value = node.inputs[key]; return typeof value === "string" ? value : fail(`Execution plan node ${node.id} needs a string ${key}`) };
/** A thrown step maps to a status by what the step was, not by where the executor happened to be. A rejected request is `denied`; a provider or sink that misbehaved is `failed`. */
const terminalFor = (node: ExecutionPlanNodeIR): { status: RunStatus; event: string } => isPrecheck(node) ? { status: "denied", event: "run.denied" } : { status: "failed", event: "run.failed" };
type NodeOutcome =
  | { readonly kind: "continue"; readonly attempts?: readonly AttemptRecord[] }
  | { readonly kind: "suspend" }
  | { readonly kind: "halt"; readonly step: StepStatus; readonly status: RunStatus; readonly event: string; readonly error?: string; readonly payload?: Record<string, unknown>; readonly attempts?: readonly AttemptRecord[]; readonly skipReason?: string };
interface WalkState { readonly run: ActionRun; readonly def: ActionDefinition; readonly input: unknown; readonly context: RequestContext; readonly idempotencyKey: string; readonly fingerprint: string | undefined; readonly dryRun: boolean; claimed: boolean }
/** The default ledger: process-local, so it loses every claim on restart. That is why `RuntimeOptions.idempotency` exists. */
export class InMemoryIdempotencyLedger implements IdempotencyLedger {
  private readonly records = new Map<string, IdempotencyRecordRef>();
  claimIdempotency(claim: IdempotencyClaimRequest) { if (!claim.idempotencyKey) fail("Idempotency key is required"); const tuple = idempotencyTuple(claim.scope, claim.action, claim.idempotencyKey), prior = this.records.get(tuple); if (prior) { if (prior.fingerprint !== claim.fingerprint) fail("Idempotency conflict: key reused with different input"); return { status: "replayed" as const, record: prior } } const record: IdempotencyRecordRef = { runId: claim.runId, fingerprint: claim.fingerprint }; this.records.set(tuple, record); return { status: "claimed" as const, record } }
  lookupIdempotency(scope: RunScopeTuple, action: string, idempotencyKey: string) { return this.records.get(idempotencyTuple(scope, action, idempotencyKey)) }
}
export class ActionRuntime {
  private readonly functions: FunctionProviderRegistry; private readonly store: EventStore; private readonly ledger: IdempotencyLedger; private readonly pending = new Map<string, { fingerprint: string; result: Promise<ActionRun> }>(); private runCounter = 0;
  constructor(private readonly model: LoadedModel, private readonly options: RuntimeOptions) { this.functions = options.functions ?? new FunctionProviderRegistry(); this.store = options.events ?? new InMemoryEventStore(); this.ledger = options.idempotency ?? new InMemoryIdempotencyLedger() }
  private action(name: string) { return this.model.definitions.find((x): x is ActionDefinition => x.kind === "action" && x.name === name) ?? fail(`Unknown action: ${name}`) } private func(name: string) { return this.model.definitions.find((x): x is FunctionDefinition => x.kind === "function" && x.name === name) ?? fail(`Unknown function: ${name}`) } private type(name: string) { return this.model.definitions.find((x): x is TypeDefinition => x.kind === "type" && x.name === name) }
  private validate(ref: string, value: unknown, label: string): void { if (["unknown", "*", "generic"].includes(ref) || ref.startsWith("generic:")) return; if (ref === "string") { if (typeof value !== "string") fail(`${label} must be string`); return } if (ref === "number") { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be number`); return } if (ref === "integer") { if (typeof value !== "number" || !Number.isInteger(value)) fail(`${label} must be integer`); return } if (ref === "boolean") { if (typeof value !== "boolean") fail(`${label} must be boolean`); return } const type = this.type(ref); if (!type) return fail(`${label} references unknown type: ${ref}`); if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be ${ref}`); const object = value as Record<string, unknown>, fields = new Map(type.fields.map(field => [field.name, field])); for (const key of Object.keys(object)) if (!fields.has(key) && type.additionalFields !== "unknown") fail(`${label}.${key} is unknown`); for (const field of type.fields) { const fieldValue = object[field.name]; if (field.required && fieldValue === undefined) fail(`${label}.${field.name} is required`); if (fieldValue !== undefined) this.validate(field.typeRef, fieldValue, `${label}.${field.name}`) } }
  private validateInput(def: ActionDefinition | FunctionDefinition, input: unknown) { if (!input || typeof input !== "object" || Array.isArray(input)) fail("Input must be an object"); const object = input as Record<string, unknown>, fields = new Map(def.inputs.map(field => [field.name, field])); for (const key of Object.keys(object)) if (!fields.has(key)) fail(`input.${key} is unknown`); for (const field of def.inputs) { const value = object[field.name]; if (field.required && value === undefined) fail(`input.${field.name} is required`); if (value !== undefined) this.validate(field.typeRef, value, `input.${field.name}`) } }
  private effect(def: ActionDefinition, context: RequestContext): EffectPlan { const provider = def.provider; if (provider === undefined) throw new ActionRuntimeError(`Action ${def.name} has no provider`); if (!this.options.actions.get(provider)) fail(`Unknown action provider: ${provider}`); if (def.sideEffects !== "none" && def.capabilities.length === 0) fail(`Effectful action ${def.name} requires an explicit capability`); return { action: def.name, provider, sideEffects: def.sideEffects, requiredCapabilities: def.capabilities, approval: approvalOf(def.approval), snapshot: context.snapshot, trace: context.trace } }
  /**
   * Split out of `effect()` so the same check has one implementation whether it is
   * reached through `preflight()` (which composes the §9.6 order itself, being by
   * definition the pre-execution API) or through a `Gate` node the plan asked for.
   * Two copies is how a plan-driven gate and a preflight start disagreeing.
   */
  private checkCapability(capability: string, context: RequestContext): void { if (!context.allowedCapabilities.includes(capability)) fail(`Capability denied: ${capability}`) }
  private async checkPrecondition(condition: string, input: unknown, context: RequestContext): Promise<void> { if (!this.options.preconditions || !await this.options.preconditions.check(condition, input, context)) fail(`Precondition denied: ${condition}`) }
  private async decideAuthorization(def: ActionDefinition, input: unknown, context: RequestContext): Promise<AuthorizationDecision> { if (!context.principal) return { allowed: false, reason: "Principal is required" }; if (!this.options.authorizer) return { allowed: false, reason: "No principal authorizer" }; try { return await this.options.authorizer.authorize(def, input, context) } catch (error) { const message = error instanceof Error ? error.message : String(error); throw new PreparationError(`Authorization provider error: ${message}`, { allowed: false, reason: `Authorization provider error: ${message}`, evidence: [{ kind: "authorization-error", value: message }] }) } }
  private validateContext(context: RequestContext) { if (!context || typeof context.principal !== "string" || typeof context.snapshot !== "string" || !context.snapshot || typeof context.trace !== "string" || !context.trace || !Array.isArray(context.roles) || !Array.isArray(context.allowedCapabilities) || !context.budget || typeof context.budget !== "object") fail("Invalid request context"); const { timeoutMs, maxAttempts } = context.budget; if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) fail("Invalid request context"); if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) fail("Invalid request context") }
  /**
   * §8.5 binds a run to one immutable snapshot, so a runtime pinned to one must
   * refuse a request that claims a different digest — including a request that
   * claims none, because "no digest" is unverifiable rather than compatible. An
   * unpinned runtime has nothing to compare against and says so in the plan's
   * diagnostics instead of inventing an authority.
   */
  private validateSnapshot(context: RequestContext): void { const bound = this.options.snapshot; if (!bound) return; const claimed = context.snapshotRef; if (!claimed) return fail("Snapshot binding is required"); const mismatch = SNAPSHOT_FIELDS.filter(field => claimed[field] !== bound[field]); if (mismatch.length > 0) fail(`Snapshot binding mismatch: ${mismatch.join(", ")}`) }
  /** `preflight` composes the §9.6 order itself — it *is* the pre-execution API, so its sequence is inherent rather than planned. It shares every primitive with the node handlers so the two cannot drift. */
  private async prepare(def: ActionDefinition, input: unknown, context: RequestContext): Promise<EffectPlan> { this.validateContext(context); this.validateSnapshot(context); this.validateInput(def, input); const decision = await this.decideAuthorization(def, input, context); if (!decision.allowed) throw new PreparationError(decision.reason, decision); const effect = this.effect(def, context); for (const capability of effect.requiredCapabilities) this.checkCapability(capability, context); for (const condition of def.preconditions ?? []) await this.checkPrecondition(condition, input, context); return { ...effect, authorizationDecision: decision } }
  async preflight(action: string, input: unknown, context: RequestContext): Promise<EffectPlan> { return this.prepare(this.action(action), input, context) }
  private fingerprint(input: unknown): string { const active = new Set<object>(); const encode = (value: unknown): string => { if (value === null) return "null"; if (["string", "boolean"].includes(typeof value)) return JSON.stringify(value); if (typeof value === "number") { if (!Number.isFinite(value)) fail("Input is not canonically serializable"); return String(value) } if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") fail("Input is not canonically serializable"); if (typeof value !== "object") fail("Input is not canonically serializable"); const object = value as object; if (active.has(object)) fail("Input is not canonically serializable"); active.add(object); const result = Array.isArray(value) ? `[${value.map(encode).join(",")}]` : `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`).join(",")}}`; active.delete(object); return result }; return encode(input) }
  private key(context: RequestContext, action: string, idempotencyKey: string) { if (!idempotencyKey) fail("Idempotency key is required"); return idempotencyTuple(scopeOf(context), action, idempotencyKey) }
  execute(action: string, input: unknown, context: RequestContext, idempotencyKey: string, dryRun = false): Promise<ActionRun> { if (dryRun) return this.executeInner(action, input, context, "", undefined, true); let key: string, fingerprint: string, prior: IdempotencyRecordRef | undefined; try { key = this.key(context, action, idempotencyKey); fingerprint = this.fingerprint(input); prior = this.ledger.lookupIdempotency(scopeOf(context), action, idempotencyKey) } catch (error) { return Promise.reject(error) } if (prior) { if (prior.fingerprint !== fingerprint) return Promise.reject(new ActionRuntimeError("Idempotency conflict: key reused with different input")); const run = this.store.get(prior.runId); /* A ledger that outlived its event store is a torn deployment, not a replay hit: fabricating a run here would report a status for work this store never recorded. */ return run ? Promise.resolve(run) : Promise.reject(new ActionRuntimeError(`Idempotency record for ${prior.runId} has no run in this event store`)) } const active = this.pending.get(key); if (active) return active.fingerprint === fingerprint ? active.result : Promise.reject(new ActionRuntimeError("Idempotency conflict: key reused with different input")); const result = this.executeInner(action, input, context, idempotencyKey, fingerprint, false); this.pending.set(key, { fingerprint, result }); return result.finally(() => this.pending.delete(key)) }
  /**
   * The plan is the input, not the record. Every ordering decision here is read
   * out of `run.plan`: the walk order comes from `dependsOn`, each step's meaning
   * from the node's own `kind` and `inputs`, the attempt budget from the
   * InvokeAction node and the timeout from `plan.budget`. Nothing below branches
   * on `def.approval` or `def.capabilities` — the planner already turned those
   * into nodes, and reading them a second time here is precisely what made the
   * node graph a description of a hardcoded sequence instead of its cause.
   */
  private async executeInner(action: string, input: unknown, context: RequestContext, idempotencyKey: string, fingerprint: string | undefined, dryRun: boolean): Promise<ActionRun> {
    const def = this.action(action), provisional: EffectPlan = { action, provider: def.provider ?? "", sideEffects: def.sideEffects, requiredCapabilities: def.capabilities, approval: approvalOf(def.approval), snapshot: context.snapshot, trace: context.trace }, run = this.newRun(def, input, context, provisional);
    try {
      // Ahead of the walk because these decide whether the request may be planned
      // at all: §8.5 binds a run to one snapshot, and a definition naming no
      // registered provider leaves an InvokeAction node pointing at nothing.
      this.validateContext(context);
      this.validateSnapshot(context);
      run.effect = this.effect(def, context);
      return await this.walk({ run, def, input, context, idempotencyKey, fingerprint, dryRun, claimed: false }, 0);
    } catch (error) { return this.terminate(run, error, "denied", "run.denied") }
  }
  /**
   * Walks the plan from `fromIndex`. A resumed run re-enters the same walk rather
   * than a separate "now invoke" branch, which is what makes §7.6's checkpoint a
   * position in the plan instead of a label attached to one.
   */
  private async walk(state: WalkState, fromIndex: number): Promise<ActionRun> {
    const { run } = state, order = this.executionOrder(run.plan);
    for (let index = fromIndex; index < order.length; index++) {
      const node = order[index]!;
      if (!state.claimed && !isPrecheck(node)) {
        if (state.dryRun) return this.finish(run, "planned", "run.planned");
        try { const replayed = this.claimFor(state); if (replayed) return replayed; state.claimed = true }
        catch (error) { return this.terminate(run, error, "denied", "run.denied") }
      }
      const startedAt = this.clock();
      let outcome: NodeOutcome;
      try { outcome = await this.runNode(node, state) }
      catch (error) {
        const terminal = terminalFor(node);
        this.recordStep(run, node, terminal.status === "denied" ? "denied" : "failed", startedAt, { error: error instanceof Error ? error.message : String(error) });
        return this.terminate(run, error, terminal.status, terminal.event);
      }
      if (outcome.kind === "suspend") { this.recordStep(run, node, "suspended", startedAt); return this.transition(run, "awaiting_approval", "approval.requested") }
      if (outcome.kind === "halt") { this.recordStep(run, node, outcome.step, startedAt, outcome); return this.finish(run, outcome.status, outcome.event, outcome.error, outcome.payload) }
      this.recordStep(run, node, "succeeded", startedAt, outcome);
    }
    // A plan that ends without an Emit node never wrote the run's audit record.
    // Reporting success for an unrecorded run is the one outcome §16 Phase 4 rules
    // out, so a plan missing its last step fails closed rather than succeeding.
    return this.finish(run, "failed", "run.failed", `Execution plan for run ${run.id} completed without an Emit node, so no audit record was written`);
  }
  /**
   * Dependency order derived from `dependsOn`, not array order, so the graph is
   * load-bearing: a plan whose edges say something different executes differently.
   * Array position is only the tie-break, which keeps a plan's execution order
   * single-valued (§17.3 deterministic planning).
   */
  private executionOrder(plan: ExecutionPlanIR): readonly ExecutionPlanNodeIR[] {
    const byId = new Map(plan.nodes.map(node => [node.id, node]));
    if (byId.size !== plan.nodes.length) fail(`Execution plan ${plan.runId} has duplicate node ids`);
    for (const node of plan.nodes) for (const from of node.dependsOn) if (!byId.has(from)) fail(`Execution plan node ${node.id} depends on unknown node ${from}`);
    // §7.6 carries the same relation twice. If the two disagree, one of them is a
    // lie about what will run, and there is no safe way to pick which.
    const declared = new Set(plan.edges.map(edge => `${edge.from}\u0000${edge.to}`)), implied = new Set(plan.nodes.flatMap(node => node.dependsOn.map(from => `${from}\u0000${node.id}`)));
    if (declared.size !== implied.size || [...implied].some(edge => !declared.has(edge))) fail(`Execution plan ${plan.runId} has edges that do not match its dependsOn relation`);
    const pending = new Map(plan.nodes.map(node => [node.id, new Set(node.dependsOn)])), order: ExecutionPlanNodeIR[] = [];
    while (pending.size > 0) {
      const next = plan.nodes.find(node => pending.get(node.id)?.size === 0) ?? fail(`Execution plan ${plan.runId} has a dependency cycle`);
      pending.delete(next.id);
      for (const remaining of pending.values()) remaining.delete(next.id);
      order.push(next);
    }
    return order;
  }
  private claimFor(state: WalkState): ActionRun | undefined {
    const { run, context, idempotencyKey, fingerprint } = state;
    const claim = this.ledger.claimIdempotency({ scope: scopeOf(context), action: run.action, idempotencyKey, fingerprint: fingerprint!, runId: run.id });
    if (claim.record.runId === run.id) return undefined;
    /* Another writer already owns this tuple, which a process-local Map could not see. Never invoke the provider a second time for it. */
    this.store.append(run.id, "idempotency.replayed", { owner: claim.record.runId });
    return this.store.get(claim.record.runId) ?? this.finish(run, "denied", "idempotency.unresolved", `Idempotency key already claimed by run ${claim.record.runId}`);
  }
  private async runNode(node: ExecutionPlanNodeIR, state: WalkState): Promise<NodeOutcome> {
    const gap = NODE_KIND_GAPS[node.kind];
    if (gap !== undefined) {
      // §17.5: a step that did not run is recorded as not having run. The event is
      // the receipt — a skip that only exists in memory is a silent skip.
      this.store.append(state.run.id, "node.skipped", { nodeId: node.id, kind: node.kind, skipReason: gap });
      return { kind: "halt", step: "skipped", status: "failed", event: "run.failed", error: `Execution plan node ${node.id} has kind ${node.kind}, which this runtime does not implement`, skipReason: gap, payload: { nodeId: node.id, kind: node.kind } };
    }
    switch (node.kind) {
      case "Validate": return this.validateNode(node, state);
      case "Gate": return this.gateNode(node, state);
      case "AwaitApproval": return { kind: "suspend" };
      case "InvokeAction": return this.invokeActionNode(node, state);
      case "Emit": return this.emitNode(node, state);
      default: return fail(`Execution plan node ${node.id} has kind ${node.kind}, which is neither implemented nor declared as a gap`);
    }
  }
  private async validateNode(node: ExecutionPlanNodeIR, state: WalkState): Promise<NodeOutcome> {
    if ("typeRefs" in node.inputs) { this.validateInput(state.def, state.input); return { kind: "continue" } }
    if ("precondition" in node.inputs) { await this.checkPrecondition(nodeString(node, "precondition"), state.input, state.context); return { kind: "continue" } }
    if ("typeRef" in node.inputs) { this.validate(nodeString(node, "typeRef"), state.run.output, "output"); return { kind: "continue" } }
    return fail(`Execution plan node ${node.id} is a Validate with no subject in its inputs`);
  }
  private async gateNode(node: ExecutionPlanNodeIR, state: WalkState): Promise<NodeOutcome> {
    const { run, def, input, context } = state;
    if ("principal" in node.inputs) {
      const decision = await this.decideAuthorization(def, input, context);
      if (!decision.allowed) throw new PreparationError(decision.reason, decision);
      run.authorizationDecision = decision;
      run.evidence = [...run.evidence, ...(decision.evidence ?? [])];
      run.effect = { ...run.effect, authorizationDecision: decision };
      this.store.append(run.id, "authorization.decided", { allowed: true, reason: decision.reason, evidence: decision.evidence ?? [] });
      return { kind: "continue" };
    }
    if ("capability" in node.inputs) { this.checkCapability(nodeString(node, "capability"), context); return { kind: "continue" } }
    if (node.inputs.requirement === "policy") {
      let decision: PolicyDecision;
      try { decision = this.options.policy ? await this.options.policy.decide(def, input, context) : { allowed: false, reason: "No policy provider" } }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        decision = { allowed: false, reason: `Policy provider error: ${message}`, evidence: [{ kind: "policy-error", value: message }] };
        run.policyDecision = decision;
        run.evidence = [...run.evidence, ...(decision.evidence ?? [])];
        this.store.append(run.id, "policy.error", { error: message, evidence: decision.evidence ?? [] });
        return { kind: "halt", step: "failed", status: "failed", event: "policy.failed", error: decision.reason };
      }
      run.policyDecision = decision;
      run.evidence = [...run.evidence, ...(decision.evidence ?? [])];
      this.store.append(run.id, "policy.decided", { allowed: decision.allowed, reason: decision.reason, evidence: decision.evidence ?? [] });
      return decision.allowed ? { kind: "continue" } : { kind: "halt", step: "denied", status: "denied", event: "policy.denied", error: decision.reason };
    }
    return fail(`Execution plan node ${node.id} is a Gate with no requirement in its inputs`);
  }
  /**
   * The provider, the attempt budget and the retry precondition all come off the
   * node, not off the definition: a plan that says one attempt gets one attempt
   * even when the request asked for three.
   */
  private async invokeActionNode(node: ExecutionPlanNodeIR, state: WalkState): Promise<NodeOutcome> {
    const { run } = state, provider = node.target ? this.options.actions.get(node.target) : undefined;
    if (!provider) return { kind: "halt", step: "failed", status: "failed", event: "run.failed", error: "Unknown action provider" };
    const declared = node.inputs.maxAttempts, max = declared === undefined ? 1 : declared;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 10) return { kind: "halt", step: "failed", status: "failed", event: "run.failed", error: "maxAttempts must be an integer from 1 to 10" };
    if (max > 1 && node.inputs.idempotency !== "idempotent") return { kind: "halt", step: "failed", status: "failed", event: "run.failed", error: "Retries require an idempotent action definition" };
    const attempts: AttemptRecord[] = [];
    for (let attempt = 1; attempt <= max; attempt++) {
      run.attempts = attempt;
      this.transition(run, "running", "provider.attempt.started");
      const startedAt = this.clock();
      try {
        const output = await this.oneAttempt(provider, run);
        const durationMs = this.clock() - startedAt;
        attempts.push({ attempt, startedAt, durationMs, status: "succeeded" });
        run.output = output;
        this.store.append(run.id, "provider.attempt.succeeded", { attempt, durationMs });
        return { kind: "continue", attempts };
      } catch (error) {
        const durationMs = this.clock() - startedAt, message = error instanceof Error ? error.message : String(error);
        attempts.push({ attempt, startedAt, durationMs, status: "failed", error: message });
        this.store.append(run.id, "provider.attempt.failed", { attempt, error: message, durationMs });
        if (attempt === max) return { kind: "halt", step: "failed", status: "failed", event: "run.failed", error: message, attempts };
      }
    }
    return { kind: "halt", step: "failed", status: "failed", event: "run.failed", error: "Attempt budget exhausted", attempts };
  }
  /**
   * §9.6's last step, "emit audit record". In this runtime's event vocabulary the
   * run's terminal event *is* that record — cli's `audit.report.sealed` is a
   * downstream artifact written by the report writer, not this step. So the Emit
   * node is what makes a run terminal, and a plan without one cannot report
   * success.
   */
  private emitNode(node: ExecutionPlanNodeIR, state: WalkState): NodeOutcome {
    return { kind: "halt", step: "succeeded", status: "succeeded", event: "run.succeeded", payload: { sink: node.target, durationMs: this.clock() - state.run.startedAt } };
  }
  /** Authorization failures carry their decision, so the log tells a refusal apart from a provider outage. Everything else is a plain terminal transition. */
  private terminate(run: ActionRun, error: unknown, status: RunStatus, event: string): ActionRun {
    const preparation = error instanceof PreparationError ? error : undefined;
    if (!preparation?.decision) return this.finish(run, status, event, error instanceof Error ? error.message : String(error));
    run.authorizationDecision = preparation.decision;
    run.evidence = [...run.evidence, ...(preparation.decision.evidence ?? [])];
    const providerError = preparation.decision.reason.startsWith("Authorization provider error:");
    this.store.append(run.id, providerError ? "authorization.error" : "authorization.decided", providerError ? { error: preparation.decision.reason, evidence: preparation.decision.evidence ?? [] } : { allowed: false, reason: preparation.decision.reason, evidence: preparation.decision.evidence ?? [] });
    return this.finish(run, "denied", "authorization.denied", preparation.decision.reason);
  }
  private recordStep(run: ActionRun, node: ExecutionPlanNodeIR, status: StepStatus, startedAt: number, extra: { readonly attempts?: readonly AttemptRecord[]; readonly error?: string; readonly skipReason?: string } = {}): void {
    // Fields are spread in only when present: a stored `undefined` is what the
    // event store has to tag as unrepresentable, which would mark every revision
    // of every run lossy.
    run.steps = [...run.steps, { nodeId: node.id, kind: node.kind, target: node.target, status, startedAt, durationMs: this.clock() - startedAt, ...(extra.attempts ? { attempts: extra.attempts } : {}), ...(extra.error === undefined ? {} : { error: extra.error }), ...(extra.skipReason === undefined ? {} : { skipReason: extra.skipReason }) }];
  }
  async approve(runId: string, grant: ApprovalGrant): Promise<ActionRun> {
    const run = this.store.get(runId) ?? fail(`Unknown run: ${runId}`);
    if (!grant.principal) fail("Approval principal is required");
    if (run.status !== "awaiting_approval") fail("Run is not awaiting approval");
    const order = this.executionOrder(run.plan), suspended = order.findIndex(node => node.kind === "AwaitApproval");
    if (suspended < 0) fail(`Run ${runId} is awaiting approval but its plan has no AwaitApproval node`);
    run.evidence = [...run.evidence, ...(grant.evidence ?? [])];
    this.store.append(run.id, "approval.granted", { principal: grant.principal, roles: grant.roles ?? [], evidence: grant.evidence ?? [] });
    this.transition(run, "planned", "approval.accepted");
    // The claim was taken before the run suspended, so the resumed walk must not take it again.
    return this.walk({ run, def: this.action(run.action), input: run.input, context: run.context, idempotencyKey: "", fingerprint: undefined, dryRun: false, claimed: true }, suspended + 1);
  }
  /**
   * The node graph is derived from the definition and the request, not listed:
   * two actions with different approval requirements, capabilities or
   * preconditions must produce different graphs, otherwise the plan is a label
   * and nothing downstream can reason about what this run will actually do.
   *
   * The chain is linear because execution is linear — each stage gates the next —
   * so `dependsOn` names the previous node and `edges` is derived from it rather
   * than maintained beside it.
   */
  private planFor(runId: string, def: ActionDefinition, context: RequestContext, effect: EffectPlan): ExecutionPlanIR {
    const nodes: ExecutionPlanNodeIR[] = [];
    const push = (id: string, kind: ExecutionPlanNodeIR["kind"], target: string, inputs: Readonly<Record<string, ValueIR>>): string => {
      nodes.push({ id, kind, target, inputs, dependsOn: nodes.length === 0 ? [] : [nodes[nodes.length - 1]!.id] });
      return id;
    };
    push("validate-input", "Validate", def.name, { typeRefs: def.inputs.map(field => field.typeRef) });
    push("gate-authorization", "Gate", "principal", { principal: context.principal, roles: [...context.roles] });
    // Indexed ids rather than the capability name: a definition that repeats a
    // capability would otherwise emit two nodes with the same id.
    effect.requiredCapabilities.forEach((capability, index) => push(`gate-capability-${index + 1}`, "Gate", capability, { capability }));
    (def.preconditions ?? []).forEach((condition, index) => push(`validate-precondition-${index + 1}`, "Validate", condition, { precondition: condition }));
    const approvalNode = effect.approval === "human" ? push("await-approval", "AwaitApproval", effect.approval, { requirement: effect.approval })
      : effect.approval === "policy" ? push("gate-policy", "Gate", effect.approval, { requirement: effect.approval, policyRef: context.policyRef ?? "" })
      : undefined;
    // `maxAttempts` rides on the node because IR's plan budget has no slot for it
    // (see the report's list of suggested IR additions); dropping it would make a
    // retrying run indistinguishable from a single-attempt one.
    push("invoke-action", "InvokeAction", effect.provider, { sideEffects: def.sideEffects, idempotency: def.idempotency, maxAttempts: context.budget.maxAttempts ?? 1 });
    push("validate-output", "Validate", def.output, { typeRef: def.output });
    push("emit-audit", "Emit", "audit", { trace: context.trace });
    const snapshot = context.snapshotRef ?? this.options.snapshot;
    return {
      snapshot: snapshot ?? UNBOUND_SNAPSHOT,
      runId,
      nodes,
      edges: nodes.flatMap(node => node.dependsOn.map(from => ({ from, to: node.id }))),
      capabilities: effect.requiredCapabilities,
      approvals: effect.approval === "none" ? [] : [effect.approval],
      // Only a resumable boundary counts. `approve()` picks a run back up at the
      // approval node; a retry loop never leaves the process, so it is not one.
      checkpoints: approvalNode ? [approvalNode] : [],
      budget: context.budget.timeoutMs === undefined ? {} : { maxDurationMs: context.budget.timeoutMs },
      diagnostics: snapshot ? [] : [{ code: "SNAPSHOT_REF_UNBOUND", severity: "warning", message: `Run ${runId} carries no SnapshotRef, so the §8.4 digest checks cannot run for snapshot id ${context.snapshot}` } satisfies DiagnosticIR],
    };
  }
  /** The planner seam. `derived` is handed over so a planner extends the runtime's own derivation instead of reproducing it, and the executor still has exactly one source of sequencing: whatever comes back. */
  private planWith(runId: string, def: ActionDefinition, input: unknown, context: RequestContext, effect: EffectPlan): ExecutionPlanIR { const derived = this.planFor(runId, def, context, effect); return this.options.planner ? this.options.planner.plan({ runId, definition: def, input, context, effect, snapshot: context.snapshotRef ?? this.options.snapshot, derived }) : derived }
  private clock(): number { return this.options.now?.() ?? Date.now() }
  private newRun(def: ActionDefinition, input: unknown, context: RequestContext, effect: EffectPlan): ActionRun { const startedAt = this.clock(), id = `run-${startedAt}-${++this.runCounter}`, run: ActionRun = { id, action: def.name, input, context, effect, plan: this.planWith(id, def, input, context, effect), status: "planned", evidence: [], attempts: 0, startedAt, steps: [] }; this.store.save(run); this.store.append(id, "run.created", { status: run.status }); return run }
  private transition(run: ActionRun, status: RunStatus, event: string, error?: string, payload?: Record<string, unknown>) { run.status = status; if (error) run.error = error; this.store.save(run); this.store.append(run.id, event, payload ?? (error ? { error } : {})); return run }
  /** Stamps the whole-run duration before the transition, because `save()` inside `transition` is the last write and a field set after it would make the live run disagree with its own last revision (`replayEquivalence`). */
  private finish(run: ActionRun, status: RunStatus, event: string, error?: string, payload?: Record<string, unknown>) { run.durationMs = this.clock() - run.startedAt; return this.transition(run, status, event, error, payload) }
  /** The timeout comes off `plan.budget`, so a plan that carries no duration budget runs unbounded even when the request named one. */
  private async oneAttempt(provider: ActionProvider, run: ActionRun): Promise<unknown> { const timeout = run.plan.budget.maxDurationMs; if (timeout === undefined) return provider.execute(run.input, run.context); if (!Number.isFinite(timeout) || timeout <= 0) fail("Timeout must be a finite positive number"); let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([provider.execute(run.input, run.context), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ActionRuntimeError("Provider timeout")), timeout) })]) } finally { if (timer) clearTimeout(timer) } }
  async invokeFunction(name: string, input: unknown, context: RequestContext): Promise<FunctionRun> { try { const def = this.func(name); this.validateInput(def, input); const provider = this.functions.get(def.provider); if (!provider) return { function: name, error: `Unknown function provider: ${def.provider}`, evidence: [] }; const output = await provider.invoke(input, context); this.validate(def.output, output, "output"); return { function: name, output, evidence: [] } } catch (error) { return { function: name, error: error instanceof Error ? error.message : String(error), evidence: [] } } }
  events(runId: string) { return this.store.events(runId) }
}
