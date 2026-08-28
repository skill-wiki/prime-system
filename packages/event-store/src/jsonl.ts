import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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

export interface JsonlEventStoreOptions extends EventStoreOptions {
  readonly path: string;
}

type Line =
  | {
      readonly k: "event";
      readonly scope: RunScope;
      readonly key: string;
      readonly runId: string;
      readonly sequence: number;
      readonly type: string;
      readonly at: number;
      readonly payload: string;
      readonly lossy: boolean;
    }
  | {
      readonly k: "revision";
      readonly scope: RunScope;
      readonly key: string;
      readonly runId: string;
      readonly revision: number;
      readonly at: number;
      readonly run: string;
      readonly lossy: boolean;
    }
  | { readonly k: "idem"; readonly tupleKey: string; readonly record: IdempotencyRecord };

function rowKey(key: string, runId: string): string {
  return `${key}\u0000${runId}`;
}

/**
 * The no-SQLite fallback. Correctness limit stated up front: sequence
 * allocation is guarded by an in-process index, so two processes appending to
 * the same file can duplicate a sequence. SQLite allocates under a write lock
 * and does not have that hole — prefer it whenever it is available.
 */
class JsonlBackend implements EventStoreBackend {
  private readonly events = new Map<string, StoredEventRow[]>();
  private readonly revisions = new Map<string, StoredRevisionRow[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  constructor(private readonly path: string) {
    const directory = dirname(path);
    if (directory && !existsSync(directory)) mkdirSync(directory, { recursive: true });
    if (existsSync(path)) this.load();
  }

  /** Rebuilding the index from the log is the recovery path, not a fast path. */
  private load(): void {
    const text = readFileSync(this.path, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: Line;
      try {
        parsed = JSON.parse(line) as Line;
      } catch {
        // A torn final line is the expected shape of a crash mid-append. Every
        // earlier line is intact, so recovery keeps them rather than refusing
        // to open the store at all.
        continue;
      }
      if (parsed.k === "event") {
        const id = rowKey(parsed.key, parsed.runId);
        const rows = this.events.get(id) ?? [];
        rows.push({
          sequence: parsed.sequence,
          type: parsed.type,
          at: parsed.at,
          payload: parsed.payload,
          lossy: parsed.lossy,
        });
        this.events.set(id, rows);
      } else if (parsed.k === "revision") {
        const id = rowKey(parsed.key, parsed.runId);
        const rows = this.revisions.get(id) ?? [];
        rows.push({ revision: parsed.revision, at: parsed.at, run: parsed.run, lossy: parsed.lossy });
        this.revisions.set(id, rows);
      } else {
        this.idempotency.set(parsed.tupleKey, parsed.record);
      }
    }
    for (const rows of this.events.values()) rows.sort((a, b) => a.sequence - b.sequence);
    for (const rows of this.revisions.values()) rows.sort((a, b) => a.revision - b.revision);
  }

  private write(line: Line): void {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, "utf8");
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
    const id = rowKey(key, runId);
    const rows = this.events.get(id) ?? [];
    const sequence = (rows[rows.length - 1]?.sequence ?? 0) + 1;
    if (rows.some((row) => row.sequence === sequence)) {
      throw new AppendOnlyViolationError(`Sequence ${sequence} already exists for run ${runId}`);
    }
    this.write({ k: "event", scope, key, runId, sequence, type, at, payload, lossy });
    rows.push({ sequence, type, at, payload, lossy });
    this.events.set(id, rows);
    return sequence;
  }

  readEvents(key: string, runId: string): readonly StoredEventRow[] {
    return this.events.get(rowKey(key, runId)) ?? [];
  }

  appendRevision(
    scope: RunScope,
    key: string,
    runId: string,
    at: number,
    run: string,
    lossy: boolean,
  ): number {
    const id = rowKey(key, runId);
    const rows = this.revisions.get(id) ?? [];
    const revision = (rows[rows.length - 1]?.revision ?? 0) + 1;
    this.write({ k: "revision", scope, key, runId, revision, at, run, lossy });
    rows.push({ revision, at, run, lossy });
    this.revisions.set(id, rows);
    return revision;
  }

  readRevisions(key: string, runId: string): readonly StoredRevisionRow[] {
    return this.revisions.get(rowKey(key, runId)) ?? [];
  }

  putIdempotency(
    tupleKey: string,
    record: IdempotencyRecord,
  ): { readonly record: IdempotencyRecord; readonly inserted: boolean } {
    const existing = this.idempotency.get(tupleKey);
    if (existing) return { record: existing, inserted: false };
    this.write({ k: "idem", tupleKey, record });
    this.idempotency.set(tupleKey, record);
    return { record, inserted: true };
  }

  getIdempotency(tupleKey: string): IdempotencyRecord | undefined {
    return this.idempotency.get(tupleKey);
  }

  close(): void {
    // Every write is an fs append that has already returned; nothing buffered.
  }
}

export class JsonlEventStore<TRun extends PersistableRun = PersistableRun> extends BaseEventStore<TRun> {
  constructor(options: JsonlEventStoreOptions) {
    if (!options.path) throw new EventStoreError("JsonlEventStore requires a path");
    super(new JsonlBackend(options.path), options);
  }
}
