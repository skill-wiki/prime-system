import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphEdgeIR, RelationDefIR, SnapshotRef, UnitIR } from "@aoe/ir";
import { solve, type SolveRequest } from "@aoe/constraint-solver";
import { ProjectionPathError, redactUnitFields, requireBundlePath, resolveBundlePath, type RedactionPolicy } from "@aoe/projection-engine";
import { MemoryEventStore, toScope, type PersistableRun, type RunScopeSource } from "@aoe/event-store";
import { finalizeCorpusBundle, type BundleManifestMetadata, type CorpusIndexEntry } from "@aoe/bundle";
import { loadCorpusSnapshot, PrimeBundleError, SUPPORTED_CORPUS_IR_VERSION, CORPUS_INDEX_FILE, CORPUS_MANIFEST_FILE, type PrimeBundleErrorCode } from "@aoe/runtime";
import { runEngineInvariants, type EngineHarness } from "../src/engine-invariants.ts";
import { canonicalJson } from "../src/corpus.ts";

/**
 * §17.3 bound to the three implementations that actually landed. The suite in
 * `src/` stays black-box; the bindings live here, so `@aoe/testkit` does
 * not become a dependent of every engine package.
 *
 * Neutral names throughout: `t-1`, `rel-x`, `label-a`. A binding that had to
 * name a domain type would be evidence against the thing it is verifying.
 */

const snapshot: SnapshotRef = { modelRelease: "m-1", modelDigest: "md-1", corpusRelease: "c-1", corpusDigest: "cd-1" };

function unit(id: string, policyLabels: readonly string[] = []): UnitIR {
  return {
    identity: { id, version: "1.0.0", digest: `d-${id}`, corpus: "c-1" },
    typeRef: "t-1", implements: [], fields: {}, relations: [], citations: [],
    policyLabels, lifecycle: "active", visibility: "public",
    provenance: { source: { loc: { line: 1, column: 1, offset: 0 } } }, projections: {},
  };
}
function relation(name: string, view: Partial<RelationDefIR["semantics"]>): RelationDefIR {
  // `cardinality` / `directional` became required in `RelationDefIR` (W3-3). The
  // invariants under test are semantics-driven, so the probe declares the widest
  // cardinality and the directional default that mirrors the model schema.
  return { name, version: "1.0.0", from: "t-1", to: "t-1", cardinality: "many-to-many", directional: true, semantics: { traversal: "none", selection: "informational", loadOrder: "none", cyclePolicy: "allow", conflictSeverity: "none", ...view } };
}
function edge(id: string, relationRef: string, from: string, to: string): GraphEdgeIR {
  return { id, relationRef, from, to };
}

/**
 * The exclusion is declared by relation semantics (`selection: exclude` +
 * `conflictSeverity: error`), while `u2` carries an enormous preference weight.
 * If weight could outrank a hard constraint, `u2` would come back selected.
 */
const EXCLUSION_REQUEST: SolveRequest = {
  requestId: "r-hard",
  snapshot,
  relations: { "rel-x": relation("rel-x", { selection: "exclude", traversal: "one-hop", conflictSeverity: "error" }) },
  units: [unit("u1"), unit("u2")],
  edges: [edge("e1", "rel-x", "u1", "u2")],
  mandatory: ["u1"],
  preferences: [{ unitId: "u2", weight: 1_000_000_000 }],
};

function selectedIds(request: SolveRequest): readonly string[] {
  const result = solve(request);
  return result.ok ? result.plan.selected.map(c => c.unitId).sort() : [];
}

const constraintSolverHarness: EngineHarness = {
  name: "@aoe/constraint-solver",
  deterministicPlanning: {
    request: { requestId: EXCLUSION_REQUEST.requestId },
    plan: () => { const r = solve(EXCLUSION_REQUEST); return r.ok ? r.plan : { unsat: true }; },
    repetitions: 3,
  },
  hardConstraint: {
    request: { requestId: EXCLUSION_REQUEST.requestId },
    forbiddenUnitIds: ["u2"],
    select: () => selectedIds(EXCLUSION_REQUEST),
  },
};

