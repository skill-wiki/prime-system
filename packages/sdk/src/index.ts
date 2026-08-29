/**
 * @module @skill-wiki/sdk
 *
 * Layer 2 of plan §10.1 — the Engine client. It owns the uniform Query/Plan/Action/
 * Events surface, the transport SPI, and the generated-artifact digest gate that
 * layer 3 (Model-generated SDK, produced by `@skill-wiki/sdk-codegen`) stamps and
 * relies on.
 *
 * It owns no domain vocabulary: there is not one type name, relation name, facet
 * name or projection name in this package. Everything the caller names is either
 * structural (`UnitIR` field paths) or supplied by the Model Package.
 */

export { PrimeClient } from "./client.ts";
export { createEmbeddedTransport, type EmbeddedHost } from "./embedded.ts";
export {
  GENERATED_ARTIFACT_PROTOCOL,
  ModelDigestMismatchError,
  assertGeneratedArtifactUsable,
  parseGeneratedArtifactHeader,
  type GeneratedArtifactHeader,
  type GeneratedModelRef,
} from "./generated-artifact.ts";
export {
  SdkError,
  type ActionRequest,
  type EngineTransport,
  type MaterializedProjection,
  type QueryResult,
  type TransportKind,
} from "./types.ts";

/**
 * Re-exported so a *generated* model SDK needs exactly one dependency edge
 * (`@skill-wiki/sdk`) instead of also naming the engine package that happens to
 * own the run types today. A generated file is not hand-maintained, so every extra
 * import it carries is an extra thing a package split can break.
 */
export type { ActionRun, EffectPlan, EventRecord, RequestContext } from "@skill-wiki/action-runtime";
export type { QueryRequest } from "@skill-wiki/query-engine";
export type { SelectionPlanIR, SnapshotRef } from "@skill-wiki/ir";
