import { Database } from "bun:sqlite";
import {
  type IdempotencyRecord,
  type PersistableRun,
  type RunScope,
  AppendOnlyViolationError,
  EventStoreError,
} from "./contracts.ts";
import {
  BaseEventStore,
  type EventStoreBackend,
  type EventStoreOptions,
  type StoredEventRow,
  type StoredRevisionRow,
} from "./base.ts";

export interface SqliteEventStoreOptions extends EventStoreOptions {
  /** File path, or ":memory:" for an ephemeral database. */
  readonly path: string;
  /** Reuse an already-open database instead of opening `path`. */
  readonly database?: Database;
}

interface SequenceRow {
  readonly sequence: number;
}

interface RevisionNumberRow {
  readonly revision: number;
}

interface IdempotencyRow {
  readonly tenant: string;
  readonly workspace: string;
  readonly snapshot: string;
  readonly action: string;
  readonly idempotency_key: string;
  readonly fingerprint: string;
  readonly run_id: string;
  readonly at: number;
}

interface EventRow {
  readonly sequence: number;
  readonly type: string;
  readonly at: number;
  readonly payload: string;
  readonly lossy: number;
}

interface RevisionRow {
  readonly revision: number;
  readonly at: number;
  readonly run: string;
  readonly lossy: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  scope_key TEXT NOT NULL,
  tenant    TEXT NOT NULL,
  workspace TEXT NOT NULL,
  snapshot  TEXT NOT NULL,
  run_id    TEXT NOT NULL,
  sequence  INTEGER NOT NULL,
  type      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  payload   TEXT NOT NULL,
  lossy     INTEGER NOT NULL,
  PRIMARY KEY (scope_key, run_id, sequence)
);
CREATE INDEX IF NOT EXISTS events_by_scope ON events (tenant, workspace, snapshot, run_id, sequence);

CREATE TABLE IF NOT EXISTS run_revisions (
  scope_key TEXT NOT NULL,
  tenant    TEXT NOT NULL,
  workspace TEXT NOT NULL,
  snapshot  TEXT NOT NULL,
  run_id    TEXT NOT NULL,
  revision  INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  run       TEXT NOT NULL,
  lossy     INTEGER NOT NULL,
  PRIMARY KEY (scope_key, run_id, revision)
);
CREATE INDEX IF NOT EXISTS revisions_by_scope ON run_revisions (tenant, workspace, snapshot, run_id, revision);

CREATE TABLE IF NOT EXISTS idempotency (
  tuple_key       TEXT PRIMARY KEY,
  tenant          TEXT NOT NULL,
  workspace       TEXT NOT NULL,
  snapshot        TEXT NOT NULL,
  action          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  at              INTEGER NOT NULL
);

