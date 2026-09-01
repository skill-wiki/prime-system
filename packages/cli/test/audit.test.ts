/**
 * End-to-end evidence for the plan §16 Phase 4 audit vertical, and the first test
 * anywhere in this repo that drives `ActionRuntime` + `SqliteEventStore` +
 * `finalizeCorpusBundle` through one production construction point.
 *
 * The temp root deliberately lives under this package rather than `os.tmpdir()`:
 * on macOS `/var/folders/...` resolves through a symlinked `/var`, and
 * `finalizeCorpusBundle` refuses a symlinked ancestor (correctly — that is how a
 * bundle write escapes its root).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildGlobalIndexXml, type AtomMeta } from "@aoe/compiler";
import { finalizeCorpusBundle } from "@aoe/bundle";
import { SqliteEventStore } from "@aoe/event-store";
import type { ActionRun } from "@aoe/action-runtime";
import { loadModelOrThrow, type ActionDefinition } from "@aoe/model-schema";
import { assembleAudit, auditContext, openRunLog, snapshotIdOf, AuditAssemblyError } from "../src/audit/assemble";
import { runAudit, selectRules } from "../src/audit/checks";
import { loadAuditedCorpus, toSnapshotRef } from "../src/audit/corpus";
import { shapeOutput } from "../src/audit/provider";
import { auditReportEntries, writeAuditReport } from "../src/audit/report";

const MODEL_ROOT = resolve(import.meta.dir, "fixtures/audit-model");
const TEMP_ROOT = resolve(import.meta.dir, `.tmp-audit-${process.pid}`);

interface UnitSpec {
  readonly id: string;
  readonly kind: string;
  readonly relations: readonly { readonly type: string; readonly target: string }[];
}

/**
 * Write a compiled atom-directory bundle, then seal it with the real
 * `finalizeCorpusBundle`. Sealing after the atom dirs exist is required: the
 * manifest's contentDigest is computed over the directory, so a bundle sealed
 * first would fail its own verification on load.
 */
function makeCorpus(name: string, units: readonly UnitSpec[]): string {
  const root = join(TEMP_ROOT, name);
  const metas: AtomMeta[] = [];
  for (const unit of units) {
    const dir = join(root, unit.id);
    mkdirSync(join(dir, "chunks"), { recursive: true });
    for (const level of ["summary", "core", "full"]) {
      writeFileSync(join(dir, "chunks", `${level}.md`), `# ${unit.id} ${level}\n`, "utf8");
    }
    const relations = unit.relations.map(r => `  - { type: ${r.type}, target: "${r.target}" }`).join("\n");
    writeFileSync(join(dir, "atom.yaml"), [
      `id: "${unit.id}"`,
      `kind: ${unit.kind}`,
      `version: "1.0.0"`,
      `description: "${unit.id} under audit"`,
      `domain: fixture`,
      `content_hash: "sha256:${"0".repeat(64)}"`,
      `tokens:`, `  summary: 4`, `  core: 8`, `  full: 12`,
      `projection:`, `  summary: "chunks/summary.md"`, `  core: "chunks/core.md"`, `  full: "chunks/full.md"`,
      `relations:`,
      relations.length > 0 ? relations : "  []",
      "",
    ].join("\n"), "utf8");
    metas.push({
      id: unit.id, kind: unit.kind, version: "1.0.0", description: `${unit.id} under audit`,
      domain: "fixture", tags: [], tokens: { summary: 4, core: 8, full: 12 }, quality: "0",
    } as unknown as AtomMeta);
  }
  writeFileSync(join(root, "_index.xml"), buildGlobalIndexXml(metas), "utf8");
  finalizeCorpusBundle({
    outDir: root,
    entries: metas.map(meta => ({
      id: meta.id, kind: meta.kind, version: meta.version, description: meta.description,
      domain: "fixture", tags: [], tokens: { summary: 4, core: 8, full: 12 },
    })),
    manifest: {
      protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "4",
      corpus: `fixture/${name}`, release: `${name}.1`, sourceRevision: "git:test",
      models: { "audit-fixture": "1.0.0" }, schemaDigest: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-08-28T00:00:00Z",
    },
  });
  return root;
}

