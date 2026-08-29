import { describe, expect, test } from "bun:test";
import { PluginLifecycle, TERMINAL_STATES } from "../src/lifecycle.ts";

describe("PluginLifecycle — §12.2 order is enforced, not documented", () => {
  test("the full chain runs in the declared order", () => {
    const lifecycle = new PluginLifecycle();
    expect(lifecycle.state).toBe("discovered");
    for (const state of ["verified", "dependencies-resolved", "authorized", "initialized", "healthy", "serving", "draining", "stopped"] as const) {
      expect(lifecycle.advance(state).ok).toBe(true);
      expect(lifecycle.state).toBe(state);
    }
  });

  /**
   * The security-relevant refusal: `authorize capabilities` precedes
   * `initialize`, so a host that tried to initialize a freshly discovered plugin
   * would be loading code before the grant set existed.
   */
  test("initialize cannot skip authorization", () => {
    const lifecycle = new PluginLifecycle();
    const result = lifecycle.advance("initialized");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LIFECYCLE_OUT_OF_ORDER");
      expect(result.reason).toContain("verified");
    }
    expect(lifecycle.state).toBe("discovered");
  });

  test("serving cannot be reached directly from discovered", () => {
    const lifecycle = new PluginLifecycle();
    expect(lifecycle.advance("serving").ok).toBe(false);
    expect(lifecycle.isServing).toBe(false);
  });

  test("advanceTo walks the chain and stops at the first refusal", () => {
    const lifecycle = new PluginLifecycle();
    expect(lifecycle.advanceTo("serving").ok).toBe(true);
    expect(lifecycle.state).toBe("serving");
    // Backwards is not reachable: there is no retry edge.
    const back = lifecycle.advanceTo("verified");
    expect(back.ok).toBe(false);
  });

  test("failure records why, and is terminal", () => {
    const lifecycle = new PluginLifecycle();
    lifecycle.advance("verified");
    expect(lifecycle.fail("SIGNATURE_DIGEST_MISMATCH: bytes changed").ok).toBe(true);
    expect(lifecycle.state).toBe("failed");
    expect(TERMINAL_STATES.has(lifecycle.state)).toBe(true);
    expect(lifecycle.history.at(-1)?.detail).toContain("SIGNATURE_DIGEST_MISMATCH");
    const after = lifecycle.advance("dependencies-resolved");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe("LIFECYCLE_TERMINAL");
  });

  /**
   * Shutdown must never be refusable: a host that cannot stop a plugin because
   * the plugin is in an unexpected state has no way to release its process.
   */
  test("shutdown succeeds from any state and is idempotent", () => {
    const failed = new PluginLifecycle();
    failed.fail("boom");
    expect(failed.shutdown().ok).toBe(true);
    expect(failed.state).toBe("stopped");
    expect(failed.shutdown().ok).toBe(true);

    const fresh = new PluginLifecycle();
    expect(fresh.shutdown("operator asked").ok).toBe(true);
    expect(fresh.state).toBe("stopped");
  });

  test("history is the explanation of where a plugin stopped (§3.6)", () => {
    const lifecycle = new PluginLifecycle();
    lifecycle.advanceTo("authorized");
    lifecycle.fail("INITIALIZE_FAILED: entry threw");
    expect(lifecycle.history.map(h => h.state)).toEqual([
      "discovered", "verified", "dependencies-resolved", "authorized", "failed",
    ]);
  });
});
