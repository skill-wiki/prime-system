import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import type { SnapshotRef } from "@skill-wiki/ir";
import {
  ActionProviderRegistry,
  ActionRuntime,
  InMemoryEventStore,
  type IdempotencyClaimRequest,
  type IdempotencyLedger,
  type IdempotencyRecordRef,
  type RunScopeTuple,
} from "../src/index.ts";

const model = loadModelOrThrow(new URL("../../model-schema/test/fixtures/ticket-model", import.meta.url).pathname);
const context = { principal: "tester", roles: ["agent"], allowedCapabilities: [], budget: {}, snapshot: "snapshot-1", trace: "trace-1" };
const ticket = { title: "Fix", active: true, owner: { name: "Ada" } };
const allowed = { authorize: async () => ({ allowed: true, reason: "test allow", evidence: [] }) };
const bound: SnapshotRef = { modelRelease: "2026.08.28.1", modelDigest: "sha256:model", corpusRelease: "2026.08.28.1", corpusDigest: "sha256:corpus" };

function runtimeFor(changes: (action: any) => void = () => {}, extra: Record<string, unknown> = {}) {
  const changed = structuredClone(model) as typeof model;
  changes(changed.definitions.find(x => x.kind === "action") as any);
  let calls = 0;
  const runtime = new ActionRuntime(changed, { actions: new ActionProviderRegistry().register("ticket-resolver", { execute: async () => { calls++; return true } }), authorizer: allowed, ...extra });
  return { runtime, calls: () => calls };
}

/**
 * A ledger whose records survive the object that wrote them. It is deliberately
 * not `@skill-wiki/event-store`: the assertion under test is that the runtime's
 * conflict check now lives behind the `IdempotencyLedger` boundary rather than in
 * a field of the runtime, and a file is enough to prove a claim outlives a
 * process. The durable backends' own restart guarantee is asserted in
 * `packages/event-store/test/durability.test.ts`.
 */
class FileIdempotencyLedger implements IdempotencyLedger {
  constructor(private readonly path: string) {}
  private read(): Record<string, IdempotencyRecordRef> { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {} }
  private tuple(scope: RunScopeTuple, action: string, key: string) { return JSON.stringify([scope.tenant, scope.workspace, scope.snapshot, action, key]) }
  claimIdempotency(claim: IdempotencyClaimRequest) {
    const all = this.read(), tuple = this.tuple(claim.scope, claim.action, claim.idempotencyKey), prior = all[tuple];
    if (prior) { if (prior.fingerprint !== claim.fingerprint) throw new Error("Idempotency conflict: key reused with different input"); return { status: "replayed" as const, record: prior } }
    const record: IdempotencyRecordRef = { runId: claim.runId, fingerprint: claim.fingerprint };
    all[tuple] = record; writeFileSync(this.path, JSON.stringify(all)); return { status: "claimed" as const, record };
  }
  lookupIdempotency(scope: RunScopeTuple, action: string, key: string) { return this.read()[this.tuple(scope, action, key)] }
}

