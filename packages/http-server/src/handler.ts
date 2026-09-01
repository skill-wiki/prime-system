/**
 * @module handler
 *
 * The HTTP surface itself, expressed as `(Request) => Promise<Response>`.
 *
 * It is a bare fetch handler rather than a framework app for two reasons. It is
 * testable without opening a socket — every test in this package drives it with a
 * constructed `Request`, so "an unauthenticated request is rejected" is asserted
 * against the same code path production uses, not against a mock. And it adds no
 * dependency: the one HTTP framework already in this repo (`hono`, in
 * `packages/registry`) is not installed, so taking it would make this package
 * unrunnable in the tree it ships in.
 *
 * ## Order of operations, which is the security contract
 *
 * 1. Authenticate. Nothing else — not routing, not body parsing — happens first.
 *    Parsing before authenticating would expose the decoder's surface to an
 *    unauthenticated caller, and route matching before authenticating would let
 *    a 404-vs-401 difference enumerate the API.
 * 2. Resolve the principal from the credential. The body cannot name one
 *    (`./wire.ts`).
 * 3. Route, decode, execute.
 *
 * `/healthz` is the single documented exception, and it answers `{"status":"ok"}`
 * and nothing else — no snapshot, no corpus identity, no version. A liveness probe
 * that needs a credential is a liveness probe operators disable; a liveness probe
 * that discloses which corpus release is serving is an information leak. Both
 * failure modes are avoided by the endpoint having no content.
 */

import type { SelectionPlanIR } from "@skill-wiki/ir";
import {
  TRACEPARENT_HEADER,
  formatTraceparent,
  generateTraceId,
  parseTraceparent,
  type Span,
  type SpanContext,
  type Tracer,
} from "@skill-wiki/observability";
import { QueryEngineError, type Principal, type QueryEngineContext } from "@skill-wiki/query-engine";
import type { EngineTransport, QueryResult } from "@skill-wiki/sdk";
import type { Authenticator } from "./auth.ts";
import { switchRelease, type TraceScope } from "./corpus.ts";
import type { CorpusRegistry } from "@skill-wiki/runtime";
import { RESOURCE_PATH_PREFIX, listResources, readResource } from "./resources.ts";
import { WireError, decodeQueryRequest, readJsonBody } from "./wire.ts";

export const SPAN_HTTP_REQUEST = "aoe.http.request";
export const HEALTH_PATH = "/healthz";

export interface HandlerOptions {
  /**
   * Required, with no anonymous alternative. A boolean `auth?: false` escape hatch
   * is exactly what turns into a production incident, so the type does not offer one.
   */
  readonly authenticator: Authenticator;
  /**
   * Builds the transport for one request, given the trace scope it should attach
   * its spans to. A factory rather than a transport because `EngineTransport`
   * carries no per-call context (plan §10.4 forbids widening it), so per-request
   * parenting has to come from construction — which for the embedded transport is
   * one object literal.
   */
  readonly transportFor: (scope: TraceScope) => EngineTransport;
  /** Read by the resource surface, which addresses units directly rather than through a plan. */
  readonly engine: QueryEngineContext;
  readonly tracer: Tracer;
  /** Present only when this deployment allows a release switch over HTTP. */
  readonly registry?: CorpusRegistry;
  /** Injected so a test can assert a deterministic `requestId`. */
  readonly newRequestId?: () => string;
}

interface Failure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly path?: readonly string[];
}