/**
 * projection-engine enforces access control by replacing labelled field values
 * with a marker before the payload is handed out — the key survives, the content
 * does not — so "restricted ids" bind to the classified *values* a denied
 * principal must never receive.
 */
const REDACTION_POLICY: RedactionPolicy = { rules: [{ label: "label-a", fields: ["restrictedField"] }] };
const CLASSIFIED = "classified-payload";
const LABELLED_UNIT: UnitIR = {
  ...unit("u-secret", ["label-a"]),
  fields: {
    openField: { kind: "string", value: "visible", source: { loc: { line: 1, column: 1, offset: 0 } } },
    restrictedField: { kind: "string", value: CLASSIFIED, source: { loc: { line: 2, column: 1, offset: 0 } } },
  },
};

/** Every string value a caller would actually observe in the delivered payload. */
function observableValues(policy: RedactionPolicy): readonly string[] {
  const fields = redactUnitFields(LABELLED_UNIT, policy).value;
  return Object.values(fields).map(f => (f.kind === "string" ? f.value : "")).sort();
}

const projectionEngineHarness: EngineHarness = {
  name: "@aoe/projection-engine",
  acl: {
    request: { unitId: "u-secret" },
    deniedPrincipal: "principal-without-clearance",
    restrictedUnitIds: [CLASSIFIED],
    // A cleared principal is modelled as an empty policy: nothing is removed.
    select: (_request, principal) => observableValues(principal === "principal-without-clearance" ? REDACTION_POLICY : { rules: [] }),
  },
};

interface Run extends PersistableRun { readonly id: string; readonly context: RunScopeSource; readonly verdict: string }

/** One store, three invariants: scope isolation, idempotency, replay. */
function eventStoreHarness(): EngineHarness {
  const store = new MemoryEventStore<Run>({ now: () => 1_700_000_000_000 });
  let currentSnapshot = 0;
  const seed = (generation: number): void => {
    const context: RunScopeSource = { snapshot: `snap-${generation}`, tenant: "tenant-a", workspace: "ws-a" };
    store.save({ id: `run-${generation}`, context, verdict: "ok" });
    store.append(`run-${generation}`, "started", { generation });
  };
  seed(0);
  const runIdsIn = (generation: number): readonly string[] => {
    const scope = toScope({ snapshot: `snap-${generation}`, tenant: "tenant-a", workspace: "ws-a" });
    return [0, 1, 2].map(g => `run-${g}`).filter(id => store.getIn(scope, id) !== undefined);
  };

  let effects = 0;
  const applied = new Set<string>();

  return {
    name: "@aoe/event-store",
    snapshotIsolation: {
      open: () => currentSnapshot,
      mutate: () => { currentSnapshot += 1; seed(currentSnapshot); },
      read: handle => runIdsIn(handle as number),
    },
    idempotency: {
      input: { target: "u1" },
      idempotencyKey: "key-1",
      invoke: (input, idempotencyKey) => {
        const outcome = store.claimIdempotency({
          scope: { snapshot: "snap-0", tenant: "tenant-a", workspace: "ws-a" },
          action: "act-1",
          idempotencyKey,
          fingerprint: canonicalJson(input),
          runId: "run-idem",
        });
        // Only a fresh claim may perform the effect; a replayed claim must not.
        if (outcome.status === "claimed" && !applied.has(idempotencyKey)) { applied.add(idempotencyKey); effects += 1; }
      },
      sideEffectCount: () => effects,
    },
    replay: {
      input: { target: "u1" },
      run: () => {
        const context: RunScopeSource = { snapshot: "snap-replay", tenant: "tenant-a", workspace: "ws-a" };
        store.save({ id: "run-replay", context, verdict: "ok" });
        store.append("run-replay", "step", { index: 1 });
        store.append("run-replay", "finished", { index: 2 });
        const live = store.replay("run-replay", context);
        return { runId: "run-replay", outcome: { run: live.run, events: live.events.map(e => ({ type: e.type, payload: e.payload })) } };
      },
      replay: runId => {
        const folded = store.replay(runId, { snapshot: "snap-replay", tenant: "tenant-a", workspace: "ws-a" });
        return { outcome: { run: folded.run, events: folded.events.map(e => ({ type: e.type, payload: e.payload })) } };
      },
    },
  };
}

