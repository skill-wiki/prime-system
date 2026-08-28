/**
 * The **first production construction point** of `ActionRuntime` in this repo.
 *
 * Before this module, `RuntimeOptions.events`, `RuntimeOptions.idempotency` and
 * `RuntimeOptions.snapshot` all existed and were all only ever supplied by tests.
 * The wiring gate's verdict on that state was "a passing test suite is not a
 * production path", so what follows is deliberately assembled from the durable
 * implementations, not the in-memory ones:
 *
 *  - the event store is `SqliteEventStore`, so a run survives the process;
 *  - the *same* store is passed as the idempotency ledger, so a replayed key is
 *    still detected after a restart (the default ledger is a process-local Map);
 *  - the runtime is **pinned** to a real `SnapshotRef` built from the audited
 *    bundle's own manifest, and every request carries the same ref, so the §8.4
 *    digest comparison actually executes instead of short-circuiting.
 *
 * `strictSerialization` is deliberately left off: action-runtime `save()`s a run
 * before it fingerprints the input (its own dry-run test feeds a BigInt), so a
 * store that refused unrepresentable values would fail a path the runtime relies
 * on. Lossy revisions are reported by `replay()`, not hidden.
 */

import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  ActionProviderRegistry,
  ActionRuntime,
  type ActionProvider,
  type ActionRun,
  type AuthorizationDecision,
  type PrincipalAuthorizer,
  type RequestContext,
} from '@skill-wiki/action-runtime';
import { SqliteEventStore, type PersistentEventStore } from '@skill-wiki/event-store';
import type { SnapshotRef } from '@skill-wiki/ir';
import { loadModelOrThrow, type ActionDefinition, type LoadedModel } from '@skill-wiki/model-schema';
import { loadAuditedCorpus, toSnapshotRef, type AuditedCorpus } from './corpus';
import { AuditActionProvider } from './provider';

/** Any run of an audit is filed under this scope's third element; see §12.4. */
export interface AuditScope {
  readonly tenant: string;
  readonly workspace: string;
  readonly snapshotId: string;
}

export interface AssembleOptions {
  readonly modelRoot: string;
  readonly corpusRoot: string;
  readonly action: string;
  /** §12.4 scope this runtime files its runs under. Must match the request context. */
  readonly tenant?: string;
  readonly workspace?: string;
  /** Directory holding the run log. Defaults to a sibling of the bundle; see `defaultStateDir`. */
  readonly stateDir?: string;
  readonly attestation?: Readonly<Record<string, unknown>>;
}

export interface AssembledAudit {
  readonly model: LoadedModel;
  readonly corpus: AuditedCorpus;
  readonly definition: ActionDefinition;
  readonly runtime: ActionRuntime;
  readonly store: PersistentEventStore<ActionRun>;
  readonly provider: AuditActionProvider;
  readonly snapshot: SnapshotRef;
  readonly scope: RunScope;
  readonly storePath: string;
  close(): void;
}

/** The §12.4 tuple a run is filed under. */
export interface RunScope {
  readonly tenant: string;
  readonly workspace: string;
  readonly snapshot: string;
}

export class AuditAssemblyError extends Error {}

/**
 * Where the run log goes when the caller does not say.
 *
 * A **sibling** of the audited bundle, never a directory inside it. Measured, not
 * theorised: the first version defaulted to `<corpus>/.prime-runs`, and the next
 * `loadCorpusSnapshot` of that bundle failed `CONTENT_DIGEST_MISMATCH` — the
 * manifest's contentDigest is computed over the bundle directory, so writing the
 * audit's own log inside it invalidates the digest the next audit verifies.
 */
function defaultStateDir(corpusRoot: string): string {
  return join(dirname(corpusRoot), `${basename(corpusRoot)}.prime-runs`);
}

