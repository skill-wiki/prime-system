import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdempotencyConflictError,
  JsonlEventStore,
  MemoryEventStore,
  RunScopeConflictError,
  SerializationError,
  SqliteEventStore,
  fieldRedactor,
  scopeKey,
  type EventStoreOptions,
  type PersistentEventStore,
  type RunScopeSource,
} from "../src/index.ts";

/**
 * Shaped after action-runtime's `ActionRun` (src/index.ts:8) so the suite
 * exercises the store with the run type it will really carry, not a toy.
 */
interface TestRun {
  id: string;
  action: string;
  input: unknown;
  context: {
    principal: string;
    roles: readonly string[];
    allowedCapabilities: readonly string[];
    budget: { timeoutMs?: number; maxAttempts?: number };
    snapshot: string;
    trace: string;
    tenant?: string;
    workspace?: string;
  };
  status: "planned" | "awaiting_approval" | "running" | "succeeded" | "failed" | "denied";
  output?: unknown;
  error?: string;
  evidence: readonly { kind: string; value: string }[];
  attempts: number;
}

const scopeOf = (source: RunScopeSource) => ({
  principal: "tester",
  roles: ["agent"] as const,
  allowedCapabilities: [] as const,
  budget: {},
  snapshot: source.snapshot,
  trace: "trace-1",
  ...(source.tenant === undefined ? {} : { tenant: source.tenant }),
  ...(source.workspace === undefined ? {} : { workspace: source.workspace }),
});

function makeRun(id: string, source: RunScopeSource, overrides: Partial<TestRun> = {}): TestRun {
  return {
    id,
    action: "ResolveTicket",
    input: { ticket: { title: "Fix" } },
    context: scopeOf(source),
    status: "planned",
    evidence: [],
    attempts: 0,
    ...overrides,
  };
}

const DEFAULT_SCOPE: RunScopeSource = { tenant: "t-1", workspace: "w-1", snapshot: "snapshot-1" };

interface Factory {
  readonly label: string;
  /** True when the bytes live outside the process and can be inspected. */
  readonly durable: boolean;
  create(options?: EventStoreOptions): PersistentEventStore<TestRun>;
  /** Files the store wrote, for byte-level assertions. */
  files(): readonly string[];
}

let directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "event-store-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function factories(): readonly Factory[] {
  return [
    {
      label: "MemoryEventStore",
      durable: false,
      create: (options) => new MemoryEventStore<TestRun>(options),
      files: () => [],
    },
    {
      label: "SqliteEventStore",
      durable: true,
      create: function (this: { path?: string }, options) {
        const path = join(scratch(), "events.sqlite");
        this.path = path;
        return new SqliteEventStore<TestRun>({ ...options, path });
      },
      files: function (this: { path?: string }) {
        return this.path ? [this.path, `${this.path}-wal`] : [];
      },
    },
    {
      label: "JsonlEventStore",
      durable: true,
      create: function (this: { path?: string }, options) {
        const path = join(scratch(), "events.jsonl");
        this.path = path;
        return new JsonlEventStore<TestRun>({ ...options, path });
      },
      files: function (this: { path?: string }) {
        return this.path ? [this.path] : [];
      },
    },
  ];
}

