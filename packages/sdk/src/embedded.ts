/**
 * @module embedded
 *
 * The in-process transport of plan §10.4. It performs no selection, no scoring,
 * no policy and no validation of its own: every call is a delegation to the
 * engine package that owns that semantic, which is the only way the "transport
 * does not change core semantics" invariant can be *checked* rather than asserted
 * (see `test/semantic-invariance.test.ts`, which compares this transport's plan
 * against a direct `planSelection` call).
 *
 * What it deliberately does NOT do is read a filesystem bundle. Turning a corpus
 * bundle directory into `GraphIR` is an adapter that already exists once in this
 * repo (`mcp-server-core/src/corpus-graph.ts` `buildCorpusGraph`); re-implementing
 * it here would produce a second bridge that can disagree with the first, which is
 * the failure mode this refactor exists to remove. So the host supplies the graph,
 * and the bundle→graph adapter stays a single implementation that both the MCP
 * server and an SDK host can call. The report for this lane recommends moving that
 * adapter out of the MCP package for exactly this reason.
 */

import type { SelectionPlanIR, SnapshotRef, ValueIR } from "@skill-wiki/ir";
import {
  planSelection,
  type CandidateGeneratorRegistry,
  type QueryEngineContext,
  type QueryRequest,
} from "@skill-wiki/query-engine";
import type { ActionRun, EffectPlan, EventRecord } from "@skill-wiki/action-runtime";
import type { ActionRuntime } from "@skill-wiki/action-runtime";
import {
  SdkError,
  type ActionRequest,
  type EngineTransport,
  type MaterializedProjection,
  type QueryResult,
} from "./types.ts";

export interface EmbeddedHost {
  readonly snapshot: SnapshotRef;
  /** Graph, profiles, relations and projections, exactly as `query-engine` wants them. */
  readonly engine: QueryEngineContext;
  readonly generators: CandidateGeneratorRegistry;
  /** Hop ceiling for `transitive` relations, forwarded unchanged to the engine. */
  readonly maxExpansionDepth?: number;
  /**
   * Absent when the host activated a read-only snapshot. It is optional rather
   * than a no-op stub because a no-op would answer an action call with a fake
   * success; absent means every action call rejects with a stated reason.
   */
  readonly actions?: ActionRuntime;
}

/**
 * Render the plan's own projection assignments. The mapping comes from
 * `plan.projectionLoads`, so what gets rendered at which tier is the plan's
 * decision and not this transport's.
 */
function materialize(plan: SelectionPlanIR, engine: QueryEngineContext): readonly MaterializedProjection[] {
  const byId = new Map(engine.graph.units.map(unit => [unit.identity.id, unit]));
  const out: MaterializedProjection[] = [];
  for (const load of plan.projectionLoads) {
    for (const unitId of load.unitIds) {
      const unit = byId.get(unitId);
      // A plan naming a unit the graph does not hold means the plan and the graph
      // came from different snapshots. Returning the rest would hand the caller a
      // silently short answer.
      if (unit === undefined) {
        throw new SdkError(`Plan ${plan.requestId} selected unit '${unitId}', which is not in the activated graph`);
      }
      const content: ValueIR | undefined = unit.projections[load.projectionRef];
      if (content === undefined) {
        throw new SdkError(
          `Unit '${unitId}' carries no '${load.projectionRef}' projection, so the plan cannot be materialised`,
        );
      }
      out.push({ unitId, projectionRef: load.projectionRef, content });
    }
  }
  return out;
}

function requireActions(host: EmbeddedHost): ActionRuntime {
  if (host.actions === undefined) {
    throw new SdkError("This embedded host activated no action runtime, so actions are unavailable");
  }
  return host.actions;
}

export function createEmbeddedTransport(host: EmbeddedHost): EngineTransport {
  const options = host.maxExpansionDepth === undefined
    ? { generators: host.generators }
    : { generators: host.generators, maxExpansionDepth: host.maxExpansionDepth };

  // Errors from the engine propagate unchanged (no try/catch here): a
  // `QueryEngineError` must look the same to a caller whether it arrived in
  // process or over a socket.
  const plan = async (request: QueryRequest): Promise<SelectionPlanIR> =>
    planSelection(request, host.engine, options);

  return {
    kind: "embedded",
    snapshot: async (): Promise<SnapshotRef> => host.snapshot,
    plan,
    query: async (request: QueryRequest): Promise<QueryResult> => {
      const selection = await plan(request);
      return { plan: selection, projections: materialize(selection, host.engine) };
    },
    preflight: async (request: ActionRequest): Promise<EffectPlan> =>
      requireActions(host).preflight(request.action, request.input, request.context),
    execute: async (request: ActionRequest): Promise<ActionRun> =>
      requireActions(host).execute(
        request.action,
        request.input,
        request.context,
        request.idempotencyKey,
        request.dryRun ?? false,
      ),
    events: async (runId: string): Promise<readonly EventRecord[]> => requireActions(host).events(runId),
  };
}
