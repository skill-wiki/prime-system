import {
  type EventRecord,
  type EventStore,
  type IdempotencyClaim,
  type IdempotencyOutcome,
  type IdempotencyRecord,
  type PersistableRun,
  type PersistentEventStore,
  type ReplayEquivalence,
  type ReplayResult,
  type RunRevision,
  type RunScope,
  type RunScopeSource,
  IdempotencyConflictError,
  RunScopeConflictError,
  SequenceIntegrityError,
} from "./contracts.ts";
import { type Redactor, identityRedactor } from "./redaction.ts";
import { decode, encode } from "./serialize.ts";
import { idempotencyKeyOf, sameScope, scopeKey, toScope } from "./scope.ts";

export interface StoredEventRow {
  readonly sequence: number;
  readonly type: string;
  readonly at: number;
  readonly payload: string;
  readonly lossy: boolean;
}

export interface StoredRevisionRow {
  readonly revision: number;
  readonly at: number;
  readonly run: string;
  readonly lossy: boolean;
}

/**
 * The only thing a backend must do is append rows atomically and read them back
 * in order. Sequence assignment lives here rather than in the base class so a
 * backend can make it atomic in its own terms (SQLite does it in one statement),
 * which is the difference between "monotonic under interleaving" and "monotonic
 * under concurrency".
 */
export interface EventStoreBackend {
  appendEvent(
    scope: RunScope,
    key: string,
    runId: string,
    type: string,
    at: number,
    payload: string,
    lossy: boolean,
  ): number;
  readEvents(key: string, runId: string): readonly StoredEventRow[];
  appendRevision(
    scope: RunScope,
    key: string,
    runId: string,
    at: number,
    run: string,
    lossy: boolean,
  ): number;
  readRevisions(key: string, runId: string): readonly StoredRevisionRow[];
  /**
   * Insert-if-absent. `inserted` must reflect whether *this* call won the row,
   * so the caller can tell a fresh claim from a replay without a second read
   * that another writer could slip between.
   */
  putIdempotency(
    tupleKey: string,
    record: IdempotencyRecord,
  ): { readonly record: IdempotencyRecord; readonly inserted: boolean };
  getIdempotency(tupleKey: string): IdempotencyRecord | undefined;
  close(): void;
}

export interface EventStoreOptions {
  /**
   * Scope used for an `append()` on a runId the store has never seen a run for.
   * action-runtime always `save()`s before its first `append()`
   * (src/index.ts:29), so this is a backstop, not the normal path.
   */
  readonly defaultScope?: RunScopeSource;
  readonly redactor?: Redactor;
  /** Throw instead of tagging when a value cannot be represented. */
  readonly strictSerialization?: boolean;
  readonly now?: () => number;
}

const UNSCOPED: RunScope = { tenant: "", workspace: "", snapshot: "" };

function cacheKey(key: string, runId: string): string {
  return `${key}\u0000${runId}`;
}

