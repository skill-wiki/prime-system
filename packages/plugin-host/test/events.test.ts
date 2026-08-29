import { describe, expect, test } from "bun:test";
import { REDACTED, ScopeError, collectingSink, hostEvent, scopeKey, type Scope } from "../src/events.ts";

const scope: Scope = {
  tenant: "acme",
  workspace: "ws-1",
  corpus: "ops",
  release: "2026.08.1",
  unitId: "unit-7",
  version: "1.2.3",
  digest: "sha256:abc",
};

describe("Secret 不进入 event payload (§12.3)", () => {
  test("a secret passed as a secret never appears in the payload", () => {
    const token = "sk-live-9f3c2a";
    const event = hostEvent({ kind: "plugin.effect.granted", plugin: "http", scope, secrets: { apiToken: token } });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(event.payload["apiToken"]).toBe(REDACTED);
  });

  /**
   * The key IS reported. A silently dropped secret is indistinguishable from a
   * secret that was never there, which makes an audit log unable to answer "did
   * this call carry a credential?".
   */
  test("the withheld key names what was withheld", () => {
    const event = hostEvent({ kind: "plugin.call", plugin: "http", scope, secrets: { apiToken: "x", cookie: "y" } });
    expect(event.withheld).toEqual(["apiToken", "cookie"]);
  });

  test("a value that is secret in both places is redacted, not merged", () => {
    const event = hostEvent({
      kind: "plugin.call",
      plugin: "http",
      scope,
      payload: { apiToken: "leaked-through-payload", method: "send" },
      secrets: { apiToken: "leaked-through-payload" },
    });
    expect(event.payload["apiToken"]).toBe(REDACTED);
    expect(event.payload["method"]).toBe("send");
    expect(JSON.stringify(event)).not.toContain("leaked-through-payload");
  });

  test("a non-string secret is still not serialised", () => {
    const event = hostEvent({ kind: "plugin.call", plugin: "http", scope, secrets: { key: { pem: "-----BEGIN-----" } } });
    expect(JSON.stringify(event)).not.toContain("BEGIN");
  });

  test("ordinary payload values pass through untouched", () => {
    const event = hostEvent({ kind: "plugin.discovered", plugin: "http", scope, payload: { provides: ["action-executor:http"] } });
    expect(event.payload["provides"]).toEqual(["action-executor:http"]);
    expect(event.withheld).toEqual([]);
  });
});

describe("scopeKey — the full §12.4 tuple or nothing", () => {
  test("all seven components are present and ordered", () => {
    expect(scopeKey(scope)).toBe("acme/ws-1/ops/2026.08.1/unit-7/1.2.3/sha256%3Aabc");
  });

  test("a missing component is refused rather than defaulted", () => {
    expect(() => scopeKey({ ...scope, tenant: "" })).toThrow(ScopeError);
    try {
      scopeKey({ ...scope, tenant: "", digest: "  " });
    } catch (error) {
      expect((error as ScopeError).missing).toEqual(["tenant", "digest"]);
    }
  });

  /**
   * Without escaping, tenant `a/b` + workspace `c` and tenant `a` + workspace
   * `b/c` produce the same key — two tenants sharing one cache entry, failing
   * silently and identically to working.
   */
  test("separators inside a component cannot forge another component", () => {
    const forged = scopeKey({ ...scope, tenant: "acme/ws-1", workspace: "ops" });
    expect(forged).not.toBe(scopeKey(scope));
  });

  test("two tenants never share a key", () => {
    expect(scopeKey({ ...scope, tenant: "other" })).not.toBe(scopeKey(scope));
  });

  test("an event carries the scope key, not the loose fields", () => {
    const { sink, events } = collectingSink();
    sink(hostEvent({ kind: "plugin.state", plugin: "http", scope, payload: { state: "serving" } }));
    expect(events).toHaveLength(1);
    expect(events[0]?.scopeKey).toBe(scopeKey(scope));
  });
});
