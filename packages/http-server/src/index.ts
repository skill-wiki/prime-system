/**
 * @module @aoe/http-server
 *
 * The HTTP transport of plan §10.4 (`TransportKind: "remote"` seen from a client),
 * and the Phase 5 `http-server` package.
 *
 * It exposes the capabilities the kernel already has — snapshot, plan, query, and
 * a single-projection resource read — and adds none. Every route is a delegation:
 * planning and querying go to an `EngineTransport`, admission goes to
 * `query-engine`'s `admit`, corpus mounting goes to `runtime`'s `CorpusRegistry`.
 * The only semantics this package owns are the ones a network boundary
 * necessarily introduces: authentication, principal resolution, request decoding,
 * error redaction and HTTP-level spans.
 *
 * ## Security posture, stated rather than assumed
 *
 * - **Every route except `/healthz` requires a bearer credential.** There is no
 *   anonymous mode and no flag that creates one.
 * - **The principal comes from the credential.** A body naming a `principal` is
 *   rejected with 400 — `QueryRequest.principal` is the engine's whole ACL input,
 *   so a caller able to set it could read every `private` and policy-labelled unit.
 * - **Loopback by default.** Binding a non-loopback address requires
 *   `acknowledgeNonLoopbackExposure: true`.
 * - **No transport-layer encryption here.** Bearer tokens travel in cleartext, so
 *   a non-loopback deployment must terminate TLS in front of this process. This
 *   package deliberately does not offer an `https` option: an in-process TLS
 *   listener that nobody renews certificates for is worse than an explicit
 *   dependency on a reverse proxy.
 * - **No rate limiting and no request-size cap.** A query is a bounded amount of
 *   work (`maxTokens` is validated, `limit` is validated) but candidate generation
 *   over a large corpus is not free, so an authenticated caller can load the
 *   process. Acceptable for a credentialed, loopback-default surface; it is a real
 *   gap for a multi-tenant deployment. See the lane report.
 */

export {
  AUTHORIZATION_HEADER,
  AuthConfigurationError,
  BEARER_PREFIX,
  MIN_TOKEN_LENGTH,
  createBearerAuthenticator,
  isLoopbackHost,
  parseCredentialSpec,
  type AuthOutcome,
  type Authenticator,
  type Credential,
} from "./auth.ts";

export {
  HEALTH_PATH,
  SPAN_HTTP_REQUEST,
  createRequestHandler,
  type HandlerOptions,
} from "./handler.ts";

export {
  EVENT_CORPUS_MOUNTED,
  EVENT_CORPUS_MOUNT_FAILED,
  EVENT_CORPUS_SWITCHED,
  SPAN_CORPUS_ACTIVATE,
  SPAN_CORPUS_MOUNT,
  describeMount,
  mountCorpora,
  switchRelease,
  type MountOutcome,
  type SwitchOutcome,
  type TraceScope,
} from "./corpus.ts";

export {
  RESOURCE_PATH_PREFIX,
  listResources,
  readResource,
  resourceHref,
  type ResourceContent,
  type ResourceDescriptor,
  type ResourceLookup,
} from "./resources.ts";

export {
  ServerConfigurationError,
  assertBindable,
  describeExposure,
  startServer,
  type RunningServer,
  type ServeOptions,
} from "./server.ts";

export {
  SERVER_OWNED_FIELDS,
  WireError,
  decodeQueryRequest,
  readJsonBody,
  type DecodeOptions,
} from "./wire.ts";
