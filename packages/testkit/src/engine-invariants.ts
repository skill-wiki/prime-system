import { check, finding, report, skipped, type CheckOutcome, type Finding, type SuiteReport } from "./diagnostics.ts";
import { canonicalJson } from "./corpus.ts";

/**
 * §17.3 Engine Invariants as a black box.
 *
 * Every capability is injected. The suite imports no engine package, so the
 * same suite can be pointed at an embedded engine, a remote one, or a fake — and
 * a capability that is absent is reported as `skip`, never as `pass` (§17.5).
 */

export type Awaitable<T> = T | Promise<T>;

/** Opaque handle: the suite must not be able to inspect snapshot internals. */
export type SnapshotHandle = unknown;

export interface SnapshotIsolationCapability {
  /** Opens a read handle pinned to the current snapshot. */
  readonly open: () => Awaitable<SnapshotHandle>;
  /** Must change what a *fresh* read would return. */
  readonly mutate: () => Awaitable<void>;
  /** Reads unit ids through a previously opened handle. */
  readonly read: (handle: SnapshotHandle) => Awaitable<readonly string[]>;
}

export interface DeterministicPlanningCapability {
  readonly request: Readonly<Record<string, unknown>>;
  readonly plan: (request: Readonly<Record<string, unknown>>) => Awaitable<unknown>;
  /** How many times to re-plan. Default 3. */
  readonly repetitions?: number;
}

export interface HardConstraintCapability {
  readonly request: Readonly<Record<string, unknown>>;
  /** Units the request's hard constraint forbids, however high their score. */
  readonly forbiddenUnitIds: readonly string[];
  readonly select: (request: Readonly<Record<string, unknown>>) => Awaitable<readonly string[]>;
}

export interface AclCapability {
  readonly request: Readonly<Record<string, unknown>>;
  readonly deniedPrincipal: string;
  readonly restrictedUnitIds: readonly string[];
  readonly select: (request: Readonly<Record<string, unknown>>, principal: string) => Awaitable<readonly string[]>;
}

export interface IdempotencyCapability {
  readonly input: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly invoke: (input: Readonly<Record<string, unknown>>, idempotencyKey: string) => Awaitable<unknown>;
  /** Observable count of real side effects performed so far. */
  readonly sideEffectCount: () => Awaitable<number>;
}

export interface ReplayCapability {
  readonly input: Readonly<Record<string, unknown>>;
  readonly run: (input: Readonly<Record<string, unknown>>) => Awaitable<{ readonly runId: string; readonly outcome: unknown }>;
  readonly replay: (runId: string) => Awaitable<{ readonly outcome: unknown }>;
}

export interface BundleIntegrityCapability {
  readonly validDescriptor: Readonly<Record<string, unknown>>;
  /** Same bundle, wrong digest. Loading it must fail. */
  readonly tamperedDescriptor: Readonly<Record<string, unknown>>;
  readonly load: (descriptor: Readonly<Record<string, unknown>>) => Awaitable<unknown>;
}

export interface EngineHarness {
  readonly name: string;
  readonly snapshotIsolation?: SnapshotIsolationCapability;
  readonly deterministicPlanning?: DeterministicPlanningCapability;
  readonly hardConstraint?: HardConstraintCapability;
  readonly acl?: AclCapability;
  readonly idempotency?: IdempotencyCapability;
  readonly replay?: ReplayCapability;
  readonly bundleIntegrity?: BundleIntegrityCapability;
}

const TITLES = {
  "EI-SNAPSHOT-ISOLATION": "A pinned snapshot does not observe later mutations",
  "EI-DETERMINISTIC-PLANNING": "Identical requests produce byte-identical plans",
  "EI-HARD-CONSTRAINT": "A hard constraint cannot be outweighed by score",
  "EI-ACL": "Access control is applied before results are returned",
  "EI-IDEMPOTENCY": "An idempotent action performs its side effect once",
  "EI-EVENT-REPLAY": "Replaying a run reproduces its outcome",
  "EI-BUNDLE-DIGEST": "A digest mismatch fails closed",
} as const;

type InvariantId = keyof typeof TITLES;

async function guard(id: InvariantId, body: () => Promise<readonly Finding[]>): Promise<CheckOutcome> {
  try { return check(id, TITLES[id], await body()); }
  catch (error) {
    return check(id, TITLES[id], [finding("HARNESS_THREW", error instanceof Error ? error.message : String(error), "error", { subject: id })]);
  }
}