function json(body: unknown, status: number, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A JSON API that is never a browser document should say so: it removes
      // sniffing-based XSS from the threat model outright.
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function failure(f: Failure): Response {
  return json(f.path === undefined ? { error: f.code, message: f.message } : { error: f.code, message: f.message, path: f.path }, f.status);
}

/** `SelectionPlanIR` is already a plain, serialisable value; no projection needed. */
function planBody(plan: SelectionPlanIR): unknown {
  return { plan };
}

function queryBody(result: QueryResult): unknown {
  return { plan: result.plan, projections: result.projections };
}

/**
 * Maps a thrown value to a response.
 *
 * `QueryEngineError` becomes 400 with its diagnostics: those describe a request
 * the model cannot satisfy (an undeclared profile, a non-positive budget), which
 * is the caller's problem and safe to return — the engine writes them for a
 * caller, not for an operator. Everything else becomes an opaque 500. Returning a
 * stack trace or an arbitrary `Error.message` to a network caller is how internal
 * paths and dependency versions leak; the span already carries the exception for
 * the operator who needs it.
 */
function toResponse(error: unknown, span: Span): Response {
  span.recordException(error);
  if (error instanceof WireError) {
    return failure({ status: error.status, code: "BAD_REQUEST", message: error.message, path: error.path });
  }
  if (error instanceof QueryEngineError) {
    return failure({
      status: 400,
      code: "QUERY_REJECTED",
      message: error.message,
      path: error.diagnostics.flatMap(diagnostic => diagnostic.path ?? []),
    });
  }
  return failure({ status: 500, code: "INTERNAL", message: "The server failed to handle this request." });
}

/**
 * The one place this package reads the HTTP verb.
 *
 * Collapsed to a single site on purpose. `method` is a declared type name in the
 * Model Package the ZDS vocabulary gate is calibrated against, and its
 * `http-request-method` exemption only matches the literal shape
 * `method: "POST"` — not a property read on a standard `Request`. Reading it once
 * means the exemption that clears this (a genuine false positive: an HTTP server
 * cannot avoid `Request.method`) is one path-anchored line rather than a pattern
 * that would also clear real occurrences. See the lane report: the vocabulary
 * fixture lives in `packages/testkit`, which this lane does not own.
 */
function verbOf(request: Request): string {
  return request.method;
}

function parentFor(request: Request): SpanContext | undefined {
  const header = request.headers.get(TRACEPARENT_HEADER);
  if (header === null) return undefined;
  const parsed = parseTraceparent(header);
  // An unparsable header starts a new trace rather than failing the request: a
  // broken upstream tracer must not be able to take a query down.
  return parsed.ok ? parsed.value : undefined;
}

export function createRequestHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const newRequestId = options.newRequestId ?? generateTraceId;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const verb = verbOf(request);
    if (url.pathname === HEALTH_PATH) {
      return verb === "GET"
        ? json({ status: "ok" }, 200)
        : failure({ status: 405, code: "METHOD_NOT_ALLOWED", message: `${HEALTH_PATH} accepts GET` });
    }

    const parent = parentFor(request);
    const span = options.tracer.startSpan(SPAN_HTTP_REQUEST, {
      kind: "server",
      ...(parent === undefined ? {} : { parent }),
      attributes: {
        // `http.request.method` and `url.path` are OTel semantic-convention keys,
        // so a collector's HTTP dashboards work without per-deployment mapping.
        "http.request.method": verb,
        "url.path": url.pathname,
      },
    });

    try {
      const auth = options.authenticator.authenticate(request.headers);
      if (!auth.ok) {
        // The reason goes on the span, not into the body, and the body carries no
        // hint of which check failed. `WWW-Authenticate` is sent on 401 because
        // that is what makes a client retry with a credential rather than treat
        // the failure as permanent.
        span.setAttributes({ "aoe.auth_denied": true, "aoe.auth_reason": auth.reason, "http.response.status_code": auth.status });
        span.setStatus({ code: "error", message: auth.reason });
        span.end();
        return failure({ status: auth.status, code: "UNAUTHENTICATED", message: "Valid credentials are required." });
      }
      span.setAttribute("aoe.principal_id", auth.principal.id);

      const response = await route(request, url, verb, auth.principal, span, options, newRequestId);
      span.setAttribute("http.response.status_code", response.status);
      span.setStatus({ code: response.status < 500 ? "ok" : "error" });
      span.end();
      // Handed back so a caller can stitch its own spans onto this trace.
      const headers = new Headers(response.headers);
      headers.set(TRACEPARENT_HEADER, formatTraceparent(span.context));
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const response = toResponse(error, span);
      span.setAttribute("http.response.status_code", response.status);
      span.end();
      return response;
    }
  };
}

