import {
  type IdempotencyRecord,
  type PersistableRun,
  type RunScope,
  AppendOnlyViolationError,
} from "./contracts.ts";
import {
  BaseEventStore,
  type EventStoreBackend,
  type EventStoreOptions,
  type StoredEventRow,
  type StoredRevisionRow,
} from "./base.ts";

function rowKey(key: string, runId: string): string {
  return `${key}\u0000${runId}`;
}

class MemoryBackend implements EventStoreBackend {
  private readonly events = new Map<string, StoredEventRow[]>();
  private readonly revisions = new Map<string, StoredRevisionRow[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  appendEvent(
    _scope: RunScope,
    key: string,
    runId: string,
    type: string,
    at: number,
    payload: string,
    lossy: boolean,
  ): number {
    const id = rowKey(key, runId);
    const rows = this.events.get(id) ?? [];
    const sequence = rows.length + 1;
    if (rows.some((row) => row.sequence === sequence)) {
      throw new AppendOnlyViolationError(`Sequence ${sequence} already exists for run ${runId}`);
    }
    rows.push(Object.freeze({ sequence, type, at, payload, lossy }));
    this.events.set(id, rows);
    return sequence;
  }

  readEvents(key: string, runId: string): readonly StoredEventRow[] {
    return this.events.get(rowKey(key, runId)) ?? [];
  }

  appendRevision(
    _scope: RunScope,
    key: string,
    runId: string,
    at: number,
    run: string,
    lossy: boolean,
  ): number {
    const id = rowKey(key, runId);
    const rows = this.revisions.get(id) ?? [];
    const revision = rows.length + 1;
    rows.push(Object.freeze({ revision, at, run, lossy }));
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
    this.idempotency.set(tupleKey, Object.freeze(record));
    return { record, inserted: true };
  }

  getIdempotency(tupleKey: string): IdempotencyRecord | undefined {
    return this.idempotency.get(tupleKey);
  }

  close(): void {
    // Nothing to release; kept so all three implementations share one contract.
  }
}

/**
 * The reference implementation. It exists to be the control in the contract
 * suite: any behaviour the SQLite or JSONL store shows that this one does not
 * is a bug in the persistent path, not a property of persistence.
 */
export class MemoryEventStore<TRun extends PersistableRun = PersistableRun> extends BaseEventStore<TRun> {
  constructor(options: EventStoreOptions = {}) {
    super(new MemoryBackend(), options);
  }
}
