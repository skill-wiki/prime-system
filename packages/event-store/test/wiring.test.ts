import { describe, expect, test } from "bun:test";
import { JsonlEventStore, MemoryEventStore, SqliteEventStore } from "../src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A pinned copy of the contracts this package must satisfy, transcribed from
 * `packages/action-runtime/src/index.ts` and, for the execution plan, from
 * `packages/ir/src/index.ts` (which W5-B made authoritative — see D-1). Nothing
 * is imported: §15.4 forbids a store depending on its consumer, and a
 * `workspace:*` edge back to action-runtime would make the graph circular once
 * the coordinator wires the runtime to this package.
 *
 * The cost of that choice is drift. The annotations below pay part of it down:
 * a change to the `EventStore` or `IdempotencyLedger` surface stops compiling
 * here. They do NOT catch a change confined to a shape the store only carries
 * through, such as `ExecutionPlanIR` — a store stays assignable no matter what a
 * run's `plan` field looks like. That class of drift is caught by review, and
 * the transcription is dated so a reviewer can tell how stale it is.
 */

// ir/src/index.ts, SnapshotRef — the four §8.4 digests a snapshot id cannot carry.
interface PinnedSnapshotRef {
  readonly modelRelease: string;
  readonly modelDigest: string;
  readonly corpusRelease: string;
  readonly corpusDigest: string;
}
// action-runtime/src/index.ts:9
interface PinnedRequestContext {
  principal: string;
  roles: readonly string[];
  allowedCapabilities: readonly string[];
  budget: { timeoutMs?: number; maxAttempts?: number };
  snapshot: string;
  trace: string;
  tenant?: string;
  workspace?: string;
  policyRef?: string;
  snapshotRef?: PinnedSnapshotRef;
}
// action-runtime/src/index.ts:3
type PinnedRunStatus =
  | "planned"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied";
// action-runtime/src/index.ts:4
interface PinnedEvidence {
  kind: string;
  value: string;
}
interface PinnedPolicyDecision {
  allowed: boolean;
  reason: string;
  evidence?: readonly PinnedEvidence[];
}
// action-runtime/src/index.ts:5, with ActionDefinition["sideEffects"] resolved
// against model-schema/src/index.ts:14 (z.enum(["none","read","write"])).
interface PinnedEffectPlan {
  action: string;
  provider: string;
  sideEffects: "none" | "read" | "write";
  requiredCapabilities: readonly string[];
  approval: "none" | "human" | "policy";
  snapshot: string;
  trace: string;
  authorizationDecision?: PinnedPolicyDecision;
}
// ir/src/index.ts, ExecutionPlanNodeIR / ExecutionPlanIR — action-runtime imports
// these rather than shadowing them (D-1).
type PinnedValueIR =
  | null
  | boolean
  | number
  | string
  | readonly PinnedValueIR[]
  | { readonly [key: string]: PinnedValueIR };
