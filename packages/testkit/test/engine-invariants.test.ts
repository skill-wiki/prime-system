import { expect, test } from "bun:test";
import { runEngineInvariants, type EngineHarness } from "../src/engine-invariants.ts";

/**
 * A tiny in-memory reference engine. Its only purpose is to prove the suite has
 * teeth: each invariant is exercised once against a conforming implementation
 * and once against an implementation that breaks exactly that invariant.
 */
function conformingHarness(): EngineHarness {
  let generation = 0;
  const snapshots = new Map<number, readonly string[]>([[0, ["a", "b"]]]);
  let sideEffects = 0;
  const appliedKeys = new Set<string>();
  const runs = new Map<string, unknown>();
  return {
    name: "reference-fake",
    snapshotIsolation: {
      open: () => generation,
      mutate: () => { generation += 1; snapshots.set(generation, ["a", "b", `c${generation}`]); },
      read: handle => snapshots.get(handle as number) ?? [],
    },
    deterministicPlanning: {
      request: { text: "anything", limit: 2 },
      // Key order in the output must not depend on iteration accidents.
      plan: request => ({ nodes: [...Object.keys(request)].sort(), budget: 2 }),
    },
    hardConstraint: {
      request: { text: "anything", forbid: ["b"] },
      forbiddenUnitIds: ["b"],
      select: request => ["a", "b"].filter(id => !(request["forbid"] as readonly string[]).includes(id)),
    },
    acl: {
      request: { text: "anything" },
      deniedPrincipal: "guest",
      restrictedUnitIds: ["b"],
      select: (_request, principal) => (principal === "guest" ? ["a"] : ["a", "b"]),
    },
    idempotency: {
      input: { target: "a" },
      idempotencyKey: "key-1",
      invoke: (_input, key) => { if (!appliedKeys.has(key)) { appliedKeys.add(key); sideEffects += 1; } },
      sideEffectCount: () => sideEffects,
    },
    replay: {
      input: { target: "a" },
      run: input => { const runId = `run-${runs.size}`; const outcome = { target: input["target"], verdict: "ok" }; runs.set(runId, outcome); return { runId, outcome }; },
      replay: runId => ({ outcome: runs.get(runId) }),
    },
    bundleIntegrity: {
      validDescriptor: { digest: "sha256:good" },
      tamperedDescriptor: { digest: "sha256:bad" },
      load: descriptor => { if (descriptor["digest"] !== "sha256:good") throw new Error("digest mismatch"); return { loaded: true }; },
    },
  };
}

async function statusOf(harness: EngineHarness, id: string): Promise<string> {
  const r = await runEngineInvariants(harness);
  return r.checks.find(c => c.id === id)?.status ?? "missing";
}

async function codesOf(harness: EngineHarness, id: string): Promise<readonly string[]> {
  const r = await runEngineInvariants(harness);
  return (r.checks.find(c => c.id === id)?.findings ?? []).map(f => f.code);
}

test("an empty harness skips all seven invariants and never reports a pass", async () => {
  const r = await runEngineInvariants({ name: "bare" });
  expect(r.counts).toEqual({ pass: 0, fail: 0, skip: 7 });
  expect(r.status).toBe("skip");
  expect(r.checks.every(c => (c.skipReason ?? "").length > 0)).toBe(true);
  expect(r.checks.map(c => c.id)).toEqual([
    "EI-SNAPSHOT-ISOLATION", "EI-DETERMINISTIC-PLANNING", "EI-HARD-CONSTRAINT",
    "EI-ACL", "EI-IDEMPOTENCY", "EI-EVENT-REPLAY", "EI-BUNDLE-DIGEST",
  ]);
});

test("the reference fake satisfies every invariant", async () => {
  const r = await runEngineInvariants(conformingHarness());
  expect(r.counts).toEqual({ pass: 7, fail: 0, skip: 0 });
  expect(r.errorCount).toBe(0);
  expect(r.warningCount).toBe(0);
});

test("a snapshot that observes later mutations fails", async () => {
  const live = new Set(["a"]);
  const harness: EngineHarness = {
    name: "leaky-snapshot",
    snapshotIsolation: { open: () => 0, mutate: () => { live.add("b"); }, read: () => [...live].sort() },
  };
  expect(await codesOf(harness, "EI-SNAPSHOT-ISOLATION")).toEqual(["SNAPSHOT_NOT_ISOLATED"]);
});

test("a mutation that changes nothing is flagged as a vacuous check", async () => {
  const harness: EngineHarness = {
    name: "inert-mutation",
    snapshotIsolation: { open: () => 0, mutate: () => undefined, read: () => ["a"] },
  };
  expect(await codesOf(harness, "EI-SNAPSHOT-ISOLATION")).toEqual(["MUTATION_NOT_OBSERVABLE"]);
  expect(await statusOf(harness, "EI-SNAPSHOT-ISOLATION")).toBe("pass");
});