/**
 * §17.3 "Bundle digest 不匹配时 fail closed" — the one invariant with no binding
 * until now. Producer is the real `finalizeCorpusBundle` (packages/bundle) and
 * verifier is the real `loadCorpusSnapshot` (packages/runtime); neither is
 * modified here. `kind`/`domain` carry neutral values because a fixture that had
 * to name a domain type would contradict what the suite exists to prove.
 */
const BUNDLE_ENTRY: CorpusIndexEntry = {
  id: "u-1", kind: "t-1", version: "1.0.0", description: "d-1", domain: "dom-1",
  tags: ["tag-a"], tokens: { summary: 1, core: 2, full: 3 },
};
const BUNDLE_MANIFEST: BundleManifestMetadata = {
  protocolVersion: "2.0.0", irVersion: SUPPORTED_CORPUS_IR_VERSION,
  compilerVersion: "2.1.0", emitterVersion: "4",
  corpus: "c-1", release: "r-1", sourceRevision: "git:0000000",
  models: { "m-1": "1.0.0" },
  schemaDigest: `sha256:${"0".repeat(64)}`,
  createdAt: "2026-08-28T00:00:00Z",
};

/**
 * A real bundle on disk, with one artifact so contentDigest covers real bytes.
 *
 * `realpathSync` is load-bearing, not tidiness: on macOS `tmpdir()` is
 * `/var/folders/...` and `/var` is a symlink, which `finalizeCorpusBundle`
 * correctly rejects as a symlinked ancestor. Resolving it keeps this fixture
 * testing digests rather than re-testing the path guard.
 */
function buildBundle(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "prime-digest-"));
  mkdirSync(join(root, BUNDLE_ENTRY.id), { recursive: true });
  writeFileSync(join(root, BUNDLE_ENTRY.id, "summary.md"), "artifact bytes\n", "utf8");
  finalizeCorpusBundle({ outDir: root, entries: [BUNDLE_ENTRY], manifest: BUNDLE_MANIFEST });
  return root;
}

/**
 * Flip one hex nibble and keep `sha256:<64 hex>` intact. Decisive: a
 * shape-invalid digest would be rejected by the manifest *shape* check, which
 * would let a verifier that never compares digests still pass this test.
 */