interface PinnedDiagnosticIR {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly string[];
  readonly severity: "error" | "warning" | "info";
}
interface PinnedExecutionPlanNodeIR {
  readonly id: string;
  readonly kind:
    | "Query"
    | "Materialize"
    | "InvokeAction"
    | "InvokeFunction"
    | "InvokeModel"
    | "Transform"
    | "Validate"
    | "Gate"
    | "Emit"
    | "AwaitApproval";
  readonly target: string;
  readonly inputs: Readonly<Record<string, PinnedValueIR>>;
  readonly dependsOn: readonly string[];
}
interface PinnedExecutionPlanIR {
  readonly snapshot: PinnedSnapshotRef;
  readonly runId: string;
  readonly nodes: readonly PinnedExecutionPlanNodeIR[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly capabilities: readonly string[];
  readonly approvals: readonly string[];
  readonly checkpoints: readonly string[];
  readonly budget: { maxTokens?: number; maxDurationMs?: number };
  readonly diagnostics?: readonly PinnedDiagnosticIR[];
}
// action-runtime/src/index.ts:7
interface PinnedEventRecord {
  sequence: number;
  runId: string;
  type: string;
  at: number;
  payload: Readonly<Record<string, unknown>>;
}
// action-runtime/src/index.ts:8
interface PinnedAttemptRecord {
  readonly attempt: number;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}
interface PinnedStepRecord {
  readonly nodeId: string;
  readonly kind: PinnedExecutionPlanNodeIR["kind"];
  readonly target: string;
  readonly status: "succeeded" | "failed" | "denied" | "suspended" | "skipped";
  readonly startedAt: number;
  readonly durationMs: number;
  readonly attempts?: readonly PinnedAttemptRecord[];
  readonly error?: string;
  readonly skipReason?: string;
}
interface PinnedActionRun {
  id: string;
  action: string;
  input: unknown;
  context: PinnedRequestContext;
  plan: PinnedExecutionPlanIR;
  effect: PinnedEffectPlan;
  status: PinnedRunStatus;
  output?: unknown;
  error?: string;
  authorizationDecision?: PinnedPolicyDecision;
  policyDecision?: PinnedPolicyDecision;
  evidence: readonly PinnedEvidence[];
  attempts: number;
  // Added by W9-D so `plan.nodes` can drive execution: a step record per plan node
  // with its own measured duration, plus the run's own start and total. The store
  // persists these with everything else (`encode()` walks the whole object rather
  // than a field list), so the pin exists to make drift a failing test.
  startedAt: number;
  durationMs?: number;
  steps: readonly PinnedStepRecord[];
}
// action-runtime/src/index.ts:10
interface PinnedEventStore {
  append(runId: string, type: string, payload?: Record<string, unknown>): PinnedEventRecord;
  events(runId: string): readonly PinnedEventRecord[];
  save(run: PinnedActionRun): void;
  get(runId: string): PinnedActionRun | undefined;
}

// action-runtime/src/index.ts, IdempotencyLedger — the narrow surface the runtime
// asks for so it can be handed a persistent store without importing one.
interface PinnedRunScopeTuple {
  readonly tenant: string;
  readonly workspace: string;
  readonly snapshot: string;
}
interface PinnedIdempotencyRecordRef {
  readonly runId: string;
  readonly fingerprint: string;
}
interface PinnedIdempotencyClaimRequest extends PinnedIdempotencyRecordRef {
  readonly scope: PinnedRunScopeTuple;
  readonly action: string;
  readonly idempotencyKey: string;
}
interface PinnedIdempotencyLedger {
  claimIdempotency(claim: PinnedIdempotencyClaimRequest): {
    readonly status: "claimed" | "replayed";
    readonly record: PinnedIdempotencyRecordRef;
  };
  lookupIdempotency(
    scope: PinnedRunScopeTuple,
    action: string,
    idempotencyKey: string,
  ): PinnedIdempotencyRecordRef | undefined;
}

// action-runtime/src/index.ts:11, verbatim, reformatted only.
class ReferenceInMemoryEventStore implements PinnedEventStore {
  private readonly records = new Map<string, PinnedEventRecord[]>();
  private readonly runs = new Map<string, PinnedActionRun>();
  append(runId: string, type: string, payload: Record<string, unknown> = {}): PinnedEventRecord {
    const prior = this.records.get(runId) ?? [];
    const event = { sequence: prior.length + 1, runId, type, at: Date.now(), payload };
    this.records.set(runId, [...prior, event]);
    return event;
  }
  events(runId: string) {
    return this.records.get(runId) ?? [];
  }
  save(run: PinnedActionRun) {
    this.runs.set(run.id, run);
  }
  get(runId: string) {
    return this.runs.get(runId);
  }
}

const CONTEXT: PinnedRequestContext = {
  principal: "tester",
  roles: ["agent"],
  allowedCapabilities: [],
  budget: {},
  snapshot: "snapshot-1",
  trace: "trace-1",
  tenant: "t-1",
  workspace: "w-1",
};

function newRun(id: string): PinnedActionRun {
  const effect: PinnedEffectPlan = {
    action: "ResolveTicket",
    provider: "ticket-resolver",
    sideEffects: "none",
    requiredCapabilities: [],
    approval: "none",
    snapshot: CONTEXT.snapshot,
    trace: CONTEXT.trace,
  };
  return {
    id,
    action: "ResolveTicket",
    input: { ticket: { title: "Fix", active: true, owner: { name: "Ada" } } },
    context: CONTEXT,
    effect,
    plan: {
      runId: id,
      // Unbound on purpose: this fixture does not have a corpus release, and the
      // runtime reports that as a diagnostic rather than inventing digests.
      snapshot: { modelRelease: "", modelDigest: "", corpusRelease: "", corpusDigest: "" },
      nodes: [
        { id: "validate-input", kind: "Validate", target: "ResolveTicket", inputs: { typeRefs: ["Ticket"] }, dependsOn: [] },
        { id: "gate-authorization", kind: "Gate", target: "principal", inputs: { principal: "tester", roles: ["agent"] }, dependsOn: ["validate-input"] },
        { id: "invoke-action", kind: "InvokeAction", target: "ticket-resolver", inputs: { sideEffects: "none", idempotency: "idempotent", maxAttempts: 1 }, dependsOn: ["gate-authorization"] },
        { id: "validate-output", kind: "Validate", target: "boolean", inputs: { typeRef: "boolean" }, dependsOn: ["invoke-action"] },
        { id: "emit-audit", kind: "Emit", target: "audit", inputs: { trace: CONTEXT.trace }, dependsOn: ["validate-output"] },
      ],
      edges: [
        { from: "validate-input", to: "gate-authorization" },
        { from: "gate-authorization", to: "invoke-action" },
        { from: "invoke-action", to: "validate-output" },
        { from: "validate-output", to: "emit-audit" },
      ],
      capabilities: [],
      approvals: [],
      checkpoints: [],
      budget: {},
      diagnostics: [
        {
          code: "SNAPSHOT_REF_UNBOUND",
          severity: "warning",
          message: `Run ${id} carries no SnapshotRef, so the §8.4 digest checks cannot run for snapshot id ${CONTEXT.snapshot}`,
        },
      ],
    },
    status: "planned",
    evidence: [],
    attempts: 0,
    startedAt: 1_700_000_000_000,
    steps: [],
  };
}

/**
 * Replays the exact call script action-runtime performs for a retrying,
 * eventually-succeeding run (`newRun` -> `transition` -> `invoke`,
 * src/index.ts:29,30,34) so the assertion is against the real sequence its own
 * test pins, not an invented one.
 */
function driveRetryingRun(store: PinnedEventStore): { run: PinnedActionRun; types: string[] } {
  const run = newRun("run-1");
  store.save(run);
  store.append(run.id, "run.created", { status: run.status });
  store.append(run.id, "authorization.decided", {
    allowed: true,
    reason: "test allow",
    evidence: [{ kind: "role", value: "agent" }],
  });
  for (const attempt of [1, 2, 3]) {
    run.attempts = attempt;
    run.status = "running";
    store.save(run);
    store.append(run.id, "provider.attempt.started", {});
    if (attempt < 3) {
      store.append(run.id, "provider.attempt.failed", { attempt, error: "transient" });
    } else {
      store.append(run.id, "provider.attempt.succeeded", { attempt });
      run.output = true;
      run.status = "succeeded";
      store.save(run);
      store.append(run.id, "run.succeeded", {});
    }
  }
  return { run, types: store.events(run.id).map((event) => event.type) };
}

const EXPECTED_TYPES = [
  "run.created",
  "authorization.decided",
  "provider.attempt.started",
  "provider.attempt.failed",
  "provider.attempt.started",
  "provider.attempt.failed",
  "provider.attempt.started",
  "provider.attempt.succeeded",
  "run.succeeded",
];

describe("wiring compatibility with action-runtime", () => {
  test("all three stores are assignable to the pinned IdempotencyLedger contract", () => {
    const directory = mkdtempSync(join(tmpdir(), "event-store-ledger-"));
    try {
      // The annotation is the assertion. The method names in action-runtime's
      // `IdempotencyLedger` were chosen to match `PersistentEventStore` for
      // exactly this reason: a rename on either side would need an adapter with
      // nothing to adapt, and L6 §5.2's proposed `claim`/`lookup` names would
      // have made this line fail to compile.
      const stores: readonly PinnedIdempotencyLedger[] = [
        new MemoryEventStore<PinnedActionRun>(),
        new SqliteEventStore<PinnedActionRun>({ path: join(directory, "ledger.sqlite") }),
        new JsonlEventStore<PinnedActionRun>({ path: join(directory, "ledger.jsonl") }),
      ];
      const scope = { tenant: "t-1", workspace: "w-1", snapshot: "snapshot-1" };
      for (const ledger of stores) {
        expect(ledger.lookupIdempotency(scope, "ResolveTicket", "k-1")).toBeUndefined();
        const claimed = ledger.claimIdempotency({
          scope,
          action: "ResolveTicket",
          idempotencyKey: "k-1",
          fingerprint: "fp-1",
          runId: "run-1",
        });
        expect(claimed.status).toBe("claimed");
        expect(claimed.record).toMatchObject({ runId: "run-1", fingerprint: "fp-1" });
        // The runtime's replay path reads the record back and refuses to run the
        // provider again; the store must therefore return the *owner's* runId.
        expect(ledger.lookupIdempotency(scope, "ResolveTicket", "k-1")).toMatchObject({
          runId: "run-1",
          fingerprint: "fp-1",
        });
        expect(
          ledger.claimIdempotency({
            scope,
            action: "ResolveTicket",
            idempotencyKey: "k-1",
            fingerprint: "fp-1",
            runId: "run-2",
          }),
        ).toMatchObject({ status: "replayed", record: { runId: "run-1" } });
        expect(() =>
          ledger.claimIdempotency({
            scope,
            action: "ResolveTicket",
            idempotencyKey: "k-1",
            fingerprint: "fp-different",
            runId: "run-3",
          }),
        ).toThrow("Idempotency conflict: key reused with different input");
        (ledger as unknown as MemoryEventStore<PinnedActionRun>).close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("all three stores are assignable to the pinned EventStore contract", () => {
    const directory = mkdtempSync(join(tmpdir(), "event-store-wiring-"));
    try {
      // These annotations are the assertion: a contract drift stops compiling.
      const memory: PinnedEventStore = new MemoryEventStore<PinnedActionRun>();
      const sqlite: PinnedEventStore = new SqliteEventStore<PinnedActionRun>({
        path: join(directory, "events.sqlite"),
      });
      const jsonl: PinnedEventStore = new JsonlEventStore<PinnedActionRun>({
        path: join(directory, "events.jsonl"),
      });
      for (const store of [memory, sqlite, jsonl]) {
        expect(typeof store.append).toBe("function");
        expect(typeof store.events).toBe("function");
        expect(typeof store.save).toBe("function");
        expect(typeof store.get).toBe("function");
      }
      new MemoryEventStore<PinnedActionRun>().close();
      (sqlite as unknown as SqliteEventStore<PinnedActionRun>).close();
      (jsonl as unknown as JsonlEventStore<PinnedActionRun>).close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("every store produces the event type sequence action-runtime asserts", () => {
    const directory = mkdtempSync(join(tmpdir(), "event-store-wiring-"));
    try {
      const reference = driveRetryingRun(new ReferenceInMemoryEventStore());
      expect(reference.types).toEqual(EXPECTED_TYPES);

      const stores: readonly PinnedEventStore[] = [
        new MemoryEventStore<PinnedActionRun>(),
        new SqliteEventStore<PinnedActionRun>({ path: join(directory, "a.sqlite") }),
        new JsonlEventStore<PinnedActionRun>({ path: join(directory, "a.jsonl") }),
      ];
      for (const store of stores) {
        const driven = driveRetryingRun(store);
        expect(driven.types).toEqual(EXPECTED_TYPES);
        // Identity, not equality: action-runtime keeps mutating this object.
        expect(store.get("run-1")).toBe(driven.run);
        expect(store.get("run-1")?.status).toBe("succeeded");
        expect(store.get("run-1")?.attempts).toBe(3);
        expect(store.events("run-1").map((event) => event.sequence)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9,
        ]);
        expect(store.events("run-1")[3]?.payload).toEqual({ attempt: 1, error: "transient" });
        expect(store.events("run-1")[5]?.payload).toEqual({ attempt: 2, error: "transient" });
        expect(store.events("run-1")[7]?.payload).toEqual({ attempt: 3 });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a run saved with no tenant or workspace still keys and replays", () => {
    // RequestContext.tenant/workspace are optional upstream; the store must not
    // require them, and "" must be the same scope the runtime's own
    // idempotency tuple uses (`context.tenant ?? ""`, src/index.ts:26).
    const store = new MemoryEventStore<PinnedActionRun>();
    const run = newRun("run-1");
    const untenanted: PinnedActionRun = {
      ...run,
      context: { ...CONTEXT, tenant: undefined, workspace: undefined },
    };
    store.save(untenanted);
    store.append(untenanted.id, "run.created", { status: "planned" });
    expect(store.events(untenanted.id)).toHaveLength(1);
    expect(
      store.scoped({ tenant: "", workspace: "", snapshot: "snapshot-1" }).events("run-1"),
    ).toHaveLength(1);
    store.close();
  });
});