export abstract class BaseEventStore<TRun extends PersistableRun = PersistableRun>
  implements PersistentEventStore<TRun>
{
  private readonly redactor: Redactor;
  private readonly strict: boolean;
  private readonly clock: () => number;
  private readonly defaultScope: RunScope;
  /** runId -> scope, learned from `save()`; only used by the unscoped root. */
  private readonly runScopes = new Map<string, RunScope>();
  /**
   * Preserves the object identity `InMemoryEventStore` gives back, which
   * action-runtime depends on: `approve()` reads a run out of the store and
   * mutates it (src/index.ts:28) while its in-flight idempotency map still
   * holds the same reference (:19). Handing back a fresh JSON clone would make
   * a replayed idempotency hit report a stale status.
   */
  private readonly live = new Map<string, TRun>();

  protected constructor(
    private readonly backend: EventStoreBackend,
    options: EventStoreOptions = {},
  ) {
    this.redactor = options.redactor ?? identityRedactor;
    this.strict = options.strictSerialization ?? false;
    this.clock = options.now ?? Date.now;
    this.defaultScope = options.defaultScope ? toScope(options.defaultScope) : UNSCOPED;
  }

  // --- EventStore, unscoped root view -------------------------------------

  append(runId: string, type: string, payload: Record<string, unknown> = {}): EventRecord {
    return this.appendIn(this.scopeFor(runId), runId, type, payload);
  }

  events(runId: string): readonly EventRecord[] {
    return this.eventsIn(this.scopeFor(runId), runId);
  }

  save(run: TRun): void {
    const scope = toScope(run.context);
    const known = this.runScopes.get(run.id);
    if (known && !sameScope(known, scope)) {
      // A flat runId cannot address two scopes. Fail closed rather than let one
      // tenant's revision land on another tenant's run.
      throw new RunScopeConflictError(
        `Run ${run.id} already belongs to scope ${scopeKey(known)}; refusing scope ${scopeKey(scope)}. Use scoped() for per-tenant views.`,
      );
    }
    this.runScopes.set(run.id, scope);
    this.saveIn(scope, run);
  }

  get(runId: string): TRun | undefined {
    return this.getIn(this.scopeFor(runId), runId);
  }

  // --- PersistentEventStore ----------------------------------------------

  scoped(source: RunScopeSource): EventStore<TRun> & { readonly scope: RunScope } {
    return new ScopedEventStoreView<TRun>(this, toScope(source));
  }

  replay(runId: string, source?: RunScopeSource): ReplayResult<TRun> {
    const scope = source ? toScope(source) : this.scopeFor(runId);
    return this.replayIn(scope, runId);
  }

  revisions(runId: string, source?: RunScopeSource): readonly RunRevision<TRun>[] {
    const scope = source ? toScope(source) : this.scopeFor(runId);
    return this.revisionsIn(scope, runId);
  }

  /**
   * Compares the live object against the bytes on disk rather than against a
   * re-encoding of the folded object, so the assertion covers the write path
   * and not just the reducer.
   */
  replayEquivalence(runId: string, source?: RunScopeSource): ReplayEquivalence {
    const scope = source ? toScope(source) : this.scopeFor(runId);
    const key = scopeKey(scope);
    const rows = this.backend.readRevisions(key, runId);
    const stored = rows[rows.length - 1];
    const live = this.live.get(cacheKey(key, runId));
    if (!stored || !live) {
      return { equivalent: stored === undefined && live === undefined, lossy: false };
    }
    const expected = encode(this.redactor.run(live, { scope, runId }), this.strict);
    return {
      equivalent: expected.json === stored.run,
      lossy: stored.lossy || expected.lossy,
      live: expected.json,
      stored: stored.run,
    };
  }

  claimIdempotency(claim: IdempotencyClaim): IdempotencyOutcome {
    if (!claim.idempotencyKey) throw new IdempotencyConflictError("Idempotency key is required");
    const scope = toScope(claim.scope);
    const tuple = idempotencyKeyOf(scope, claim.action, claim.idempotencyKey);
    const { record, inserted } = this.backend.putIdempotency(tuple, {
      ...claim,
      scope,
      at: this.clock(),
    });
    if (record.fingerprint !== claim.fingerprint) {
      // Fail closed: the same tuple with a different input is the case a
      // process-local Map silently loses across a restart (§16 Phase 4).
      throw new IdempotencyConflictError("Idempotency conflict: key reused with different input");
    }
    return { status: inserted ? "claimed" : "replayed", record };
  }

  lookupIdempotency(
    source: RunScopeSource,
    action: string,
    idempotencyKey: string,
  ): IdempotencyRecord | undefined {
    return this.backend.getIdempotency(idempotencyKeyOf(toScope(source), action, idempotencyKey));
  }

  close(): void {
    this.backend.close();
  }

  // --- scope-explicit internals, shared with ScopedEventStoreView ---------

  /** @internal */
  appendIn(
    scope: RunScope,
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): EventRecord {
    const key = scopeKey(scope);
    const redacted = this.redactor.event(payload, { scope, runId, type });
    const { json, lossy } = encode(redacted, this.strict);
    const at = this.clock();
    const sequence = this.backend.appendEvent(scope, key, runId, type, at, json, lossy);
    // The returned payload is the redacted one: nothing withheld from disk may
    // leak through the in-process return value (§12.3).
    return Object.freeze({ sequence, runId, type, at, payload: Object.freeze(redacted) });
  }

  /** @internal */
  eventsIn(scope: RunScope, runId: string): readonly EventRecord[] {
    const rows = this.backend.readEvents(scopeKey(scope), runId);
    return rows.map((row, index) => {
      if (row.sequence !== index + 1) {
        throw new SequenceIntegrityError(
          `Run ${runId} in scope ${scopeKey(scope)} has a sequence break: expected ${index + 1}, found ${row.sequence}`,
        );
      }
      return Object.freeze({
        sequence: row.sequence,
        runId,
        type: row.type,
        at: row.at,
        payload: Object.freeze(decode<Record<string, unknown>>(row.payload)),
      });
    });
  }

  /** @internal */
  saveIn(scope: RunScope, run: TRun): void {
    const key = scopeKey(scope);
    const redacted = this.redactor.run(run, { scope, runId: run.id });
    const { json, lossy } = encode(redacted, this.strict);
    this.backend.appendRevision(scope, key, run.id, this.clock(), json, lossy);
    this.live.set(cacheKey(key, run.id), run);
  }

  /** @internal */
  getIn(scope: RunScope, runId: string): TRun | undefined {
    const key = scopeKey(scope);
    const cached = this.live.get(cacheKey(key, runId));
    if (cached) return cached;
    const folded = this.foldRevisions(scope, runId);
    return folded.length === 0 ? undefined : folded[folded.length - 1]!.run;
  }

  /** @internal */
  revisionsIn(scope: RunScope, runId: string): readonly RunRevision<TRun>[] {
    return this.foldRevisions(scope, runId);
  }

  /** @internal */
  replayIn(scope: RunScope, runId: string): ReplayResult<TRun> {
    const revisions = this.foldRevisions(scope, runId);
    const events = this.eventsIn(scope, runId);
    const last = revisions[revisions.length - 1];
    return {
      runId,
      scope,
      // Deliberately not `getIn`: replay must come out of the log, never out of
      // the identity cache, or the invariant it proves is vacuous (§17.3).
      run: last?.run,
      events,
      revisions,
      lossy: revisions.some((entry) => entry.lossy),
    };
  }

  private foldRevisions(scope: RunScope, runId: string): readonly RunRevision<TRun>[] {
    const rows = this.backend.readRevisions(scopeKey(scope), runId);
    return rows.map((row, index) => {
      if (row.revision !== index + 1) {
        throw new SequenceIntegrityError(
          `Run ${runId} in scope ${scopeKey(scope)} has a revision break: expected ${index + 1}, found ${row.revision}`,
        );
      }
      return {
        revision: row.revision,
        runId,
        scope,
        at: row.at,
        run: decode<TRun>(row.run),
        lossy: row.lossy,
      };
    });
  }

  private scopeFor(runId: string): RunScope {
    return this.runScopes.get(runId) ?? this.defaultScope;
  }
}

class ScopedEventStoreView<TRun extends PersistableRun> implements EventStore<TRun> {
  constructor(
    private readonly base: BaseEventStore<TRun>,
    readonly scope: RunScope,
  ) {}

  append(runId: string, type: string, payload: Record<string, unknown> = {}): EventRecord {
    return this.base.appendIn(this.scope, runId, type, payload);
  }

  events(runId: string): readonly EventRecord[] {
    return this.base.eventsIn(this.scope, runId);
  }

  save(run: TRun): void {
    this.base.saveIn(this.scope, run);
  }

  get(runId: string): TRun | undefined {
    return this.base.getIn(this.scope, runId);
  }

  replay(runId: string): ReplayResult<TRun> {
    return this.base.replayIn(this.scope, runId);
  }
}
