/**
 * These contracts are declared locally instead of imported from
 * `@skill-wiki/action-runtime` because the plan's forced dependency direction
 * (§15.4) runs consumer -> store, never the reverse. Importing the runtime here
 * would make the workspace graph circular the moment the coordinator wires
 * `action-runtime` to this package. TypeScript is structural, so a store built
 * against these shapes is assignable to the runtime's `EventStore` without
 * either package importing the other.
 *
 * Shapes copied verbatim from `packages/action-runtime/src/index.ts:2,7,10`.
 * `test/wiring.test.ts` pins that copy so drift fails a test rather than a
 * production wiring.
 */

/** Exactly `EventRecord` from action-runtime/src/index.ts:7. */
export interface EventRecord {
  sequence: number;
  runId: string;
  type: string;
  at: number;
  payload: Readonly<Record<string, unknown>>;
}

/**
 * The subset of `RequestContext` a store must read. `tenant`/`workspace` are
 * optional upstream (action-runtime/src/index.ts:2) while `snapshot` is
 * validated non-empty (`validateContext`, :25), so the scope tuple is
 * (tenant?, workspace?, snapshot).
 */
export interface RunScopeSource {
  readonly snapshot: string;
  readonly tenant?: string | undefined;
  readonly workspace?: string | undefined;
}

/**
 * The minimum a store needs off a run. Kept deliberately narrow: any richer
 * run type (action-runtime's `ActionRun`) is assignable to it, and the store is
 * generic over that richer type so `get()` hands the caller its own type back.
 */
export interface PersistableRun {
  readonly id: string;
  readonly context: RunScopeSource;
}

/**
 * Structural mirror of action-runtime's `EventStore` (:10), generic over the
 * run type so `get()` can return the caller's own run rather than this
 * narrowed view.
 */
export interface EventStore<TRun extends PersistableRun = PersistableRun> {
  append(runId: string, type: string, payload?: Record<string, unknown>): EventRecord;
  events(runId: string): readonly EventRecord[];
  save(run: TRun): void;
  get(runId: string): TRun | undefined;
}

/** A fully-qualified storage scope. §12.4: no key may be runId alone. */
export interface RunScope {
  readonly tenant: string;
  readonly workspace: string;
  readonly snapshot: string;
}

/** One append-only revision of a run's state. */
export interface RunRevision<TRun extends PersistableRun = PersistableRun> {
  readonly revision: number;
  readonly runId: string;
  readonly scope: RunScope;
  readonly at: number;
  readonly run: TRun;
  /** True when serialization could not represent the run faithfully. */
  readonly lossy: boolean;
}

/** Result of folding a run back out of its append-only log. */
export interface ReplayResult<TRun extends PersistableRun = PersistableRun> {
  readonly runId: string;
  readonly scope: RunScope;
  /** Terminal state rebuilt from the revision log only — never a cached object. */
  readonly run: TRun | undefined;
  readonly events: readonly EventRecord[];
  readonly revisions: readonly RunRevision<TRun>[];
  /**
   * True when at least one revision or event was stored lossily, i.e. the
   * rebuilt run cannot be asserted byte-equal to the original object.
   */
  readonly lossy: boolean;
}

export interface IdempotencyClaim {
  readonly scope: RunScope;
  readonly action: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly runId: string;
}

export interface IdempotencyRecord extends IdempotencyClaim {
  readonly at: number;
}

export type IdempotencyOutcome =
  | { readonly status: "claimed"; readonly record: IdempotencyRecord }
  | { readonly status: "replayed"; readonly record: IdempotencyRecord };

/**
 * Whether the run folded out of the log matches the live object byte for byte,
 * after redaction. `lossy` true means the two are *expected* to differ and the
 * mismatch is not a storage bug — see `encode()` on why a store cannot fail
 * closed on an unrepresentable run.
 */
export interface ReplayEquivalence {
  readonly equivalent: boolean;
  readonly lossy: boolean;
  /** Redacted canonical bytes of the in-process object, when one is held. */
  readonly live?: string;
  /** Bytes actually on disk for the latest revision. */
  readonly stored?: string;
}

/** Everything a persistent store adds on top of the runtime's `EventStore`. */
export interface PersistentEventStore<TRun extends PersistableRun = PersistableRun>
  extends EventStore<TRun> {
  /**
   * A view pinned to one scope. Reads and writes never cross out of it, which
   * is what makes two tenants sharing a runId mutually invisible.
   */
  scoped(scope: RunScopeSource): EventStore<TRun> & { readonly scope: RunScope };
  replay(runId: string, scope?: RunScopeSource): ReplayResult<TRun>;
  replayEquivalence(runId: string, scope?: RunScopeSource): ReplayEquivalence;
  revisions(runId: string, scope?: RunScopeSource): readonly RunRevision<TRun>[];
  claimIdempotency(claim: IdempotencyClaim): IdempotencyOutcome;
  lookupIdempotency(
    scope: RunScopeSource,
    action: string,
    idempotencyKey: string,
  ): IdempotencyRecord | undefined;
  close(): void;
}

export class EventStoreError extends Error {}

/** Two different scopes claim the same runId on an unscoped root store. */
export class RunScopeConflictError extends EventStoreError {}

/** Same idempotency tuple, different input fingerprint. */
export class IdempotencyConflictError extends EventStoreError {}

/** A payload or run could not be represented and `strictSerialization` is on. */
export class SerializationError extends EventStoreError {}

/** A sequence read back from storage has a gap or a duplicate. */
export class SequenceIntegrityError extends EventStoreError {}

/** An attempt to mutate or delete an already-written record. */
export class AppendOnlyViolationError extends EventStoreError {}