/** Two Widgets, one dangling `needs` target, one dangling `mentions` target. */
const CORPUS = [
  { id: "@fx/widget-one", kind: "Widget", relations: [{ type: "needs", target: "@fx/widget-two" }, { type: "mentions", target: "@fx/absent-gadget" }] },
  { id: "@fx/widget-two", kind: "Widget", relations: [{ type: "needs", target: "@fx/absent-widget" }] },
  { id: "@fx/stray", kind: "Sprocket", relations: [] },
] as const satisfies readonly UnitSpec[];

const CONTEXT_BASE = { principal: "auditor-1", roles: ["auditor"], capabilities: ["corpus.read"], tenant: "acme", workspace: "main" };

afterAll(() => { rmSync(TEMP_ROOT, { recursive: true, force: true }); });

describe("audit action", () => {
  test("rule selection is a function of the model, not a list in the engine", () => {
    const model = loadModelOrThrow(MODEL_ROOT);
    const rules = selectRules(model);
    const ids = rules.map(r => r.id);
    // Two relations are declared, so two endpoint rules and two resolvable rules
    // exist; only the one declaring `cyclePolicy: reject` gets a cycle rule.
    expect(ids).toContain("relation-cycle-policy:needs");
    expect(ids).not.toContain("relation-cycle-policy:mentions");
    // The model grades its own referential integrity.
    expect(rules.find(r => r.id === "relation-target-resolvable:needs")?.severity).toBe("error");
    expect(rules.find(r => r.id === "relation-target-resolvable:mentions")?.severity).toBe("none");
    // Three projections declared -> three presence rules, named by the model.
    expect(ids.filter(id => id.startsWith("projection-present:")).sort())
      .toEqual(["projection-present:core", "projection-present:rationale", "projection-present:summary"]);
    // Every rule names the definition that put it there.
    expect(rules.every(r => r.declaredBy.length > 0)).toBe(true);
  });

  test("checks are non-vacuous against a real bundle and severity comes from the model", () => {
    const root = makeCorpus("checks", CORPUS);
    const model = loadModelOrThrow(MODEL_ROOT);
    const corpus = loadAuditedCorpus(root);
    expect(corpus.units.map(u => u.id).sort()).toEqual(["@fx/stray", "@fx/widget-one", "@fx/widget-two"]);
    const findings = runAudit(model, corpus, "AuditCorpus");

    const failing = findings.results.filter(r => !r.skipped && !r.satisfied);
    // An undeclared unit type is a failure the runtime's own input validation
    // could never have caught: it validates the action's input, not the corpus.
    expect(failing.map(r => r.rule)).toContain("unit-type-declared");
    expect(failing.find(r => r.rule === "unit-type-declared")?.subject).toBe("@fx/stray");
    // Dangling target under `conflictSeverity: error` fails ...
    expect(failing.some(r => r.rule === "relation-target-resolvable:needs")).toBe(true);
    // ... while the same violation under `conflictSeverity: none` is reported and
    // does not count against the audit, because the model said so.
    const tolerated = findings.results.find(r => r.rule === "relation-target-resolvable:mentions" && !r.satisfied);
    expect(tolerated?.severity).toBe("none");
    expect(findings.metrics.failed).toBeGreaterThan(0);
    expect(findings.metrics.score).toBeLessThan(100);

    // §17.5: an undecidable check is skipped WITH a reason, never counted a pass.
    const skipped = findings.results.filter(r => r.skipped);
    expect(skipped.length).toBe(0); // this model constrains both endpoints
    // Every result carries the §9.7 envelope.
    for (const result of findings.results) {
      expect(result.provider.length).toBeGreaterThan(0);
      expect(result.deterministic).toBe(true);
      expect(result.confidence).toBe(1);
      expect(result.modelVersion).toBe("audit-fixture@1.0.0");
      expect(result.evidence.length).toBeGreaterThan(0);
      if (result.skipped) expect(result.skipReason).toBeDefined();
    }
    // Determinism: same snapshot + same corpus -> same digest.
    expect(runAudit(model, loadAuditedCorpus(root), "AuditCorpus").digest).toBe(findings.digest);
  });

  test("an unconstrained endpoint is skipped with a reason rather than passed", () => {
    // `from`/`to` of `'*'` is the compat model's way of declaring "any type", and
    // an endpoint comparison against it is undecidable.
    const root = makeCorpus("wildcard", CORPUS);
    const model = loadModelOrThrow(MODEL_ROOT);
    const wildcarded = {
      ...model,
      definitions: model.definitions.map(d => (d.kind === "relation" && d.name === "needs" ? { ...d, from: "*", to: "*" } : d)),
    };
    const findings = runAudit(wildcarded, loadAuditedCorpus(root), "AuditCorpus");
    const skipped = findings.results.find(r => r.rule === "relation-endpoint-type:needs" && r.skipped);
    expect(skipped).toBeDefined();
    expect(skipped?.satisfied).toBe(false);
    expect(skipped?.skipReason).toContain("unconstrained endpoint");
  });

  test("a full run produces a real plan, a durable log, a replay and a sealed report", async () => {
    const root = makeCorpus("run", CORPUS);
    const assembled = assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "AuditCorpus", tenant: "acme", workspace: "main" });
    const context = auditContext({ ...CONTEXT_BASE, trace: "trace-1", snapshot: assembled.snapshot });

    // The SnapshotRef is built from the bundle's own manifest — the first code in
    // the repo to construct one, so the §8.4 comparison is not a no-op.
    expect(assembled.snapshot.corpusDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(assembled.snapshot.modelRelease).toBe("1.0.0");
    expect(context.snapshot).toBe(snapshotIdOf(assembled.snapshot));

    // Preflight authorizes and plans without reaching the provider.
    const effect = await assembled.runtime.preflight("AuditCorpus", { subject: root }, context);
    expect(effect.authorizationDecision?.allowed).toBe(true);
    expect(assembled.provider.findings).toBeUndefined();

    const run = await assembled.runtime.execute("AuditCorpus", { subject: root }, context, "key-1");
    expect(run.status).toBe("succeeded");
    expect(run.output).toBe(assembled.provider.findings?.metrics.score);

    // The plan is derived, and it is pinned: no UNBOUND diagnostic.
    expect(run.plan.snapshot).toEqual(assembled.snapshot);
    expect(run.plan.diagnostics ?? []).toEqual([]);
    expect(run.plan.nodes.map(n => n.id)).toEqual([
      "validate-input", "gate-authorization", "gate-capability-1", "invoke-action", "validate-output", "emit-audit",
    ]);
    expect(run.plan.edges).toEqual(run.plan.nodes.flatMap(n => n.dependsOn.map(from => ({ from, to: n.id }))));
    expect(run.plan.capabilities).toEqual(["corpus.read"]);
    expect(run.plan.approvals).toEqual([]);

    // Authorization is a decision with evidence, not an allow-all stub.
    expect(run.authorizationDecision?.reason).toContain("holds every capability");
    expect(run.evidence.map(e => e.kind)).toContain("granted-capabilities");

    const events = assembled.runtime.events(run.id);
    expect(events.map(e => e.type)).toEqual([
      "run.created", "authorization.decided", "provider.attempt.started", "provider.attempt.succeeded", "run.succeeded",
    ]);

    // Replay folds the run out of the append-only log, not out of a cache.
    const replayed = assembled.store.replay(run.id, { ...CONTEXT_BASE, snapshot: context.snapshot });
    expect(replayed.run?.status).toBe("succeeded");
    expect(replayed.revisions.length).toBeGreaterThan(1);
    expect(assembled.store.replayEquivalence(run.id, { ...CONTEXT_BASE, snapshot: context.snapshot }).equivalent).toBe(true);

    // The report is sealed by the production bundle writer and verifies on load.
    const reportDir = join(TEMP_ROOT, "report");
    const findings = assembled.provider.findings!;
    const sealed = writeAuditReport({ outDir: reportDir, findings, corpus: assembled.corpus, runId: run.id });
    expect(existsSync(sealed.indexPath)).toBe(true);
    expect(sealed.manifest.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sealed.manifest.release).toBe(run.id);
    // Provenance is copied, never synthesised.
    expect(sealed.manifest.schemaDigest).toBe(assembled.corpus.bundleSnapshot.schemaDigest);
    expect(sealed.manifest.sourceRevision).toBe(assembled.corpus.bundleSnapshot.contentDigest);
    const entries = auditReportEntries(findings, run.id);
    expect(entries.length).toBe(findings.results.length);
    expect(readFileSync(sealed.indexPath, "utf8")).toContain(entries[0]!.id);

    assembled.close();

    // Durability: a brand-new process-equivalent (new store object, new runtime)
    // still finds the run, because the log is on disk rather than in a Map.
    const reopened = openRunLog({ modelRoot: MODEL_ROOT, corpusRoot: root, tenant: "acme", workspace: "main" });
    try {
      const scoped = reopened.store.scoped(reopened.scope);
      expect(scoped.get(run.id)?.status).toBe("succeeded");
      expect(scoped.events(run.id).length).toBe(5);
      expect(reopened.store.lookupIdempotency(reopened.scope, "AuditCorpus", "key-1")?.runId).toBe(run.id);
    } finally {
      reopened.close();
    }
  });

  test("idempotency survives the process that wrote it", async () => {
    const root = makeCorpus("idem", CORPUS);
    const first = assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "AuditCorpus", tenant: "acme", workspace: "main" });
    const context = auditContext({ ...CONTEXT_BASE, trace: "trace-2", snapshot: first.snapshot });
    const run = await first.runtime.execute("AuditCorpus", { subject: "a" }, context, "key-2");
    first.close();

    const second = assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "AuditCorpus", tenant: "acme", workspace: "main" });
    try {
      // Same key, same input -> the original run comes back and the provider is
      // not asked twice.
      const replayedRun = await second.runtime.execute("AuditCorpus", { subject: "a" }, context, "key-2");
      expect(replayedRun.id).toBe(run.id);
      expect(second.provider.findings).toBeUndefined();
      // Same key, different input -> conflict, across the restart. This is what a
      // process-local Map cannot do.
      await expect(second.runtime.execute("AuditCorpus", { subject: "b" }, context, "key-2")).rejects.toThrow(/Idempotency conflict/);
    } finally {
      second.close();
    }
  });

  test("a pinned runtime fails closed on a snapshot that does not match", async () => {
    const root = makeCorpus("mismatch", CORPUS);
    const assembled = assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "AuditCorpus", tenant: "acme", workspace: "main" });
    try {
      const good = auditContext({ ...CONTEXT_BASE, trace: "trace-3", snapshot: assembled.snapshot });
      const tampered = { ...good, snapshotRef: { ...assembled.snapshot, corpusDigest: `sha256:${"b".repeat(64)}` } };
      const denied = await assembled.runtime.execute("AuditCorpus", { subject: "a" }, tampered, "key-3");
      expect(denied.status).toBe("denied");
      expect(denied.error).toBe("Snapshot binding mismatch: corpusDigest");
      expect(assembled.provider.findings).toBeUndefined();
    } finally {
      assembled.close();
    }
  });

  test("a principal without the declared capability is denied with recorded evidence", async () => {
    const root = makeCorpus("denied", CORPUS);
    const assembled = assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "AuditCorpus", tenant: "acme", workspace: "main" });
    try {
      const context = auditContext({ ...CONTEXT_BASE, capabilities: [], trace: "trace-4", snapshot: assembled.snapshot });
      const denied = await assembled.runtime.execute("AuditCorpus", { subject: "a" }, context, "key-4");
      expect(denied.status).toBe("denied");
      expect(denied.error).toContain("lacks capability: corpus.read");
      expect(assembled.provider.findings).toBeUndefined();
      expect(assembled.runtime.events(denied.id).map(e => e.type)).toEqual(["run.created", "authorization.decided", "authorization.denied"]);
    } finally {
      assembled.close();
    }
  });

  test("an action declaring an external write is refused, not executed", () => {
    const root = makeCorpus("refuse", CORPUS);
    expect(() => assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "PublishCorpus" }))
      .toThrow(AuditAssemblyError);
    expect(() => assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "NoSuchAction" }))
      .toThrow(/Available: AttestCorpus, AuditCorpus, PublishCorpus/);
  });

  test("a model-typed output takes its domain words from the caller and its metrics from the engine", async () => {
    const root = makeCorpus("attest", CORPUS);
    const model = loadModelOrThrow(MODEL_ROOT);
    const definition = model.definitions.find((d): d is ActionDefinition => d.kind === "action" && d.name === "AttestCorpus")!;
    const findings = runAudit(model, loadAuditedCorpus(root), "AttestCorpus");

    // The engine fills only numeric fields whose names match a metric it owns,
    // and never overwrites a value the caller supplied.
    const shaped = shapeOutput(model, definition, findings, { label: "quarterly review", failed: 999 }) as Record<string, unknown>;
    expect(shaped.label).toBe("quarterly review");
    expect(shaped.score).toBe(findings.metrics.score);
    expect(shaped.failed).toBe(999);

    // And the whole thing survives the runtime's output validation.
    const assembled = assembleAudit({
      modelRoot: MODEL_ROOT, corpusRoot: root, action: "AttestCorpus",
      tenant: "acme", workspace: "main", attestation: { label: "quarterly review" },
    });
    try {
      const context = auditContext({ ...CONTEXT_BASE, trace: "trace-5", snapshot: assembled.snapshot });
      const run = await assembled.runtime.execute("AttestCorpus", { subject: "a" }, context, "key-5");
      expect(run.status).toBe("succeeded");
      expect((run.output as Record<string, unknown>).label).toBe("quarterly review");
      expect((run.output as Record<string, unknown>).score).toBe(findings.metrics.score);
    } finally {
      assembled.close();
    }
  });

  test("scalar outputs need no attestation at all", () => {
    const model = loadModelOrThrow(MODEL_ROOT);
    const root = makeCorpus("scalar", CORPUS);
    const findings = runAudit(model, loadAuditedCorpus(root), "AuditCorpus");
    const base = model.definitions.find((d): d is ActionDefinition => d.kind === "action" && d.name === "AuditCorpus")!;
    expect(shapeOutput(model, base, findings, undefined)).toBe(findings.metrics.score);
    expect(shapeOutput(model, { ...base, output: "boolean" }, findings, undefined)).toBe(findings.metrics.failed === 0);
    expect(shapeOutput(model, { ...base, output: "string" }, findings, undefined)).toBe(findings.digest);
  });

  test("the run log is scoped, so another tenant cannot read this run", async () => {
    const root = makeCorpus("tenant", CORPUS);
    const assembled = assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "AuditCorpus", tenant: "acme", workspace: "main" });
    let runId = "";
    try {
      const context = auditContext({ ...CONTEXT_BASE, trace: "trace-6", snapshot: assembled.snapshot });
      runId = (await assembled.runtime.execute("AuditCorpus", { subject: "a" }, context, "key-6")).id;
    } finally {
      assembled.close();
    }
    const other = openRunLog({ modelRoot: MODEL_ROOT, corpusRoot: root, tenant: "other", workspace: "main" });
    try {
      expect(other.store.scoped(other.scope).get(runId)).toBeUndefined();
      expect(other.store.scoped(other.scope).events(runId)).toEqual([]);
    } finally {
      other.close();
    }
  });

  test("the corpus loader reports a missing manifest instead of inventing digests", () => {
    // A bundle with an index but no manifest is the legacy shape. Runtime says so
    // in a diagnostic, and the audit carries that diagnostic forward.
    const root = join(TEMP_ROOT, "legacy");
    mkdirSync(dirname(join(root, "_index.xml")), { recursive: true });
    writeFileSync(join(root, "_index.xml"), buildGlobalIndexXml([]), "utf8");
    const corpus = loadAuditedCorpus(root);
    expect(corpus.diagnostics.map(d => d.code)).toContain("MANIFEST_MISSING");
    expect(corpus.units).toEqual([]);
    const snapshot = toSnapshotRef(corpus.bundleSnapshot, loadModelOrThrow(MODEL_ROOT).manifest);
    // Legacy still yields *some* digest, and it is Runtime's, not one this code made up.
    expect(snapshot.corpusDigest).toBe(corpus.bundleSnapshot.contentDigest);
  });

  test("the sqlite log the CLI writes is the append-only one, not a scratch file", async () => {
    const root = makeCorpus("appendonly", CORPUS);
    const assembled = assembleAudit({ modelRoot: MODEL_ROOT, corpusRoot: root, action: "AuditCorpus", tenant: "acme", workspace: "main" });
    const context = auditContext({ ...CONTEXT_BASE, trace: "trace-7", snapshot: assembled.snapshot });
    const run = await assembled.runtime.execute("AuditCorpus", { subject: "a" }, context, "key-7");
    expect(assembled.storePath.endsWith(join("appendonly.prime-runs", "runs.sqlite"))).toBe(true);
    assembled.close();
    // Reopening the same file through the same class must see the same sequence.
    const store = new SqliteEventStore<ActionRun>({ path: assembled.storePath });
    try {
      const scoped = store.scoped({ ...CONTEXT_BASE, snapshot: context.snapshot });
      expect(scoped.events(run.id).map(e => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      store.close();
    }
  });
});