function flipDigest(digest: string): string {
  const hex = digest.slice("sha256:".length);
  return `sha256:${hex[0] === "0" ? "1" : "0"}${hex.slice(1)}`;
}
function rewriteManifest(root: string, edit: (m: Record<string, unknown>) => void): void {
  const path = join(root, CORPUS_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
/** Production posture: `finalizeCorpusBundle` itself loads with requireManifest. */
const loadBundle = (descriptor: Readonly<Record<string, unknown>>): unknown =>
  loadCorpusSnapshot(String(descriptor.root), { requireManifest: true });

function bundleIntegrityHarness(roots: string[]): EngineHarness {
  const valid = buildBundle();
  const tampered = buildBundle();
  roots.push(valid, tampered);
  rewriteManifest(tampered, m => { m.contentDigest = flipDigest(String(m.contentDigest)); });
  return {
    name: "@aoe/bundle + @aoe/runtime",
    bundleIntegrity: { validDescriptor: { root: valid }, tamperedDescriptor: { root: tampered }, load: loadBundle },
  };
}

test("constraint-solver: a hard constraint is not outweighed by a billion-fold preference", async () => {
  const r = await runEngineInvariants(constraintSolverHarness);
  expect(r.checks.find(c => c.id === "EI-HARD-CONSTRAINT")?.status).toBe("pass");
  expect(r.checks.find(c => c.id === "EI-DETERMINISTIC-PLANNING")?.status).toBe("pass");
  // The binding must be non-vacuous: the mandatory unit really is selected.
  expect(selectedIds(EXCLUSION_REQUEST)).toEqual(["u1"]);
  // Capabilities this package does not implement stay skip, never pass.
  expect(r.counts).toEqual({ pass: 2, fail: 0, skip: 5 });
});

test("projection-engine: a denied principal never receives the restricted content", async () => {
  const r = await runEngineInvariants(projectionEngineHarness);
  expect(r.checks.find(c => c.id === "EI-ACL")?.status).toBe("pass");
  expect(r.counts).toEqual({ pass: 1, fail: 0, skip: 6 });
  // Non-vacuous: a cleared principal does receive it, so the check is real.
  expect(observableValues({ rules: [] })).toContain(CLASSIFIED);
  expect(observableValues(REDACTION_POLICY)).not.toContain(CLASSIFIED);
});

test("projection-engine: bundle paths fail closed on traversal, absolute paths, NUL bytes and symlink escape", () => {
  const root = mkdtempSync(join(tmpdir(), "prime-bundle-"));
  const outside = mkdtempSync(join(tmpdir(), "prime-outside-"));
  try {
    mkdirSync(join(root, "unit"), { recursive: true });
    writeFileSync(join(root, "unit", "summary.md"), "ok", "utf8");
    writeFileSync(join(outside, "secret.md"), "secret", "utf8");
    symlinkSync(join(outside, "secret.md"), join(root, "unit", "link.md"));

    expect(resolveBundlePath(root, "unit/summary.md").ok).toBe(true);
    expect(requireBundlePath(root, "unit/summary.md")).toContain("summary.md");

    for (const [path, code] of [
      ["../../etc/passwd", "PATH_TRAVERSAL"],
      ["/etc/passwd", "PATH_ABSOLUTE"],
      ["ok.md\0../../etc/passwd", "PATH_NUL_BYTE"],
      ["", "PATH_EMPTY"],
      ["unit/missing.md", "PATH_NOT_FOUND"],
      ["unit", "PATH_NOT_A_FILE"],
      // The decisive one: every string segment looks innocent.
      ["unit/link.md", "PATH_ESCAPES_ROOT"],
    ] as const) {
      const result = resolveBundlePath(root, path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(code);
      expect(() => requireBundlePath(root, path)).toThrow(ProjectionPathError);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("event-store: scope isolation, idempotency and replay all hold", async () => {
  const r = await runEngineInvariants(eventStoreHarness());
  for (const id of ["EI-SNAPSHOT-ISOLATION", "EI-IDEMPOTENCY", "EI-EVENT-REPLAY"] as const)
    expect(r.checks.find(c => c.id === id)?.status).toBe("pass");
  expect(r.counts).toEqual({ pass: 3, fail: 0, skip: 4 });
  expect(r.errorCount).toBe(0);
  expect(r.warningCount).toBe(0);
});

test("event-store: reusing an idempotency key with a different input fails closed", () => {
  const store = new MemoryEventStore({ now: () => 1 });
  const claim = { scope: { snapshot: "s", tenant: "t", workspace: "w" }, action: "a", idempotencyKey: "k", fingerprint: "fp-1", runId: "r" };
  expect(store.claimIdempotency(claim).status).toBe("claimed");
  expect(store.claimIdempotency(claim).status).toBe("replayed");
  expect(() => store.claimIdempotency({ ...claim, fingerprint: "fp-2" })).toThrow();
});

test("bundle+runtime: a tampered manifest digest fails closed, so EI-BUNDLE-DIGEST is no longer skip", async () => {
  const roots: string[] = [];
  try {
    const r = await runEngineInvariants(bundleIntegrityHarness(roots));
    expect(r.checks.find(c => c.id === "EI-BUNDLE-DIGEST")?.status).toBe("pass");
    expect(r.counts).toEqual({ pass: 1, fail: 0, skip: 6 });
    expect(r.errorCount).toBe(0);
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

test("bundle+runtime: each tamper vector fails closed with the digest code, not a shape error", () => {
  const roots: string[] = [];
  try {
    // Non-vacuous first: the untouched bundle the producer wrote really loads.
    const pristine = buildBundle(); roots.push(pristine);
    expect(loadBundle({ root: pristine })).toBeDefined();

    // Four independent vectors: two edit the claim, two edit the bytes. A
    // verifier that only re-read the manifest would pass the first pair and
    // fail the second, so both directions have to be exercised.
    const vectors: ReadonlyArray<readonly [PrimeBundleErrorCode, (root: string) => void]> = [
      ["CONTENT_DIGEST_MISMATCH", root => rewriteManifest(root, m => { m.contentDigest = flipDigest(String(m.contentDigest)); })],
      ["INDEX_DIGEST_MISMATCH", root => rewriteManifest(root, m => { m.indexDigest = flipDigest(String(m.indexDigest)); })],
      ["CONTENT_DIGEST_MISMATCH", root => writeFileSync(join(root, BUNDLE_ENTRY.id, "summary.md"), "swapped payload\n", "utf8")],
      ["INDEX_DIGEST_MISMATCH", root => writeFileSync(join(root, CORPUS_INDEX_FILE), readFileSync(join(root, CORPUS_INDEX_FILE), "utf8") + "<!-- -->", "utf8")],
    ];
    for (const [code, tamper] of vectors) {
      const root = buildBundle(); roots.push(root);
      tamper(root);
      let thrown: unknown;
      try { loadBundle({ root }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(PrimeBundleError);
      expect((thrown as PrimeBundleError).code).toBe(code);
    }
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

test("bundle+runtime: removing the manifest only fails closed when the caller requires one", () => {
  const root = buildBundle();
  try {
    rmSync(join(root, CORPUS_MANIFEST_FILE), { force: true });
    // With requireManifest the removal is an error…
    expect(() => loadBundle({ root })).toThrow(PrimeBundleError);
    // …but the default path accepts it and downgrades to a legacy snapshot.
    // Recorded rather than asserted-away: an attacker who can edit the digest
    // can also delete the file, so any caller that omits the flag is verifying
    // nothing. The diagnostic is the only thing standing between them.
    const downgraded = loadCorpusSnapshot(root);
    expect(downgraded.manifest).toBeUndefined();
    expect(downgraded.diagnostics.map(d => d.code)).toContain("MANIFEST_MISSING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all seven §17.3 invariants now have a real binding, and no binding is faked", async () => {
  const roots: string[] = [];
  try {
    const reports = await Promise.all([
      runEngineInvariants(constraintSolverHarness),
      runEngineInvariants(projectionEngineHarness),
      runEngineInvariants(eventStoreHarness()),
      runEngineInvariants(bundleIntegrityHarness(roots)),
    ]);
    const covered = new Set(reports.flatMap(r => r.checks.filter(c => c.status === "pass").map(c => c.id)));
    expect([...covered].sort()).toEqual([
      "EI-ACL", "EI-BUNDLE-DIGEST", "EI-DETERMINISTIC-PLANNING", "EI-EVENT-REPLAY",
      "EI-HARD-CONSTRAINT", "EI-IDEMPOTENCY", "EI-SNAPSHOT-ISOLATION",
    ]);
    // Still no single package covers all seven: coverage is a union of four
    // harnesses, and every gap in each one is a skip rather than a pass (§17.5).
    for (const r of reports) expect(r.counts.fail).toBe(0);
    expect(reports.map(r => r.counts.skip).sort()).toEqual([4, 5, 6, 6]);
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});