/**
 * Principal authorization as a real decision rather than an allow-all stub.
 *
 * It answers exactly the question §9.6 puts before the capability check: is this
 * principal permitted to attempt this action at all? The rule is that the
 * principal must be named and must already hold every capability the *model*
 * declares for the action. Capability enforcement still happens inside the
 * runtime afterwards — this is not a replacement for it; deciding here means the
 * denial is recorded as an authorization decision with its evidence, instead of
 * surfacing later as an unattributed capability failure.
 */
export class DeclaredCapabilityAuthorizer implements PrincipalAuthorizer {
  authorize(action: ActionDefinition, _input: unknown, context: RequestContext): Promise<AuthorizationDecision> {
    const missing = action.capabilities.filter((capability) => !context.allowedCapabilities.includes(capability));
    const evidence = [
      { kind: 'principal', value: context.principal },
      { kind: 'roles', value: [...context.roles].sort().join(',') },
      { kind: 'required-capabilities', value: [...action.capabilities].sort().join(',') },
      { kind: 'granted-capabilities', value: [...context.allowedCapabilities].sort().join(',') },
    ];
    if (missing.length > 0) {
      return Promise.resolve({
        allowed: false,
        reason: `Principal ${context.principal} lacks capability: ${missing.sort().join(', ')}`,
        evidence,
      });
    }
    return Promise.resolve({
      allowed: true,
      reason: `Principal ${context.principal} holds every capability ${action.name} declares`,
      evidence,
    });
  }
}

/**
 * Refuse anything that is not the read-only audit case.
 *
 * Plan §16 Phase 4 is explicit that HTTP/process/agent executors come *later*, so
 * the failure direction matters: an action declaring an external write must be
 * refused here rather than executed by a CLI that has no compensation, approval
 * routing or effect plan review. `read` is accepted alongside `none` because
 * reading the corpus is what an audit does; `write` is not.
 */
function requireSideEffectFree(definition: ActionDefinition): void {
  if (definition.sideEffects === 'write') {
    throw new AuditAssemblyError(
      `Action ${definition.name} declares sideEffects: ${definition.sideEffects}. This command runs side-effect-free audits only.`,
    );
  }
}

export function assembleAudit(options: AssembleOptions): AssembledAudit {
  const model = loadModelOrThrow(options.modelRoot);
  const definition = model.definitions.find(
    (d): d is ActionDefinition => d.kind === 'action' && d.name === options.action,
  );
  if (!definition) {
    const available = model.definitions
      .filter((d): d is ActionDefinition => d.kind === 'action')
      .map((d) => d.name)
      .sort();
    throw new AuditAssemblyError(
      available.length === 0
        ? `Model ${model.manifest.name} declares no actions, so there is nothing to audit with.`
        : `Model ${model.manifest.name} declares no action ${options.action}. Available: ${available.join(', ')}`,
    );
  }
  requireSideEffectFree(definition);
  if (!definition.provider) {
    throw new AuditAssemblyError(`Action ${definition.name} declares no provider.`);
  }

  const corpus = loadAuditedCorpus(options.corpusRoot);
  const snapshot = toSnapshotRef(corpus.bundleSnapshot, model.manifest);
  const provider: ActionProvider & AuditActionProvider = new AuditActionProvider(definition, {
    model,
    corpus,
    ...(options.attestation ? { attestation: options.attestation } : {}),
  });
  const actions = new ActionProviderRegistry().register(definition.provider, provider);
  const storePath = join(options.stateDir ?? defaultStateDir(options.corpusRoot), 'runs.sqlite');
  // `bun:sqlite` creates the file but not its directory, and the run log lives in
  // a directory that does not exist before the first run.
  mkdirSync(dirname(storePath), { recursive: true });
  const scope: RunScope = {
    tenant: options.tenant ?? DEFAULT_SCOPE_ELEMENT,
    workspace: options.workspace ?? DEFAULT_SCOPE_ELEMENT,
    snapshot: snapshotIdOf(snapshot),
  };
  /**
   * `defaultScope` is not cosmetic. The root store learns `runId -> scope` from
   * the `save()` that wrote a run, so a *new process* that hits a persisted
   * idempotency record and then asks the root store for that runId reads the
   * empty default scope and finds nothing — surfacing as "Idempotency record has
   * no run in this event store". Anchoring the store to the scope this runtime
   * serves is what makes a cross-process idempotency hit resolve. Observed as a
   * failing test before this line existed.
   */
  const store: PersistentEventStore<ActionRun> = new SqliteEventStore<ActionRun>({ path: storePath, defaultScope: scope });
  const runtime = new ActionRuntime(model, { actions, events: store, idempotency: store, authorizer: new DeclaredCapabilityAuthorizer(), snapshot });
  return {
    model,
    corpus,
    definition,
    runtime,
    store,
    provider,
    snapshot,
    scope,
    storePath,
    close: () => store.close(),
  };
}