describe("execution plan is a derived graph, not a constant", () => {
  test("nodes and edges vary with the definition rather than being a fixed list", async () => {
    const plain = await runtimeFor().runtime.execute("ResolveTicket", { ticket }, context, "plain");
    // `approval: never` must not plan an approval node at all — the replaced
    // implementation listed AwaitApproval for every run regardless.
    expect(plain.plan.nodes.map(node => node.id)).toEqual(["validate-input", "gate-authorization", "invoke-action", "validate-output", "emit-audit"]);
    expect(plain.plan.nodes.some(node => node.kind === "AwaitApproval")).toBe(false);
    expect(plain.plan.approvals).toEqual([]);
    expect(plain.plan.checkpoints).toEqual([]);

    const governed = runtimeFor(action => { action.approval = "always"; action.capabilities = ["ticket:write"]; action.sideEffects = "write"; action.preconditions = ["ticket-open"] }, { preconditions: { check: async () => true } });
    const waiting = await governed.runtime.execute("ResolveTicket", { ticket }, { ...context, allowedCapabilities: ["ticket:write"] }, "governed");
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.plan.nodes.map(node => node.id)).toEqual(["validate-input", "gate-authorization", "gate-capability-1", "validate-precondition-1", "await-approval", "invoke-action", "validate-output", "emit-audit"]);
    expect(waiting.plan.nodes.find(node => node.id === "gate-capability-1")).toMatchObject({ kind: "Gate", target: "ticket:write" });
    expect(waiting.plan.capabilities).toEqual(["ticket:write"]);
    expect(waiting.plan.approvals).toEqual(["human"]);
    // The approval node is the only place a run resumes from another process.
    expect(waiting.plan.checkpoints).toEqual(["await-approval"]);
    expect(plain.plan.nodes.length).not.toBe(waiting.plan.nodes.length);

    const conditional = await runtimeFor(action => { action.approval = "conditional" }, { policy: { decide: async () => ({ allowed: true, reason: "ok" }) } }).runtime.execute("ResolveTicket", { ticket }, { ...context, policyRef: "policy-7" }, "conditional");
    expect(conditional.plan.nodes.find(node => node.id === "gate-policy")).toMatchObject({ kind: "Gate", target: "policy", inputs: { requirement: "policy", policyRef: "policy-7" } });
    expect(conditional.plan.approvals).toEqual(["policy"]);
  });

  test("edges are exactly the dependsOn relation and every kind is in the IR closed set", async () => {
    const run = await runtimeFor(action => { action.capabilities = ["ticket:write"]; action.sideEffects = "write" }).runtime.execute("ResolveTicket", { ticket }, { ...context, allowedCapabilities: ["ticket:write"], budget: { timeoutMs: 500, maxAttempts: 2 } }, "edges");
    const ids = new Set(run.plan.nodes.map(node => node.id));
    expect(run.plan.edges).toEqual(run.plan.nodes.flatMap(node => node.dependsOn.map(from => ({ from, to: node.id }))));
    for (const edge of run.plan.edges) { expect(ids.has(edge.from)).toBe(true); expect(ids.has(edge.to)).toBe(true) }
    expect(run.plan.nodes[0]!.dependsOn).toEqual([]);
    const kinds = new Set(["Query", "Materialize", "InvokeAction", "InvokeFunction", "InvokeModel", "Transform", "Validate", "Gate", "Emit", "AwaitApproval"]);
    for (const node of run.plan.nodes) expect(kinds.has(node.kind)).toBe(true);
    // §7.6's budget has no attempt slot, so the attempt budget rides on the node
    // it governs instead of being dropped.
    expect(run.plan.budget).toEqual({ maxDurationMs: 500 });
    expect(run.plan.nodes.find(node => node.kind === "InvokeAction")!.inputs).toEqual({ sideEffects: "write", idempotency: "idempotent", maxAttempts: 2 });
    expect(JSON.parse(JSON.stringify(run.plan))).toEqual(run.plan);
  });

  test("an unbound snapshot is reported as a diagnostic, never as a fabricated digest", async () => {
    const unbound = await runtimeFor().runtime.execute("ResolveTicket", { ticket }, context, "unbound");
    expect(unbound.plan.snapshot).toEqual({ modelRelease: "", modelDigest: "", corpusRelease: "", corpusDigest: "" });
    expect(unbound.plan.diagnostics?.map(d => d.code)).toEqual(["SNAPSHOT_REF_UNBOUND"]);
    const pinned = await runtimeFor(() => {}, { snapshot: bound }).runtime.execute("ResolveTicket", { ticket }, { ...context, snapshotRef: bound }, "pinned");
    expect(pinned.plan.snapshot).toEqual(bound);
    expect(pinned.plan.diagnostics).toEqual([]);
  });
});

describe("snapshot binding fails closed", () => {
  test("a digest mismatch denies the run before the provider is reached", async () => {
    const { runtime, calls } = runtimeFor(() => {}, { snapshot: bound });
    const run = await runtime.execute("ResolveTicket", { ticket }, { ...context, snapshotRef: { ...bound, corpusDigest: "sha256:tampered" } }, "tampered");
    expect(run).toMatchObject({ status: "denied", error: "Snapshot binding mismatch: corpusDigest" });
    expect(calls()).toBe(0);
    expect(runtime.events(run.id).map(x => x.type)).toEqual(["run.created", "run.denied"]);
  });

  test("a pinned runtime refuses a request that carries no digests at all", async () => {
    const { runtime, calls } = runtimeFor(() => {}, { snapshot: bound });
    expect(await runtime.execute("ResolveTicket", { ticket }, context, "no-ref")).toMatchObject({ status: "denied", error: "Snapshot binding is required" });
    expect(calls()).toBe(0);
  });

  test("every mismatching field is named, so a wrong model lock is not hidden by a wrong corpus", async () => {
    const { runtime } = runtimeFor(() => {}, { snapshot: bound });
    const run = await runtime.execute("ResolveTicket", { ticket }, { ...context, snapshotRef: { modelRelease: "x", modelDigest: "y", corpusRelease: bound.corpusRelease, corpusDigest: "z" } }, "all");
    expect(run.error).toBe("Snapshot binding mismatch: modelRelease, modelDigest, corpusDigest");
  });
});

