/**
 * @module types
 *
 * The one client-side vocabulary. Every request and result type here is either
 * imported from the engine packages or built out of IR, never re-declared: a
 * second copy of `QueryRequest` on the client side is how a transport starts
 * meaning something different from the engine it fronts, which is exactly what
 * plan §10.4 forbids ("Transport 不得改变 Query/Plan/Action 的核心语义").
 *
 * That constraint is expressed structurally rather than in prose: `EngineTransport`
 * is typed in terms of `QueryRequest`/`SelectionPlanIR`/`ActionRun`, so a transport
 * cannot narrow, widen or re-key the semantics without failing to implement the
 * interface.
 */

import type { DiagnosticIR, SelectionPlanIR, SnapshotRef, ValueIR } from "@aoe/ir";
import type { QueryRequest } from "@aoe/query-engine";
import type { ActionRun, EffectPlan, EventRecord, RequestContext } from "@aoe/action-runtime";

/**
 * The four deployment shapes plan §10.4 names. It is a closed set because it
 * enumerates *transports*, not domain vocabulary — a new transport is a change to
 * this protocol, not model data — and because a caller that logs or routes on it
 * needs the compiler to tell it when the set grows.
 */
export type TransportKind = "embedded" | "local-daemon" | "remote" | "mcp";

/**
 * One unit rendered through one projection. `content` is `ValueIR` rather than
 * `string` because `UnitIR.projections` is `Record<string, ValueIR>`: forcing it to
 * a string here would make the client the place that decides how a non-string
 * projection is serialised, and two transports would decide differently.
 */
export interface MaterializedProjection {
  readonly unitId: string;
  readonly projectionRef: string;
  readonly content: ValueIR;
}

/**
 * `plan` is carried alongside the rendered content, not replaced by it. A caller
 * that only receives the content cannot see why a unit was selected or what the
 * budget did, and plan §3.6 makes that explanation a core contract.
 */
export interface QueryResult {
  readonly plan: SelectionPlanIR;
  readonly projections: readonly MaterializedProjection[];
}

/**
 * `idempotencyKey` is required, not optional, because `ActionRuntime.execute`
 * treats an empty key as the dry-run path. Letting it default would silently turn
 * a caller's real invocation into an unreplayable one.
 */
export interface ActionRequest {
  readonly action: string;
  readonly input: unknown;
  readonly context: RequestContext;
  readonly idempotencyKey: string;
  readonly dryRun?: boolean;
}

/** The uniform surface plan §10.2 describes, independent of how bytes travel. */
export interface EngineTransport {
  readonly kind: TransportKind;
  snapshot(): Promise<SnapshotRef>;
  plan(request: QueryRequest): Promise<SelectionPlanIR>;
  query(request: QueryRequest): Promise<QueryResult>;
  preflight(request: ActionRequest): Promise<EffectPlan>;
  execute(request: ActionRequest): Promise<ActionRun>;
  events(runId: string): Promise<readonly EventRecord[]>;
}

/**
 * Carries diagnostics for the same reason `QueryEngineError` does. Note what this
 * class is *not* used for: an error raised by the engine behind a transport is
 * re-thrown unchanged rather than wrapped, because wrapping it would make the
 * failure mode transport-dependent.
 */
export class SdkError extends Error {
  readonly diagnostics: readonly DiagnosticIR[];

  constructor(message: string, diagnostics: readonly DiagnosticIR[] = []) {
    super(message);
    this.name = "SdkError";
    this.diagnostics = diagnostics;
  }
}