export async function runEngineInvariants(harness: EngineHarness): Promise<SuiteReport> {
  const checks: CheckOutcome[] = [];

  const snapshot = harness.snapshotIsolation;
  checks.push(snapshot === undefined
    ? skipped("EI-SNAPSHOT-ISOLATION", TITLES["EI-SNAPSHOT-ISOLATION"], "harness exposes no snapshotIsolation capability")
    : await guard("EI-SNAPSHOT-ISOLATION", async () => {
      const handle = await snapshot.open();
      const before = await snapshot.read(handle);
      await snapshot.mutate();
      const after = await snapshot.read(handle);
      if (canonicalJson(before) !== canonicalJson(after))
        return [finding("SNAPSHOT_NOT_ISOLATED", `pinned read changed after mutation: [${before.join(", ")}] -> [${after.join(", ")}]`, "error")];
      // A mutation that changes nothing would make the check vacuous.
      const fresh = await snapshot.read(await snapshot.open());
      return canonicalJson(fresh) === canonicalJson(before)
        ? [finding("MUTATION_NOT_OBSERVABLE", "mutate() did not change what a fresh snapshot returns; isolation was not actually exercised", "warning")]
        : [];
    }));

  const planning = harness.deterministicPlanning;
  checks.push(planning === undefined
    ? skipped("EI-DETERMINISTIC-PLANNING", TITLES["EI-DETERMINISTIC-PLANNING"], "harness exposes no deterministicPlanning capability")
    : await guard("EI-DETERMINISTIC-PLANNING", async () => {
      const first = canonicalJson(await planning.plan(planning.request));
      const findings: Finding[] = [];
      for (let i = 1; i < (planning.repetitions ?? 3); i += 1) {
        const next = canonicalJson(await planning.plan(planning.request));
        if (next !== first) findings.push(finding("PLAN_NOT_DETERMINISTIC", `run ${i + 1} differs from run 1`, "error"));
      }
      return findings;
    }));

  const constraint = harness.hardConstraint;
  checks.push(constraint === undefined
    ? skipped("EI-HARD-CONSTRAINT", TITLES["EI-HARD-CONSTRAINT"], "harness exposes no hardConstraint capability")
    : await guard("EI-HARD-CONSTRAINT", async () => {
      const selected = new Set(await constraint.select(constraint.request));
      return constraint.forbiddenUnitIds.filter(id => selected.has(id))
        .map(id => finding("HARD_CONSTRAINT_OVERRIDDEN", "a unit forbidden by a hard constraint was selected", "error", { subject: id }));
    }));

  const acl = harness.acl;
  checks.push(acl === undefined
    ? skipped("EI-ACL", TITLES["EI-ACL"], "harness exposes no acl capability")
    : await guard("EI-ACL", async () => {
      const visible = new Set(await acl.select(acl.request, acl.deniedPrincipal));
      return acl.restrictedUnitIds.filter(id => visible.has(id))
        .map(id => finding("ACL_LEAK", `principal ${acl.deniedPrincipal} received a restricted unit`, "error", { subject: id }));
    }));

  const idempotency = harness.idempotency;
  checks.push(idempotency === undefined
    ? skipped("EI-IDEMPOTENCY", TITLES["EI-IDEMPOTENCY"], "harness exposes no idempotency capability")
    : await guard("EI-IDEMPOTENCY", async () => {
      const before = await idempotency.sideEffectCount();
      await idempotency.invoke(idempotency.input, idempotency.idempotencyKey);
      const once = await idempotency.sideEffectCount();
      await idempotency.invoke(idempotency.input, idempotency.idempotencyKey);
      const twice = await idempotency.sideEffectCount();
      const findings: Finding[] = [];
      if (once === before) findings.push(finding("ACTION_HAD_NO_EFFECT", "first invocation performed no side effect; the check would be vacuous", "warning"));
      if (twice !== once) findings.push(finding("SIDE_EFFECT_DUPLICATED", `replayed key produced additional side effects (${once} -> ${twice})`, "error"));
      return findings;
    }));

  const replay = harness.replay;
  checks.push(replay === undefined
    ? skipped("EI-EVENT-REPLAY", TITLES["EI-EVENT-REPLAY"], "harness exposes no replay capability")
    : await guard("EI-EVENT-REPLAY", async () => {
      const original = await replay.run(replay.input);
      const replayed = await replay.replay(original.runId);
      return canonicalJson(original.outcome) === canonicalJson(replayed.outcome) ? []
        : [finding("REPLAY_DIVERGED", "replayed outcome differs from the recorded run", "error", { subject: original.runId })];
    }));

  const bundle = harness.bundleIntegrity;
  checks.push(bundle === undefined
    ? skipped("EI-BUNDLE-DIGEST", TITLES["EI-BUNDLE-DIGEST"], "harness exposes no bundleIntegrity capability")
    : await guard("EI-BUNDLE-DIGEST", async () => {
      const findings: Finding[] = [];
      try { await bundle.load(bundle.validDescriptor); }
      catch (error) { findings.push(finding("VALID_BUNDLE_REJECTED", error instanceof Error ? error.message : String(error), "error")); }
      let accepted = false;
      try { await bundle.load(bundle.tamperedDescriptor); accepted = true; }
      catch { /* rejecting a tampered bundle is the expected behaviour */ }
      if (accepted) findings.push(finding("DIGEST_MISMATCH_ACCEPTED", "a bundle whose digest does not match was loaded instead of failing closed", "error"));
      return findings;
    }));

  return report("engine-invariants", harness.name, checks);
}