-- Append-only is enforced by the database, not by discipline: a bug or a
-- migration script cannot rewrite history without tripping these.
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON run_revisions
  BEGIN SELECT RAISE(ABORT, 'run revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON run_revisions
  BEGIN SELECT RAISE(ABORT, 'run revisions are append-only'); END;
`;

class SqliteBackend implements EventStoreBackend {
  private readonly db: Database;
  private readonly owned: boolean;

  constructor(options: SqliteEventStoreOptions) {
    this.owned = options.database === undefined;
    this.db = options.database ?? new Database(options.path, { create: true });
    // WAL so an unclean exit leaves a recoverable log rather than a torn page.
    if (options.path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  appendEvent(
    scope: RunScope,
    key: string,
    runId: string,
    type: string,
    at: number,
    payload: string,
    lossy: boolean,
  ): number {
    // One statement, so MAX(sequence)+1 and the insert cannot be split by
    // another writer: the sequence is allocated under the same write lock that
    // commits the row. A read-then-insert would be monotonic only by luck.
    const row = this.db
      .query<SequenceRow, [string, string, string, string, string, string, number, string, number, string, string]>(
        `INSERT INTO events (scope_key, tenant, workspace, snapshot, run_id, sequence, type, at, payload, lossy)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?
           FROM events WHERE scope_key = ? AND run_id = ?
         RETURNING sequence`,
      )
      .get(
        key,
        scope.tenant,
        scope.workspace,
        scope.snapshot,
        runId,
        type,
        at,
        payload,
        lossy ? 1 : 0,
        key,
        runId,
      );
    if (!row) throw new EventStoreError(`Failed to append event for run ${runId}`);
    return row.sequence;
  }

  readEvents(key: string, runId: string): readonly StoredEventRow[] {
    return this.db
      .query<EventRow, [string, string]>(
        `SELECT sequence, type, at, payload, lossy FROM events
          WHERE scope_key = ? AND run_id = ? ORDER BY sequence ASC`,
      )
      .all(key, runId)
      .map((row) => ({
        sequence: row.sequence,
        type: row.type,
        at: row.at,
        payload: row.payload,
        lossy: row.lossy === 1,
      }));
  }

  appendRevision(
    scope: RunScope,
    key: string,
    runId: string,
    at: number,
    run: string,
    lossy: boolean,
  ): number {
    const row = this.db
      .query<RevisionNumberRow, [string, string, string, string, string, number, string, number, string, string]>(
        `INSERT INTO run_revisions (scope_key, tenant, workspace, snapshot, run_id, revision, at, run, lossy)
         SELECT ?, ?, ?, ?, ?, COALESCE(MAX(revision), 0) + 1, ?, ?, ?
           FROM run_revisions WHERE scope_key = ? AND run_id = ?
         RETURNING revision`,
      )
      .get(key, scope.tenant, scope.workspace, scope.snapshot, runId, at, run, lossy ? 1 : 0, key, runId);
    if (!row) throw new EventStoreError(`Failed to append revision for run ${runId}`);
    return row.revision;
  }

  readRevisions(key: string, runId: string): readonly StoredRevisionRow[] {
    return this.db
      .query<RevisionRow, [string, string]>(
        `SELECT revision, at, run, lossy FROM run_revisions
          WHERE scope_key = ? AND run_id = ? ORDER BY revision ASC`,
      )
      .all(key, runId)
      .map((row) => ({ revision: row.revision, at: row.at, run: row.run, lossy: row.lossy === 1 }));
  }

  putIdempotency(
    tupleKey: string,
    record: IdempotencyRecord,
  ): { readonly record: IdempotencyRecord; readonly inserted: boolean } {
    const changes = this.db
      .query<
        never,
        [string, string, string, string, string, string, string, string, number]
      >(
        `INSERT INTO idempotency (tuple_key, tenant, workspace, snapshot, action, idempotency_key, fingerprint, run_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tuple_key) DO NOTHING`,
      )
      .run(
        tupleKey,
        record.scope.tenant,
        record.scope.workspace,
        record.scope.snapshot,
        record.action,
        record.idempotencyKey,
        record.fingerprint,
        record.runId,
        record.at,
      );
    if (changes.changes === 1) return { record, inserted: true };
    const existing = this.getIdempotency(tupleKey);
    if (!existing) throw new EventStoreError(`Idempotency row ${tupleKey} vanished after conflict`);
    return { record: existing, inserted: false };
  }

  getIdempotency(tupleKey: string): IdempotencyRecord | undefined {
    const row = this.db
      .query<IdempotencyRow, [string]>(
        `SELECT tenant, workspace, snapshot, action, idempotency_key, fingerprint, run_id, at
           FROM idempotency WHERE tuple_key = ?`,
      )
      .get(tupleKey);
    if (!row) return undefined;
    return {
      scope: { tenant: row.tenant, workspace: row.workspace, snapshot: row.snapshot },
      action: row.action,
      idempotencyKey: row.idempotency_key,
      fingerprint: row.fingerprint,
      runId: row.run_id,
      at: row.at,
    };
  }

  close(): void {
    if (this.owned) this.db.close();
  }
}

/**
 * The §16 Phase 4 store. `bun:sqlite` is a built-in module and its API is
 * synchronous, which is what lets a durable store satisfy action-runtime's
 * synchronous `EventStore` without an async shim.
 */
export class SqliteEventStore<TRun extends PersistableRun = PersistableRun> extends BaseEventStore<TRun> {
  constructor(options: SqliteEventStoreOptions) {
    super(new SqliteBackend(options), options);
  }
}
