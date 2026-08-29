/**
 * @module test/access-control
 *
 * The assertions this package exists to make. Every one of them is about what an
 * unauthenticated or under-cleared caller can reach, and each drives the real
 * handler — the same function `startServer` binds to a socket — so none of them is
 * asserting about a mock.
 */

import { describe, expect, test } from "bun:test";
import { AuthConfigurationError, createBearerAuthenticator, parseCredentialSpec } from "../src/auth.ts";
import { ServerConfigurationError, assertBindable, startServer } from "../src/server.ts";
import { SERVER_OWNED_FIELDS } from "../src/wire.ts";
import {
  CLEARED_TOKEN,
  PUBLIC_TOKEN,
  UNIT_IDS,
  credentials,
  get,
  harness,
  post,
} from "./support/host.ts";

const query = (profile: string): unknown => ({ profile, maxTokens: 4000, text: "authentication" });

describe("an unauthenticated request reaches nothing", () => {
  test("POST /v1/query without an Authorization header is rejected and no plan is produced", async () => {
    const h = harness();
    const response = await h.handler(post("/v1/query", query(h.profile)));

    expect(response.status).toBe(401);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("UNAUTHENTICATED");
    // The body must not say *which* check failed: "missing header" versus
    // "unknown token" is a probing oracle.
    expect(body.message).toBe("Valid credentials are required.");
    // The engine was never reached: no plan span exists, so nothing was planned
    // and nothing was read out of the corpus.
    expect(h.sink.names().filter(name => name.startsWith("prime.query"))).toEqual([]);
  });

  test("every non-health route rejects an anonymous caller", async () => {
    const h = harness();
    const anonymous = [
      get("/v1/snapshot"),
      post("/v1/plan", query(h.profile)),
      post("/v1/query", query(h.profile)),
      get("/v1/resources"),
      get(`/v1/resources/${encodeURIComponent(UNIT_IDS.MFA)}/core`),
      get("/v1/corpora"),
      post("/v1/corpora/activate", { namespace: "n", release: "r" }),
    ];
    for (const request of anonymous) {
      const response = await h.handler(request);
      expect([401, 403]).toContain(response.status);
    }
  });

  test("a wrong token is 403 and a malformed scheme is 401", async () => {
    const h = harness();
    const wrong = await h.handler(post("/v1/query", query(h.profile), "x".repeat(48)));
    expect(wrong.status).toBe(403);

    const basic = new Request("http://127.0.0.1/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Basic dXNlcjpwdw==" },
      body: "{}",
    });
    expect((await h.handler(basic)).status).toBe(401);
  });

  test("/healthz is the only anonymous route, and it discloses nothing", async () => {
    const h = harness();
    const response = await h.handler(get("/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("an unauthenticated request to a real bound socket is rejected", async () => {
    const h = harness();
    const server = await startServer({
      authenticator: h.authenticator,
      engine: h.engine,
      tracer: h.tracer,
      transportFor: () => {
        throw new Error("the transport must never be built for an unauthenticated request");
      },
    });
    try {
      // Loopback is the default, asserted here rather than only in a unit test:
      // the value that matters is the one the socket was actually bound with.
      expect(server.hostname).toBe("127.0.0.1");
      const response = await fetch(`${server.url}/v1/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "any", maxTokens: 10 }),
      });
      expect(response.status).toBe(401);
      expect((await response.json() as { error: string }).error).toBe("UNAUTHENTICATED");
    } finally {
      await server.stop();
    }
  });
});

describe("the network cannot name its own principal", () => {
  test("a body carrying `principal` is rejected rather than silently overridden", async () => {
    const h = harness();
    const response = await h.handler(post("/v1/query", {
      ...query(h.profile) as Record<string, unknown>,
      principal: { id: "root", allowedVisibility: ["private", "shared", "public"], grantedPolicyLabels: ["contract-confidential"] },
    }, PUBLIC_TOKEN));

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; message: string; path: readonly string[] };
    expect(body.error).toBe("BAD_REQUEST");
    expect(body.path).toEqual(["principal"]);
    expect(body.message).toContain(SERVER_OWNED_FIELDS.principal);
  });

  test("a body carrying `requestId` is rejected, so a caller cannot collide two traces", async () => {
    const h = harness();
    const response = await h.handler(post("/v1/plan", {
      ...query(h.profile) as Record<string, unknown>,
      requestId: "fixed",
    }, PUBLIC_TOKEN));
    expect(response.status).toBe(400);
    expect((await response.json() as { path: readonly string[] }).path).toEqual(["requestId"]);
  });

  test("the credential's principal is what the engine plans against", async () => {
    const h = harness();
    const response = await h.handler(post("/v1/plan", query(h.profile), PUBLIC_TOKEN));
    expect(response.status).toBe(200);
    const { plan } = await response.json() as { plan: { query: Record<string, { id: string }> } };
    expect(plan.query.principal.id).toBe("reader");
  });
});

describe("the resource surface applies the engine's own admission", () => {
  test("a public principal does not see a private unit, and cannot tell it from a missing one", async () => {
    const h = harness();
    const listed = await (await h.handler(get("/v1/resources", PUBLIC_TOKEN))).json() as {
      resources: readonly { unitId: string }[];
    };
    const ids = new Set(listed.resources.map(resource => resource.unitId));
    expect(ids.has(UNIT_IDS.MFA)).toBe(true);
    expect(ids.has(UNIT_IDS.SECRET)).toBe(false);
    expect(ids.has(UNIT_IDS.LABELLED)).toBe(false);

    const denied = await h.handler(get(`/v1/resources/${encodeURIComponent(UNIT_IDS.SECRET)}/core`, PUBLIC_TOKEN));
    const absent = await h.handler(get(`/v1/resources/${encodeURIComponent("control-does-not-exist")}/core`, PUBLIC_TOKEN));
    expect(denied.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await denied.json()).toEqual(await absent.json());
  });

  test("a cleared principal sees both, over the same route", async () => {
    const h = harness();
    const listed = await (await h.handler(get("/v1/resources", CLEARED_TOKEN))).json() as {
      resources: readonly { unitId: string }[];
    };
    const ids = new Set(listed.resources.map(resource => resource.unitId));
    expect(ids.has(UNIT_IDS.SECRET)).toBe(true);
    expect(ids.has(UNIT_IDS.LABELLED)).toBe(true);

    const read = await h.handler(get(`/v1/resources/${encodeURIComponent(UNIT_IDS.SECRET)}/core`, CLEARED_TOKEN));
    expect(read.status).toBe(200);
    const { resource } = await read.json() as { resource: { content: string; visibility: string } };
    expect(resource.content).toBe(`${UNIT_IDS.SECRET} core`);
    expect(resource.visibility).toBe("private");
  });
});

describe("the authenticator refuses configurations that would protect nothing", () => {
  test("zero credentials", () => {
    expect(() => createBearerAuthenticator([])).toThrow(AuthConfigurationError);
  });

  test("a token too short to be a secret", () => {
    expect(() => createBearerAuthenticator([{ token: "short", principal: { id: "a", allowedVisibility: ["public"], grantedPolicyLabels: [] } }]))
      .toThrow(AuthConfigurationError);
  });

  test("two credentials sharing a token", () => {
    const [first] = credentials();
    expect(() => createBearerAuthenticator([first!, { ...first!, principal: { ...first!.principal, id: "other" } }]))
      .toThrow(AuthConfigurationError);
  });

  test("a credential spec must state visibility explicitly", () => {
    expect(() => parseCredentialSpec(`${PUBLIC_TOKEN}:reader::`)).toThrow(AuthConfigurationError);
    expect(() => parseCredentialSpec(`${PUBLIC_TOKEN}:reader:everything:`)).toThrow(AuthConfigurationError);
    const parsed = parseCredentialSpec(`${PUBLIC_TOKEN}:reader:public,shared:label-a,label-b`);
    expect(parsed).toEqual([{
      token: PUBLIC_TOKEN,
      principal: { id: "reader", allowedVisibility: ["public", "shared"], grantedPolicyLabels: ["label-a", "label-b"] },
    }]);
  });
});

describe("exposure beyond loopback is a decision, not a default", () => {
  test("a non-loopback bind without acknowledgement is refused", () => {
    const h = harness();
    expect(() => assertBindable({ hostname: "0.0.0.0", authenticator: h.authenticator }))
      .toThrow(ServerConfigurationError);
  });

  test("loopback needs no acknowledgement, and an acknowledged bind is allowed", () => {
    const h = harness();
    expect(() => assertBindable({ hostname: "127.0.0.1", authenticator: h.authenticator })).not.toThrow();
    expect(() => assertBindable({ hostname: "::1", authenticator: h.authenticator })).not.toThrow();
    expect(() => assertBindable({ hostname: "10.0.0.5", authenticator: h.authenticator, acknowledgeNonLoopbackExposure: true }))
      .not.toThrow();
  });
});