async function route(
  request: Request,
  url: URL,
  verb: string,
  principal: Principal,
  span: Span,
  options: HandlerOptions,
  newRequestId: () => string,
): Promise<Response> {
  const scope: TraceScope = { tracer: options.tracer, parent: span.context };

  if (url.pathname === "/v1/snapshot") {
    if (verb !== "GET") return failure({ status: 405, code: "METHOD_NOT_ALLOWED", message: "/v1/snapshot accepts GET" });
    return json({ snapshot: await options.transportFor(scope).snapshot() }, 200);
  }

  if (url.pathname === "/v1/plan" || url.pathname === "/v1/query") {
    if (verb !== "POST") {
      return failure({ status: 405, code: "METHOD_NOT_ALLOWED", message: `${url.pathname} accepts POST` });
    }
    const requestId = newRequestId();
    span.setAttribute("aoe.request_id", requestId);
    const decoded = decodeQueryRequest(await readJsonBody(request), { principal, requestId });
    const transport = options.transportFor(scope);
    return url.pathname === "/v1/plan"
      ? json(planBody(await transport.plan(decoded)), 200)
      : json(queryBody(await transport.query(decoded)), 200);
  }

  if (url.pathname === RESOURCE_PATH_PREFIX) {
    if (verb !== "GET") return failure({ status: 405, code: "METHOD_NOT_ALLOWED", message: `${RESOURCE_PATH_PREFIX} accepts GET` });
    const resources = listResources(options.engine, principal);
    span.setAttribute("aoe.listed_resources", resources.length);
    return json({ resources }, 200);
  }

  if (url.pathname.startsWith(`${RESOURCE_PATH_PREFIX}/`)) {
    if (verb !== "GET") return failure({ status: 405, code: "METHOD_NOT_ALLOWED", message: `${RESOURCE_PATH_PREFIX}/… accepts GET` });
    const segments = url.pathname.slice(RESOURCE_PATH_PREFIX.length + 1).split("/");
    if (segments.length !== 2) {
      return failure({ status: 404, code: "NOT_FOUND", message: "A resource path is /v1/resources/<unitId>/<projectionRef>." });
    }
    const [unitId, projectionRef] = segments.map(decodeURIComponent) as [string, string];
    const found = readResource(options.engine, principal, unitId, projectionRef);
    if (!found.ok) return failure({ status: 404, code: "NOT_FOUND", message: found.reason });
    return json({ resource: found.value }, 200);
  }

  if (url.pathname === "/v1/corpora") {
    if (verb !== "GET") return failure({ status: 405, code: "METHOD_NOT_ALLOWED", message: "/v1/corpora accepts GET" });
    if (options.registry === undefined) {
      return failure({ status: 404, code: "NOT_FOUND", message: "This deployment exposes no corpus registry." });
    }
    return json({
      namespaces: options.registry.namespaces().map(namespace => ({
        namespace,
        activeRelease: options.registry!.activeRelease(namespace) ?? null,
        releases: options.registry!.releasesOf(namespace),
      })),
    }, 200);
  }

  if (url.pathname === "/v1/corpora/activate") {
    if (verb !== "POST") return failure({ status: 405, code: "METHOD_NOT_ALLOWED", message: "/v1/corpora/activate accepts POST" });
    if (options.registry === undefined) {
      return failure({ status: 404, code: "NOT_FOUND", message: "This deployment exposes no corpus registry." });
    }
    const body = await readJsonBody(request);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new WireError("request body must be a JSON object");
    }
    const record = body as Record<string, unknown>;
    const namespace = record.namespace;
    const release = record.release;
    if (typeof namespace !== "string" || namespace.length === 0) throw new WireError("namespace must be a non-empty string", ["namespace"]);
    if (typeof release !== "string" || release.length === 0) throw new WireError("release must be a non-empty string", ["release"]);
    const outcome = switchRelease(options.registry, namespace, release, scope);
    return outcome.ok
      ? json({ namespace: outcome.namespace, release: outcome.release, previous: outcome.previous ?? null }, 200)
      : failure({ status: 409, code: outcome.code, message: outcome.reason });
  }

  return failure({ status: 404, code: "NOT_FOUND", message: "No such endpoint." });
}
