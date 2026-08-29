/**
 * `@skill-wiki/plugin-host` — plan §12.
 *
 * Entry order mirrors the trust chain: what a plugin claims (`manifest`), what it
 * is allowed to name (`paths`), what it is allowed to do (`capabilities`), what
 * earned it the right to run at all (`trust`), the order those checks happen in
 * (`lifecycle`), where it runs (`executor`), and what the host records about it
 * (`events`).
 */

export {
  NO_CAPABILITIES,
  authorizeCapabilities,
  capabilityNamespace,
  capabilitySegments,
  checkCapability,
  isWellFormedCapability,
  type CapabilityDecision,
  type CapabilityGrantSet,
  type CapabilityRefusalCode,
} from "./capabilities.ts";

export {
  MANIFEST_FILENAME,
  PluginManifestSchema,
  loadManifest,
  parseManifest,
  type ManifestDiagnostic,
  type ManifestLoad,
  type ManifestParse,
  type PluginManifest,
  type PluginSignature,
  type SandboxPolicy,
} from "./manifest.ts";

export {
  PluginPathError,
  requireInRoot,
  resolveInRoot,
  type PathKind,
  type PathRejectionCode,
  type PathResolution,
} from "./paths.ts";

export {
  DEFAULT_SIGNATURE_POLICY,
  PluginDigestRegistry,
  checkProvenance,
  computePluginDigest,
  verifyPluginSignature,
  type ProvenancePolicy,
  type SignaturePolicy,
  type TrustRefusal,
  type TrustRefusalCode,
  type TrustResult,
} from "./trust.ts";

export {
  PluginLifecycle,
  SERVING_STATE,
  TERMINAL_STATES,
  type LifecycleEntry,
  type LifecycleState,
  type TransitionRefusalCode,
  type TransitionResult,
} from "./lifecycle.ts";

export {
  DEFAULT_EXECUTORS,
  PROCESS_SANDBOX_MODE,
  ProcessSandboxExecutor,
  createExecutor,
  type CallResult,
  type ExecutionRefusalCode,
  type ExecutorFactory,
  type ProcessExecutorOptions,
  type SandboxExecutor,
} from "./executor/process.ts";

export {
  FrameDecoder,
  encodeFrame,
  type ChildFrame,
  type FileReadRequest,
  type HostFrame,
  type NetworkRequest,
} from "./executor/protocol.ts";

export { FILESYSTEM_READ_CAPABILITY, type PluginContext, type PluginModule } from "./executor/plugin-api.ts";

export {
  REDACTED,
  ScopeError,
  collectingSink,
  hostEvent,
  scopeKey,
  type HostEvent,
  type HostEventInput,
  type HostEventKind,
  type HostEventSink,
  type Scope,
} from "./events.ts";

export { PluginHost, type HostPolicy, type PluginRecord, type RejectedPlugin } from "./host.ts";