for (const factory of factories()) {
  describe(`${factory.label} — event store contract`, () => {
    test("matches InMemoryEventStore sequencing: 1-based, grouped by run", () => {
      const store = factory.create();
      const one = makeRun("run-1", DEFAULT_SCOPE);
      const two = makeRun("run-2", DEFAULT_SCOPE);
      store.save(one);
      store.save(two);

      expect(store.append(one.id, "run.created", { status: "planned" }).sequence).toBe(1);
      expect(store.append(one.id, "run.succeeded").sequence).toBe(2);
      expect(store.append(two.id, "run.created").sequence).toBe(1);

      expect(store.events(one.id).map((event) => event.type)).toEqual([
        "run.created",
        "run.succeeded",
      ]);
      expect(store.events(two.id).map((event) => event.sequence)).toEqual([1]);
      expect(store.events("run-absent")).toEqual([]);
      store.close();
    });

    test("payload defaults to {} and round-trips nested evidence unchanged", () => {
      const store = factory.create();
      const run = makeRun("run-1", DEFAULT_SCOPE);
      store.save(run);
      expect(store.append(run.id, "approval.accepted").payload).toEqual({});
      const evidence = [{ kind: "policy", value: "P" }];
      store.append(run.id, "policy.decided", { allowed: true, reason: "ok", evidence });
      expect(store.events(run.id)[1]?.payload).toEqual({
        allowed: true,
        reason: "ok",
        evidence,
      });
      store.close();
    });

    test("returned records and stored payloads are frozen against mutation", () => {
      const store = factory.create();
      const run = makeRun("run-1", DEFAULT_SCOPE);
      store.save(run);
      const record = store.append(run.id, "run.created", { status: "planned" });
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.payload)).toBe(true);
      store.close();
    });

    test("get() preserves object identity so a caller can keep mutating a run", () => {
      // action-runtime's approve() reads a run out of the store and mutates it
      // (src/index.ts:28) while its idempotency map still holds the same
      // reference (:19). A store handing back a clone would strand that map.
      const store = factory.create();
      const run = makeRun("run-1", DEFAULT_SCOPE);
      store.save(run);
      expect(store.get(run.id)).toBe(run);
      run.status = "succeeded";
      store.save(run);
      expect(store.get(run.id)?.status).toBe("succeeded");
      expect(store.get("run-absent")).toBeUndefined();
      store.close();
    });

    test("every save() appends a revision; none overwrites the last", () => {
      const store = factory.create();
      const run = makeRun("run-1", DEFAULT_SCOPE);
      store.save(run);
      run.status = "running";
      store.save(run);
      run.status = "succeeded";
      run.output = { ok: true };
      store.save(run);

      const revisions = store.revisions(run.id);
      expect(revisions.map((entry) => entry.revision)).toEqual([1, 2, 3]);
      expect(revisions.map((entry) => entry.run.status)).toEqual([
        "planned",
        "running",
        "succeeded",
      ]);
      expect(revisions[0]?.run.output).toBeUndefined();
      store.close();
    });

    test("replay rebuilds the terminal run from the log, not from the cache", () => {
      const store = factory.create();
      const run = makeRun("run-1", DEFAULT_SCOPE);
      store.save(run);
      store.append(run.id, "run.created", { status: "planned" });
      run.status = "running";
      run.attempts = 1;
      store.save(run);
      store.append(run.id, "provider.attempt.started");
      run.status = "succeeded";
      run.output = { resolved: true };
      run.evidence = [{ kind: "auth", value: "A" }];
      store.save(run);
      store.append(run.id, "run.succeeded");

      const replayed = store.replay(run.id);
      expect(replayed.lossy).toBe(false);
      expect(replayed.run).not.toBe(run);
      expect(replayed.run).toEqual(run);
      expect(replayed.events.map((event) => event.type)).toEqual([
        "run.created",
        "provider.attempt.started",
        "run.succeeded",
      ]);
      expect(replayed.revisions).toHaveLength(3);
      expect(store.replayEquivalence(run.id)).toMatchObject({ equivalent: true, lossy: false });
      store.close();
    });

    test("replay of an unknown run is empty, not an error", () => {
      const store = factory.create();
      const replayed = store.replay("run-absent", DEFAULT_SCOPE);
      expect(replayed.run).toBeUndefined();
      expect(replayed.events).toEqual([]);
      expect(store.replayEquivalence("run-absent", DEFAULT_SCOPE).equivalent).toBe(true);
      store.close();
    });

    test("two tenants may share a runId and stay mutually invisible", () => {
      const store = factory.create();
      const left = store.scoped({ tenant: "t-a", workspace: "w", snapshot: "snapshot-1" });
      const right = store.scoped({ tenant: "t-b", workspace: "w", snapshot: "snapshot-1" });

      const a = makeRun("run-shared", { tenant: "t-a", workspace: "w", snapshot: "snapshot-1" }, { action: "ActionA" });
      const b = makeRun("run-shared", { tenant: "t-b", workspace: "w", snapshot: "snapshot-1" }, { action: "ActionB" });
      left.save(a);
      left.append("run-shared", "a.only");
      right.save(b);
      right.append("run-shared", "b.only");
      right.append("run-shared", "b.second");

      expect(left.events("run-shared").map((event) => event.type)).toEqual(["a.only"]);
      expect(right.events("run-shared").map((event) => event.type)).toEqual(["b.only", "b.second"]);
      expect(left.events("run-shared").map((event) => event.sequence)).toEqual([1]);
      expect(right.events("run-shared").map((event) => event.sequence)).toEqual([1, 2]);
      expect(left.get("run-shared")?.action).toBe("ActionA");
      expect(right.get("run-shared")?.action).toBe("ActionB");
      store.close();
    });

    test("snapshot is part of the key, so the same tenant is isolated across snapshots", () => {
      const store = factory.create();
      const first = store.scoped({ tenant: "t", workspace: "w", snapshot: "snapshot-1" });
      const second = store.scoped({ tenant: "t", workspace: "w", snapshot: "snapshot-2" });
      first.save(makeRun("run-1", { tenant: "t", workspace: "w", snapshot: "snapshot-1" }));
      first.append("run-1", "first.only");
      expect(second.events("run-1")).toEqual([]);
      expect(second.get("run-1")).toBeUndefined();
      store.close();
    });

    test("scope keys do not collide across a separator in tenant or workspace", () => {
      const store = factory.create();
      const left = store.scoped({ tenant: "a|b", workspace: "c", snapshot: "s" });
      const right = store.scoped({ tenant: "a", workspace: "b|c", snapshot: "s" });
      left.save(makeRun("run-1", { tenant: "a|b", workspace: "c", snapshot: "s" }, { action: "Left" }));
      right.save(makeRun("run-1", { tenant: "a", workspace: "b|c", snapshot: "s" }, { action: "Right" }));
      left.append("run-1", "left");
      expect(right.events("run-1")).toEqual([]);
      expect(right.get("run-1")?.action).toBe("Right");
      store.close();
    });

    test("the unscoped root refuses to serve one runId under two scopes", () => {
      const store = factory.create();
      store.save(makeRun("run-1", { tenant: "t-a", workspace: "w", snapshot: "s" }));
      expect(() => store.save(makeRun("run-1", { tenant: "t-b", workspace: "w", snapshot: "s" }))).toThrow(
        RunScopeConflictError,
      );
      store.close();
    });

    test("an append before any save lands in the configured default scope", () => {
      const store = factory.create({ defaultScope: DEFAULT_SCOPE });
      store.append("run-orphan", "run.created");
      expect(store.events("run-orphan").map((event) => event.type)).toEqual(["run.created"]);
      expect(store.scoped(DEFAULT_SCOPE).events("run-orphan")).toHaveLength(1);
      store.close();
    });

    test("sequence stays strictly monotonic with no gaps under concurrent append", async () => {
      const store = factory.create();
      const run = makeRun("run-1", DEFAULT_SCOPE);
      store.save(run);
      const total = 64;
      const records = await Promise.all(
        Array.from({ length: total }, (_, index) =>
          Promise.resolve().then(() => store.append(run.id, `event.${index}`, { index })),
        ),
      );
      const sequences = records.map((record) => record.sequence).sort((a, b) => a - b);
      expect(sequences).toEqual(Array.from({ length: total }, (_, index) => index + 1));
      // Reading back re-verifies continuity, so a duplicate would throw here
      // even if the returned numbers happened to look right.
      expect(store.events(run.id)).toHaveLength(total);
      store.close();
    });

    test("concurrent appends across two runs do not share a counter", async () => {
      const store = factory.create();
      const one = makeRun("run-1", DEFAULT_SCOPE);
      const two = makeRun("run-2", DEFAULT_SCOPE);
      store.save(one);
      store.save(two);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          Promise.resolve().then(() => {
            store.append(one.id, `a.${index}`);
            store.append(two.id, `b.${index}`);
          }),
        ),
      );
      expect(store.events(one.id).map((event) => event.sequence)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
      expect(store.events(two.id).map((event) => event.sequence)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
      store.close();
    });

    test("a redacted field reaches neither the returned record nor storage", () => {
      const store = factory.create({ redactor: fieldRedactor(["apiToken", "password"]) });
      const secret = "s3cr3t-do-not-persist";
      const run = makeRun("run-1", DEFAULT_SCOPE, {
        input: { credentials: { apiToken: secret }, title: "Fix" },
      });
      store.save(run);
      const record = store.append(run.id, "provider.attempt.failed", {
        error: "auth failed",
        context: { password: secret },
      });

      expect(record.payload).toEqual({ error: "auth failed", context: { password: "[redacted]" } });
      expect(store.events(run.id)[0]?.payload).toEqual({
        error: "auth failed",
        context: { password: "[redacted]" },
      });
      const stored = store.revisions(run.id)[0]?.run.input as { credentials: { apiToken: string } };
      expect(stored.credentials.apiToken).toBe("[redacted]");
      // The live object is untouched: redaction is a storage concern, not a
      // mutation of the caller's run.
      expect((run.input as { credentials: { apiToken: string } }).credentials.apiToken).toBe(secret);

      store.close();
      if (factory.durable) {
        const bytes = factory
          .files()
          .filter((file) => existsSync(file))
          .map((file) => readFileSync(file).toString("binary"))
          .join("");
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.includes(secret)).toBe(false);
      }
    });

    test("an unrepresentable run is tagged lossy instead of losing the write", () => {
      // action-runtime saves a run before fingerprinting on the dry-run path,
      // and its own test feeds BigInt input down it. Throwing here would turn a
      // green upstream test red.
      const store = factory.create();
      const run = makeRun("run-1", DEFAULT_SCOPE, { input: { metadata: BigInt(1) } });
      expect(() => store.save(run)).not.toThrow();
      const revision = store.revisions(run.id)[0];
      expect(revision?.lossy).toBe(true);
      expect(revision?.run.input).toEqual({ metadata: { $unstorable: "bigint" } });
      const equivalence = store.replayEquivalence(run.id);
      expect(equivalence.lossy).toBe(true);
      expect(store.replay(run.id).lossy).toBe(true);
      store.close();
    });

    test("strictSerialization turns the same case into a hard failure", () => {
      const store = factory.create({ strictSerialization: true });
      const run = makeRun("run-1", DEFAULT_SCOPE, { input: { metadata: BigInt(1) } });
      expect(() => store.save(run)).toThrow(SerializationError);
      const ok = makeRun("run-2", DEFAULT_SCOPE);
      store.save(ok);
      expect(() => store.append(ok.id, "bad", { value: Number.NaN })).toThrow(SerializationError);
      store.close();
    });

    test("idempotency claims persist, replay, and conflict on a changed fingerprint", () => {
      const store = factory.create();
      const claim = {
        scope: { tenant: "t-1", workspace: "w-1", snapshot: "snapshot-1" },
        action: "ResolveTicket",
        idempotencyKey: "k-1",
        fingerprint: "fp-1",
        runId: "run-1",
      };
      expect(store.claimIdempotency(claim)).toMatchObject({
        status: "claimed",
        record: { runId: "run-1" },
      });
      expect(store.claimIdempotency({ ...claim, runId: "run-2" })).toMatchObject({
        status: "replayed",
        record: { runId: "run-1" },
      });
      expect(() => store.claimIdempotency({ ...claim, fingerprint: "fp-2" })).toThrow(
        IdempotencyConflictError,
      );
      expect(store.lookupIdempotency(claim.scope, claim.action, "k-1")?.runId).toBe("run-1");
      expect(store.lookupIdempotency(claim.scope, claim.action, "k-absent")).toBeUndefined();
      store.close();
    });

    test("the idempotency tuple is scoped, unambiguous, and rejects an empty key", () => {
      const store = factory.create();
      const base = {
        action: "ResolveTicket",
        idempotencyKey: "k-1",
        fingerprint: "fp-1",
        runId: "run-1",
      };
      expect(
        store.claimIdempotency({ ...base, scope: { tenant: "a|b", workspace: "c", snapshot: "s" } }).status,
      ).toBe("claimed");
      // Different tenant tuple with a different input must not collide.
      expect(
        store.claimIdempotency({
          ...base,
          scope: { tenant: "a", workspace: "b|c", snapshot: "s" },
          fingerprint: "fp-2",
          runId: "run-2",
        }).status,
      ).toBe("claimed");
      // A different action under the same key is a different tuple too.
      expect(
        store.claimIdempotency({
          ...base,
          action: "ArchiveTicket",
          scope: { tenant: "a|b", workspace: "c", snapshot: "s" },
          fingerprint: "fp-3",
        }).status,
      ).toBe("claimed");
      expect(() =>
        store.claimIdempotency({ ...base, idempotencyKey: "", scope: { tenant: "t", workspace: "w", snapshot: "s" } }),
      ).toThrow(IdempotencyConflictError);
      store.close();
    });

    test("a scoped view reports the scope it is pinned to", () => {
      const store = factory.create();
      const view = store.scoped({ snapshot: "snapshot-1" });
      expect(view.scope).toEqual({ tenant: "", workspace: "", snapshot: "snapshot-1" });
      expect(scopeKey(view.scope)).toBe(JSON.stringify(["", "", "snapshot-1"]));
      store.close();
    });
  });
}