/**
 * The scope id a run is filed under. It is the corpus digest, not a path: §12.4
 * files a run under (tenant, workspace, snapshot) and a machine-local directory
 * name would make the same audit non-portable between two checkouts.
 */
export function snapshotIdOf(snapshot: SnapshotRef): string {
  return snapshot.corpusDigest;
}

export const DEFAULT_SCOPE_ELEMENT = 'default';

export interface OpenRunLogOptions {
  readonly modelRoot: string;
  readonly corpusRoot: string;
  readonly tenant: string;
  readonly workspace: string;
  readonly stateDir?: string;
}

export interface OpenedRunLog {
  readonly store: PersistentEventStore<ActionRun>;
  readonly scope: RunScope;
  readonly snapshot: SnapshotRef;
  readonly storePath: string;
  close(): void;
}

/**
 * Open an existing run log for reading, without building a runtime.
 *
 * Inspecting a past run in a *fresh process* is exactly where a flat runId is not
 * enough: the root store learns `runId -> scope` from the `save()` that wrote it,
 * so in a new process it has no such memory and would read the default scope. The
 * scope therefore has to be re-derived from the same two artifacts the run was
 * filed under, which is why this takes a model and a corpus rather than only a
 * runId. The alternative — letting a runId alone address a run — is the
 * multi-tenant hole §12.4 forbids.
 */
export function openRunLog(options: OpenRunLogOptions): OpenedRunLog {
  const model = loadModelOrThrow(options.modelRoot);
  const corpus = loadAuditedCorpus(options.corpusRoot);
  const snapshot = toSnapshotRef(corpus.bundleSnapshot, model.manifest);
  const scope: RunScope = { tenant: options.tenant, workspace: options.workspace, snapshot: snapshotIdOf(snapshot) };
  const storePath = join(options.stateDir ?? defaultStateDir(options.corpusRoot), 'runs.sqlite');
  mkdirSync(dirname(storePath), { recursive: true });
  const store: PersistentEventStore<ActionRun> = new SqliteEventStore<ActionRun>({ path: storePath, defaultScope: scope });
  return { store, scope, snapshot, storePath, close: () => store.close() };
}

/** The request context an audit run executes under. */
export function auditContext(input: {
  readonly principal: string;
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly trace: string;
  readonly snapshot: SnapshotRef;
  readonly tenant: string;
  readonly workspace: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}): RequestContext {
  return {
    principal: input.principal,
    roles: [...input.roles],
    allowedCapabilities: [...input.capabilities],
    budget: {
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    },
    snapshot: snapshotIdOf(input.snapshot),
    trace: input.trace,
    tenant: input.tenant,
    workspace: input.workspace,
    // Supplied on every request so the runtime's pinned-snapshot comparison is a
    // real comparison. Omitting it would make the runtime fail closed, which is
    // correct behaviour but would mean the digest check never actually ran.
    snapshotRef: input.snapshot,
  };
}
