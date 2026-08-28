export {
  AppendOnlyViolationError,
  EventStoreError,
  IdempotencyConflictError,
  RunScopeConflictError,
  SequenceIntegrityError,
  SerializationError,
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
} from "./contracts.ts";

export {
  BaseEventStore,
  type EventStoreBackend,
  type EventStoreOptions,
  type StoredEventRow,
  type StoredRevisionRow,
} from "./base.ts";

export { idempotencyKeyOf, sameScope, scopeKey, toScope } from "./scope.ts";
export { decode, encode, type Encoded, type UnstorableMarker } from "./serialize.ts";
export {
  REDACTED,
  composeRedactors,
  fieldRedactor,
  identityRedactor,
  type EventRedactionContext,
  type RedactionContext,
  type Redactor,
} from "./redaction.ts";

export { MemoryEventStore } from "./memory.ts";
export { JsonlEventStore, type JsonlEventStoreOptions } from "./jsonl.ts";
export { SqliteEventStore, type SqliteEventStoreOptions } from "./sqlite.ts";