describe("idempotency survives the process that claimed it", () => {
  const dir = mkdtempSync(join(tmpdir(), "action-runtime-ledger-"));

  test("a reused key with a different input still conflicts after a restart", async () => {
    const path = join(dir, "ledger.json");
    const first = runtimeFor(() => {}, { idempotency: new FileIdempotencyLedger(path) });
    expect((await first.runtime.execute("ResolveTicket", { ticket }, context, "reused")).status).toBe("succeeded");

    // "Restart": a new runtime, a new event store, a new ledger object — only the
    // file survives. A process-local Map loses the claim here and would happily
    // execute a different input under the same key.
    const restarted = runtimeFor(() => {}, { idempotency: new FileIdempotencyLedger(path) });
    await expect(restarted.runtime.execute("ResolveTicket", { ticket: { ...ticket, title: "Different" } }, context, "reused")).rejects.toThrow("Idempotency conflict: key reused with different input");
    expect(restarted.calls()).toBe(0);
  });

  test("a surviving claim whose run is not in this event store fails closed instead of fabricating a run", async () => {
    const path = join(dir, "torn.json");
    const first = runtimeFor(() => {}, { idempotency: new FileIdempotencyLedger(path) });
    const original = await first.runtime.execute("ResolveTicket", { ticket }, context, "torn");
    const restarted = runtimeFor(() => {}, { idempotency: new FileIdempotencyLedger(path) });
    await expect(restarted.runtime.execute("ResolveTicket", { ticket }, context, "torn")).rejects.toThrow(`Idempotency record for ${original.id} has no run in this event store`);
    expect(restarted.calls()).toBe(0);
  });

  test("a durable ledger paired with a durable store replays the original run", async () => {
    const path = join(dir, "paired.json"), ledger = new FileIdempotencyLedger(path), events = new InMemoryEventStore();
    const makeRuntime = () => { let calls = 0; return { runtime: new ActionRuntime(model, { actions: new ActionProviderRegistry().register("ticket-resolver", { execute: async () => { calls++; return true } }), authorizer: allowed, idempotency: ledger, events }), calls: () => calls } };
    const first = makeRuntime();
    const original = await first.runtime.execute("ResolveTicket", { ticket }, context, "paired");
    // Same ledger and same store, different runtime: the second call must return
    // the recorded run rather than run the provider again.
    const second = makeRuntime();
    expect((await second.runtime.execute("ResolveTicket", { ticket }, context, "paired")).id).toBe(original.id);
    expect(second.calls()).toBe(0);
  });

  test("a claim already owned by another writer never invokes the provider twice", async () => {
    // Simulates the cross-process race a process-local Map cannot see: nothing is
    // visible to `lookup`, but by the time this run claims, another writer owns
    // the tuple.
    const racing: IdempotencyLedger = { lookupIdempotency: () => undefined, claimIdempotency: () => ({ status: "replayed" as const, record: { runId: "run-elsewhere-1", fingerprint: "whatever" } }) };
    const { runtime, calls } = runtimeFor(() => {}, { idempotency: racing });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "raced");
    expect(run).toMatchObject({ status: "denied", error: "Idempotency key already claimed by run run-elsewhere-1" });
    expect(calls()).toBe(0);
    expect(runtime.events(run.id).map(x => x.type)).toEqual(["run.created", "authorization.decided", "idempotency.replayed", "idempotency.unresolved"]);
  });

  test("a ledger error on lookup is surfaced, not swallowed into a successful run", async () => {
    const broken: IdempotencyLedger = { lookupIdempotency: () => { throw new Error("ledger offline") }, claimIdempotency: () => ({ status: "claimed" as const, record: { runId: "x", fingerprint: "y" } }) };
    const { runtime, calls } = runtimeFor(() => {}, { idempotency: broken });
    await expect(runtime.execute("ResolveTicket", { ticket }, context, "offline")).rejects.toThrow("ledger offline");
    expect(calls()).toBe(0);
  });

  test("dry-run neither looks up nor claims, so an unfingerprintable input still plans", async () => {
    let lookups = 0, claims = 0;
    const counting: IdempotencyLedger = { lookupIdempotency: () => { lookups++; return undefined }, claimIdempotency: (claim) => { claims++; return { status: "claimed" as const, record: { runId: claim.runId, fingerprint: claim.fingerprint } } } };
    const { runtime, calls } = runtimeFor(() => {}, { idempotency: counting });
    // The BigInt path: `newRun()` saves before any fingerprint exists, so a
    // ledger must not be consulted here at all.
    expect((await runtime.execute("ResolveTicket", { ticket: { ...ticket, metadata: BigInt(1) } }, context, "", true)).status).toBe("planned");
    expect([lookups, claims, calls()]).toEqual([0, 0, 0]);
  });

  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); expect(existsSync(dir)).toBe(false) });
});