test("non-deterministic planning fails", async () => {
  let counter = 0;
  const harness: EngineHarness = {
    name: "wobbly-planner",
    deterministicPlanning: { request: {}, plan: () => ({ seq: (counter += 1) }) },
  };
  expect(await codesOf(harness, "EI-DETERMINISTIC-PLANNING")).toEqual(["PLAN_NOT_DETERMINISTIC", "PLAN_NOT_DETERMINISTIC"]);
});

test("a hard constraint outweighed by score fails", async () => {
  const harness: EngineHarness = {
    name: "score-wins",
    hardConstraint: { request: {}, forbiddenUnitIds: ["b"], select: () => ["b", "a"] },
  };
  expect(await codesOf(harness, "EI-HARD-CONSTRAINT")).toEqual(["HARD_CONSTRAINT_OVERRIDDEN"]);
});

test("access control applied after ranking fails", async () => {
  const harness: EngineHarness = {
    name: "acl-after",
    acl: { request: {}, deniedPrincipal: "guest", restrictedUnitIds: ["b", "c"], select: () => ["a", "b", "c"] },
  };
  expect(await codesOf(harness, "EI-ACL")).toEqual(["ACL_LEAK", "ACL_LEAK"]);
});

test("a duplicated side effect under the same idempotency key fails", async () => {
  let count = 0;
  const harness: EngineHarness = {
    name: "double-effect",
    idempotency: { input: {}, idempotencyKey: "k", invoke: () => { count += 1; }, sideEffectCount: () => count },
  };
  expect(await codesOf(harness, "EI-IDEMPOTENCY")).toEqual(["SIDE_EFFECT_DUPLICATED"]);
});

test("an action with no observable effect is flagged rather than silently passing", async () => {
  const harness: EngineHarness = {
    name: "no-effect",
    idempotency: { input: {}, idempotencyKey: "k", invoke: () => undefined, sideEffectCount: () => 0 },
  };
  expect(await codesOf(harness, "EI-IDEMPOTENCY")).toEqual(["ACTION_HAD_NO_EFFECT"]);
  expect(await statusOf(harness, "EI-IDEMPOTENCY")).toBe("pass");
});

test("a diverging replay fails", async () => {
  const harness: EngineHarness = {
    name: "diverging-replay",
    replay: { input: {}, run: () => ({ runId: "r1", outcome: { at: 1 } }), replay: () => ({ outcome: { at: 2 } }) },
  };
  expect(await codesOf(harness, "EI-EVENT-REPLAY")).toEqual(["REPLAY_DIVERGED"]);
});

test("accepting a tampered bundle fails, and rejecting a good one fails too", async () => {
  const permissive: EngineHarness = {
    name: "permissive-loader",
    bundleIntegrity: { validDescriptor: {}, tamperedDescriptor: {}, load: () => ({}) },
  };
  expect(await codesOf(permissive, "EI-BUNDLE-DIGEST")).toEqual(["DIGEST_MISMATCH_ACCEPTED"]);

  const paranoid: EngineHarness = {
    name: "paranoid-loader",
    bundleIntegrity: { validDescriptor: {}, tamperedDescriptor: {}, load: () => { throw new Error("nope"); } },
  };
  expect(await codesOf(paranoid, "EI-BUNDLE-DIGEST")).toEqual(["VALID_BUNDLE_REJECTED"]);
});

test("a harness that throws is reported as a finding, not an unhandled rejection", async () => {
  const harness: EngineHarness = {
    name: "explosive",
    deterministicPlanning: { request: {}, plan: () => { throw new Error("boom"); } },
  };
  const findings = (await runEngineInvariants(harness)).checks.find(c => c.id === "EI-DETERMINISTIC-PLANNING")?.findings ?? [];
  expect(findings.map(f => f.code)).toEqual(["HARNESS_THREW"]);
  expect(findings[0]?.message).toBe("boom");
});

test("asynchronous capabilities are awaited", async () => {
  const harness: EngineHarness = {
    name: "async-fake",
    deterministicPlanning: { request: { a: 1 }, plan: async request => Promise.resolve({ keys: Object.keys(request) }) },
    replay: {
      input: {},
      run: async () => Promise.resolve({ runId: "r", outcome: { ok: true } }),
      replay: async () => Promise.resolve({ outcome: { ok: true } }),
    },
  };
  expect(await statusOf(harness, "EI-DETERMINISTIC-PLANNING")).toBe("pass");
  expect(await statusOf(harness, "EI-EVENT-REPLAY")).toBe("pass");
});
