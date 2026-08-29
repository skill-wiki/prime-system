/**
 * @module wire
 *
 * Decoding an HTTP body into a `QueryRequest`, and encoding a plan back out.
 *
 * Hand-written rather than schema-generated, for one reason: `QueryRequest` is the
 * engine's type, and the only correct decoder is one that fails on anything the
 * engine would not accept *and* on anything the engine would accept but the
 * network must not be allowed to say. The second half is not expressible as a
 * shape check — `principal` is a perfectly valid `QueryRequest` field and a
 * privilege escalation over HTTP — so the rejection lives here, next to the
 * comment explaining it, rather than inside a generated validator.
 *
 * `requestId` is likewise refused from the body. It is the correlation key that
 * ties a span, a plan and a log line together; a caller able to choose it can
 * make two different requests indistinguishable in the trace, which is the one
 * thing the id exists to prevent.
 */

import type { ValueIR } from "@skill-wiki/ir";
import type { FacetSelector, Principal, QueryRequest, UnitLifecycle } from "@skill-wiki/query-engine";

/** Fields a caller may not set, and why, quoted into the error it gets back. */
export const SERVER_OWNED_FIELDS: Readonly<Record<string, string>> = {
  principal: "the principal is derived from the presented credential, never from the request body",
  requestId: "the request id is assigned by the server so it can correlate a trace with a plan",
};

export class WireError extends Error {
  readonly status: 400;
  readonly path: readonly string[];

  constructor(message: string, path: readonly string[] = []) {
    super(message);
    this.name = "WireError";
    this.status = 400;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, path: readonly string[]): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WireError(`${path.join(".")} must be a non-empty string`, path);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: readonly string[]): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new WireError(`${path.join(".")} must be a positive integer`, path);
  }
  return value;
}

function requireStringArray(value: unknown, path: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new WireError(`${path.join(".")} must be an array of strings`, path);
  return value.map((item, index) => requireString(item, [...path, String(index)]));
}

const LIFECYCLES = new Set(["draft", "active", "deprecated", "deleted"]);

function decodeFacet(value: unknown, path: readonly string[]): FacetSelector {
  if (!isRecord(value)) throw new WireError(`${path.join(".")} must be an object`, path);
  const kind = requireString(value.kind, [...path, "kind"]);
  if (kind === "typeRef" || kind === "implements") {
    return { kind, anyOf: requireStringArray(value.anyOf, [...path, "anyOf"]) };
  }
  if (kind === "field") {
    if (!Array.isArray(value.anyOf)) throw new WireError(`${path.join(".")}.anyOf must be an array`, [...path, "anyOf"]);
    return {
      kind: "field",
      path: requireStringArray(value.path, [...path, "path"]),
      // `ValueIR` is the engine's own open value domain, so a facet value is
      // passed through rather than narrowed here. Narrowing it would make this
      // transport decide which field values are addressable.
      anyOf: value.anyOf as readonly ValueIR[],
    };
  }
  throw new WireError(
    `${path.join(".")}.kind must be one of typeRef/implements/field`,
    [...path, "kind"],
  );
}

function decodeFacets(value: unknown, path: readonly string[]): readonly FacetSelector[] {
  if (!Array.isArray(value)) throw new WireError(`${path.join(".")} must be an array`, path);
  return value.map((item, index) => decodeFacet(item, [...path, String(index)]));
}

export interface DecodeOptions {
  /** Resolved from the credential by `./auth.ts`. */
  readonly principal: Principal;
  /** Assigned by the server, not the caller. */
  readonly requestId: string;
}

export function decodeQueryRequest(body: unknown, options: DecodeOptions): QueryRequest {
  if (!isRecord(body)) throw new WireError("request body must be a JSON object");
  for (const [field, why] of Object.entries(SERVER_OWNED_FIELDS)) {
    if (field in body) throw new WireError(`'${field}' must not appear in the request body: ${why}`, [field]);
  }

  const request: {
    requestId: string;
    profile: string;
    principal: Principal;
    maxTokens: number;
    text?: string;
    seeds?: readonly string[];
    facets?: readonly FacetSelector[];
    requiredFacets?: readonly FacetSelector[];
    lifecycles?: readonly UnitLifecycle[];
    limit?: number;
    fallbackProjections?: readonly string[];
  } = {
    requestId: options.requestId,
    principal: options.principal,
    profile: requireString(body.profile, ["profile"]),
    maxTokens: requirePositiveInteger(body.maxTokens, ["maxTokens"]),
  };

  if (body.text !== undefined) request.text = requireString(body.text, ["text"]);
  if (body.seeds !== undefined) request.seeds = requireStringArray(body.seeds, ["seeds"]);
  if (body.facets !== undefined) request.facets = decodeFacets(body.facets, ["facets"]);
  if (body.requiredFacets !== undefined) request.requiredFacets = decodeFacets(body.requiredFacets, ["requiredFacets"]);
  if (body.lifecycles !== undefined) {
    const lifecycles = requireStringArray(body.lifecycles, ["lifecycles"]);
    for (const [index, value] of lifecycles.entries()) {
      if (!LIFECYCLES.has(value)) {
        throw new WireError(`lifecycles.${index} must be one of draft/active/deprecated/deleted`, ["lifecycles", String(index)]);
      }
    }
    request.lifecycles = lifecycles as readonly UnitLifecycle[];
  }
  if (body.limit !== undefined) request.limit = requirePositiveInteger(body.limit, ["limit"]);
  if (body.fallbackProjections !== undefined) {
    request.fallbackProjections = requireStringArray(body.fallbackProjections, ["fallbackProjections"]);
  }
  return request;
}

/**
 * Parses a JSON body, turning a syntax error into a `WireError`.
 *
 * A malformed body is a client mistake, so it must surface as 400. Left
 * unhandled, `Response.json()` rejecting would reach the handler's catch-all and
 * be reported as a 500 — which tells an operator their server is broken when in
 * fact it is working correctly.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new WireError("request Content-Type must be application/json");
  }
  const raw = await request.text();
  if (raw.trim().length === 0) throw new WireError("request body must not be empty");
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new WireError(`request body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
