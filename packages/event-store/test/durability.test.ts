import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlEventStore, SequenceIntegrityError, SqliteEventStore } from "../src/index.ts";

interface TestRun {
  id: string;
  action: string;
  status: string;
  output?: unknown;
  context: { snapshot: string; tenant?: string; workspace?: string };
}

const SCOPE = { tenant: "t-1", workspace: "w-1", snapshot: "snapshot-1" };

function makeRun(id: string, status = "planned"): TestRun {
  return { id, action: "ResolveTicket", status, context: SCOPE };
}

let directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "event-store-durability-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

/** "Crash" = drop the reference without closing, then open the same path fresh. */
describe("SqliteEventStore — durability", () => {
  test("events, revisions and idempotency survive a reopen", () => {
    const path = join(scratch(), "events.sqlite");
    const first = new SqliteEventStore<TestRun>({ path });
    const run = makeRun("run-1");
    first.save(run);
    first.append(run.id, "run.created", { status: "planned" });
    run.status = "succeeded";
    run.output = { ok: true };
    first.save(run);
    first.append(run.id, "run.succeeded");
    first.claimIdempotency({
      scope: SCOPE,
      action: "ResolveTicket",
      idempotencyKey: "k-1",
      fingerprint: "fp-1",
      runId: run.id,
    });
    first.close();

    const second = new SqliteEventStore<TestRun>({ path });
    // The root store has not learned this runId's scope in the new process.
    expect(second.events(run.id).length).toBe(0);
    const view = second.scoped(SCOPE);
    expect(view.events(run.id).map((event) => event.type)).toEqual([
      "run.created",
      "run.succeeded",
    ]);
    // No live cache exists in the reopened process, so this is a real fold.
    expect(view.get(run.id)).toEqual({ ...run, status: "succeeded", output: { ok: true } });
    expect(second.replay(run.id, SCOPE).revisions.map((entry) => entry.run.status)).toEqual([
      "planned",
      "succeeded",
    ]);
    expect(second.lookupIdempotency(SCOPE, "ResolveTicket", "k-1")?.fingerprint).toBe("fp-1");
    // A restart must not reset the conflict check — this is what a process-local
    // Map loses (§16 Phase 4 item 3, action-runtime/src/index.ts:19).
    expect(() =>
      second.claimIdempotency({
        scope: SCOPE,
        action: "ResolveTicket",
        idempotencyKey: "k-1",
        fingerprint: "fp-CHANGED",
        runId: "run-2",
      }),
    ).toThrow("Idempotency conflict");
    second.close();
  });

  test("an unclosed store leaves a readable database (WAL)", () => {
    const path = join(scratch(), "events.sqlite");
    const abandoned = new SqliteEventStore<TestRun>({ path });
    const run = makeRun("run-1");
    abandoned.save(run);
    abandoned.append(run.id, "run.created");
    // Deliberately no close(): this is the crash shape.

    const recovered = new SqliteEventStore<TestRun>({ path });
    expect(recovered.scoped(SCOPE).events(run.id).map((event) => event.type)).toEqual([
      "run.created",
    ]);
    recovered.close();
    abandoned.close();
  });

  test("the database itself rejects a rewrite of history", () => {
    const path = join(scratch(), "events.sqlite");
    const database = new Database(path, { create: true });
    const store = new SqliteEventStore<TestRun>({ path, database });
    const run = makeRun("run-1");
    store.save(run);
    store.append(run.id, "run.created");

    expect(() => database.run("UPDATE events SET type = 'tampered'")).toThrow(
      "events are append-only",
    );
    expect(() => database.run("DELETE FROM events")).toThrow("events are append-only");
    expect(() => database.run("UPDATE run_revisions SET run = '{}'")).toThrow(
      "run revisions are append-only",
    );
    expect(() => database.run("DELETE FROM run_revisions")).toThrow(
      "run revisions are append-only",
    );
    expect(store.scoped(SCOPE).events(run.id)[0]?.type).toBe("run.created");
    store.close();
    database.close();
  });

  test("a gap in the persisted sequence is reported, not silently smoothed", () => {
    const path = join(scratch(), "events.sqlite");
    const database = new Database(path, { create: true });
    const store = new SqliteEventStore<TestRun>({ path, database });
    const run = makeRun("run-1");
    store.save(run);
    store.append(run.id, "run.created");
    // Insert out of band to fabricate the corruption a reader must catch.
    database.run(
      `INSERT INTO events (scope_key, tenant, workspace, snapshot, run_id, sequence, type, at, payload, lossy)
       VALUES (?, ?, ?, ?, ?, 5, 'orphan', 0, '{}', 0)`,
      [
        JSON.stringify([SCOPE.tenant, SCOPE.workspace, SCOPE.snapshot]),
        SCOPE.tenant,
        SCOPE.workspace,
        SCOPE.snapshot,
        run.id,
      ],
    );
    expect(() => store.scoped(SCOPE).events(run.id)).toThrow(SequenceIntegrityError);
    store.close();
    database.close();
  });
});

