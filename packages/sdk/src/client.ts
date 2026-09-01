/**
 * @module client
 *
 * `AoeClient` from plan §10.2. It is intentionally a thin façade: it holds the
 * activated snapshot and the generated-artifact gate, and forwards everything else
 * to the transport. Any logic that lived here would be logic the embedded and
 * remote paths could execute differently.
 */

import type { SelectionPlanIR, SnapshotRef } from "@aoe/ir";
import type { QueryRequest } from "@aoe/query-engine";
import type { ActionRun, EffectPlan, EventRecord } from "@aoe/action-runtime";
import {
  assertGeneratedArtifactUsable,
  parseGeneratedArtifactHeader,
  type GeneratedArtifactHeader,
} from "./generated-artifact.ts";
import type { ActionRequest, EngineTransport, QueryResult, TransportKind } from "./types.ts";

export class AoeClient {
  private readonly transport: EngineTransport;

  constructor(options: { readonly transport: EngineTransport }) {
    this.transport = options.transport;
  }

  get transportKind(): TransportKind {
    return this.transport.kind;
  }

  /**
   * The activated immutable snapshot (plan §8.5). Asked of the transport on every
   * call rather than cached at construction: a cached value would keep reporting an
   * old identity after a remote engine rolled forward, and the digest gate below
   * would then be checking against a snapshot that is no longer serving.
   */
  snapshot(): Promise<SnapshotRef> {
    return this.transport.snapshot();
  }

  plan(request: QueryRequest): Promise<SelectionPlanIR> {
    return this.transport.plan(request);
  }

  query(request: QueryRequest): Promise<QueryResult> {
    return this.transport.query(request);
  }

  preflight(request: ActionRequest): Promise<EffectPlan> {
    return this.transport.preflight(request);
  }

  execute(request: ActionRequest): Promise<ActionRun> {
    return this.transport.execute(request);
  }

  events(runId: string): Promise<readonly EventRecord[]> {
    return this.transport.events(runId);
  }

  /**
   * Plan §14.3's pre-call verification. Accepts an unvalidated value so a caller
   * can hand over a header it just imported from a generated file without asserting
   * its shape first — the shape check and the digest check are the same gate.
   *
   * Returns the verified header so a caller can use it in one expression; throws
   * `ModelDigestMismatchError` (or `SdkError`) otherwise. There is no boolean
   * variant on purpose: a boolean is ignorable, and this gate exists because a
   * stale generated SDK must not be able to issue a call.
   */
  async verifyGeneratedArtifact(header: unknown): Promise<GeneratedArtifactHeader> {
    const parsed = parseGeneratedArtifactHeader(header);
    assertGeneratedArtifactUsable(parsed, await this.snapshot());
    return parsed;
  }
}