describe("JsonlEventStore — durability", () => {
  test("events, revisions and idempotency survive a reopen", () => {
    const path = join(scratch(), "events.jsonl");
    const first = new JsonlEventStore<TestRun>({ path });
    const run = makeRun("run-1");
    first.save(run);
    first.append(run.id, "run.created");
    run.status = "succeeded";
    first.save(run);
    first.claimIdempotency({
      scope: SCOPE,
      action: "ResolveTicket",
      idempotencyKey: "k-1",
      fingerprint: "fp-1",
      runId: run.id,
    });
    first.close();

    const second = new JsonlEventStore<TestRun>({ path });
    const view = second.scoped(SCOPE);
    expect(view.events(run.id).map((event) => event.type)).toEqual(["run.created"]);
    expect(view.get(run.id)?.status).toBe("succeeded");
    expect(second.lookupIdempotency(SCOPE, "ResolveTicket", "k-1")?.runId).toBe("run-1");
    // Sequence allocation continues from the recovered index rather than from 1.
    expect(view.append(run.id, "run.succeeded").sequence).toBe(2);
    second.close();
  });

  test("a torn final line is dropped and everything before it is kept", () => {
    const path = join(scratch(), "events.jsonl");
    const first = new JsonlEventStore<TestRun>({ path });
    const run = makeRun("run-1");
    first.save(run);
    first.append(run.id, "run.created");
    first.close();
    // A crash mid-append leaves a partial line with no trailing newline.
    appendFileSync(path, '{"k":"event","key":"[', "utf8");

    const second = new JsonlEventStore<TestRun>({ path });
    expect(second.scoped(SCOPE).events(run.id).map((event) => event.type)).toEqual(["run.created"]);
    second.close();
  });

  test("a missing file is created rather than treated as an error", () => {
    const path = join(scratch(), "nested", "events.jsonl");
    const store = new JsonlEventStore<TestRun>({ path });
    const run = makeRun("run-1");
    store.save(run);
    store.append(run.id, "run.created");
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    store.close();
  });

  test("an out-of-order recovered log is sorted before it is served", () => {
    const path = join(scratch(), "events.jsonl");
    const key = JSON.stringify([SCOPE.tenant, SCOPE.workspace, SCOPE.snapshot]);
    const event = (sequence: number, type: string) =>
      JSON.stringify({
        k: "event",
        scope: SCOPE,
        key,
        runId: "run-1",
        sequence,
        type,
        at: 0,
        payload: "{}",
        lossy: false,
      });
    writeFileSync(path, `${event(2, "second")}\n${event(1, "first")}\n`, "utf8");
    const store = new JsonlEventStore<TestRun>({ path });
    expect(store.scoped(SCOPE).events("run-1").map((entry) => entry.type)).toEqual([
      "first",
      "second",
    ]);
    store.close();
  });
});
