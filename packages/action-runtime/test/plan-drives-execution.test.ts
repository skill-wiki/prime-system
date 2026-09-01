/**
 * The judgement this file is for is **not** "the node graph is not a constant" —
 * `plan-and-ledger.test.ts` already pins that, and D-13's point is that a truthful
 * description of a hardcoded sequence is still not a plan. What is asserted here
 * is the stronger property: **changing the plan changes what runs.**
 *
 * Every test below hands the runtime a plan that disagrees with the
 * `ActionDefinition` on some point, then asserts execution followed the *plan*.
 * If `executeInner` were still branching on `def.approval` / `def.capabilities` /
 * `context.budget`, each of these would come back with the definition's outcome
 * instead, so a regression here cannot be papered over by the plan still looking
 * right.
 *
 * The second half covers §17.5: a node kind this runtime does not implement is
 * refused with its reason on the run and in the log, never skipped quietly.
 */
import { describe, expect, test } from "bun:test";
import type { ExecutionPlanIR, ExecutionPlanNodeIR } from "@aoe/ir";
import { loadModelOrThrow } from "@aoe/model-schema";
import {
  ActionProviderRegistry,
  ActionRuntime,
  type ExecutionPlanner,
  type PreconditionProvider,
  type RequestContext,
  type RuntimeOptions,
} from "../src/index.ts";

const model = loadModelOrThrow(new URL("../../model-schema/test/fixtures/ticket-model", import.meta.url).pathname);
const context: RequestContext = { principal: "tester", roles: ["agent"], allowedCapabilities: [], budget: {}, snapshot: "snapshot-1", trace: "trace-1" };
const ticket = { title: "Fix", active: true, owner: { name: "Ada" } };
const allowed = { authorize: async () => ({ allowed: true, reason: "test allow", evidence: [] }) };

/** `edges` is re-derived from `dependsOn` after every rewrite, because the runtime fails closed when the two disagree — and that check has its own test below. */
const withEdges = (plan: ExecutionPlanIR): ExecutionPlanIR => ({ ...plan, edges: plan.nodes.flatMap(node => node.dependsOn.map(from => ({ from, to: node.id }))) });

function insertBefore(plan: ExecutionPlanIR, beforeId: string, node: Omit<ExecutionPlanNodeIR, "dependsOn">): ExecutionPlanIR {
  const index = plan.nodes.findIndex(candidate => candidate.id === beforeId);
  if (index < 0) throw new Error(`no node ${beforeId}`);
  const target = plan.nodes[index]!, inserted: ExecutionPlanNodeIR = { ...node, dependsOn: target.dependsOn };
  return withEdges({ ...plan, nodes: [...plan.nodes.slice(0, index), inserted, { ...target, dependsOn: [inserted.id] }, ...plan.nodes.slice(index + 1)] });
}

function without(plan: ExecutionPlanIR, id: string): ExecutionPlanIR {
  const removed = plan.nodes.find(node => node.id === id);
  if (!removed) throw new Error(`no node ${id}`);
  return withEdges({ ...plan, nodes: plan.nodes.filter(node => node.id !== id).map(node => node.dependsOn.includes(id) ? { ...node, dependsOn: removed.dependsOn } : node) });
}

const rewritePlan = (rewrite: (derived: ExecutionPlanIR) => ExecutionPlanIR): ExecutionPlanner => ({ plan: ({ derived }) => rewrite(derived) });

/** `calls` and `asked` are the observable execution path: what the provider ran and what the precondition provider was asked. */
function runtimeFor(extra: Partial<RuntimeOptions> = {}, execute: () => Promise<unknown> = async () => true) {
  let calls = 0;
  const asked: string[] = [];
  const preconditions: PreconditionProvider = { check: async (name) => { asked.push(name); return true } };
  const runtime = new ActionRuntime(model, {
    actions: new ActionProviderRegistry().register("ticket-resolver", { execute: async () => { calls++; return execute() } }),
    authorizer: allowed,
    preconditions,
    ...extra,
  });
  return { runtime, calls: () => calls, asked };
}

describe("the plan drives execution, it does not describe it", () => {
  test("a Gate node the definition never asked for denies a run the definition would have allowed", async () => {
    // Control: the same definition, same request, unmodified plan.
    const control = runtimeFor();
    expect((await control.runtime.execute("ResolveTicket", { ticket }, context, "control")).status).toBe("succeeded");
    expect(control.calls()).toBe(1);

    // `ResolveTicket` declares no capabilities, so nothing in the definition or the
    // request can deny this. Only the plan can.
    const governed = runtimeFor({ planner: rewritePlan(derived => insertBefore(derived, "invoke-action", { id: "gate-capability-extra", kind: "Gate", target: "ledger:write", inputs: { capability: "ledger:write" } })) });
    const denied = await governed.runtime.execute("ResolveTicket", { ticket }, context, "extra-gate");
    expect(denied).toMatchObject({ status: "denied", error: "Capability denied: ledger:write" });
    expect(governed.calls()).toBe(0);
    expect(denied.steps.map(step => [step.nodeId, step.status])).toEqual([
      ["validate-input", "succeeded"], ["gate-authorization", "succeeded"], ["gate-capability-extra", "denied"],
    ]);
  });

  test("an AwaitApproval node suspends an action whose definition says approval: never", async () => {
    const { runtime, calls } = runtimeFor({ planner: rewritePlan(derived => ({ ...insertBefore(derived, "invoke-action", { id: "await-approval", kind: "AwaitApproval", target: "human", inputs: { requirement: "human" } }), approvals: ["human"], checkpoints: ["await-approval"] })) });
    const waiting = await runtime.execute("ResolveTicket", { ticket }, context, "planned-approval");
    // The definition's `approval` is "never" and `effect.approval` is "none"; the
    // old executor branched on exactly that and would have gone straight to the
    // provider.
    expect(waiting.effect.approval).toBe("none");
    expect(waiting.status).toBe("awaiting_approval");
    expect(calls()).toBe(0);
    expect(waiting.steps.at(-1)).toMatchObject({ nodeId: "await-approval", status: "suspended" });
    // A suspended run has no whole-run duration yet — it has not ended.
    expect(waiting.durationMs).toBeUndefined();

    const resumed = await runtime.approve(waiting.id, { principal: "reviewer", roles: ["approver"] });
    expect(resumed.status).toBe("succeeded");
    expect(calls()).toBe(1);
    // The resumed walk continued the same plan from the checkpoint rather than
    // re-running the gates before it.
    expect(resumed.steps.map(step => step.nodeId)).toEqual(["validate-input", "gate-authorization", "await-approval", "invoke-action", "validate-output", "emit-audit"]);
    expect(typeof resumed.durationMs).toBe("number");
  });

  test("a Validate node carrying a precondition the definition never declared is still checked", async () => {
    expect(model.definitions.find(definition => definition.kind === "action" && definition.name === "ResolveTicket")).not.toHaveProperty("preconditions");
    const passing = runtimeFor({ planner: rewritePlan(derived => insertBefore(derived, "invoke-action", { id: "validate-precondition-planned", kind: "Validate", target: "ticket-open", inputs: { precondition: "ticket-open" } })) });
    expect((await passing.runtime.execute("ResolveTicket", { ticket }, context, "precondition-ok")).status).toBe("succeeded");
    expect(passing.asked).toEqual(["ticket-open"]);

    const failing = runtimeFor({ preconditions: { check: async () => false }, planner: rewritePlan(derived => insertBefore(derived, "invoke-action", { id: "validate-precondition-planned", kind: "Validate", target: "ticket-open", inputs: { precondition: "ticket-open" } })) });
    const denied = await failing.runtime.execute("ResolveTicket", { ticket }, context, "precondition-deny");
    expect(denied).toMatchObject({ status: "denied", error: "Precondition denied: ticket-open" });
    expect(failing.calls()).toBe(0);
  });

  test("the attempt budget is read off the InvokeAction node, not off the request", async () => {
    let attempts = 0;
    // The request asks for three attempts; the plan allows one. The provider must
    // be called once.
    const { runtime } = runtimeFor({ planner: rewritePlan(derived => withEdges({ ...derived, nodes: derived.nodes.map(node => node.kind === "InvokeAction" ? { ...node, inputs: { ...node.inputs, maxAttempts: 1 } } : node) })) }, async () => { attempts++; throw new Error("transient") });
    const run = await runtime.execute("ResolveTicket", { ticket }, { ...context, budget: { maxAttempts: 3 } }, "node-budget");
    expect(run).toMatchObject({ status: "failed", attempts: 1, error: "transient" });
    expect(attempts).toBe(1);
    expect(run.steps.at(-1)?.attempts).toHaveLength(1);
  });

  test("the timeout is read off plan.budget, not off the request", async () => {
    // The request names no timeout at all; the plan does.
    const { runtime } = runtimeFor({ planner: rewritePlan(derived => ({ ...derived, budget: { maxDurationMs: 1 } })) }, () => new Promise(resolve => setTimeout(() => resolve(true), 25)));
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "node-timeout");
    expect(context.budget.timeoutMs).toBeUndefined();
    expect(run).toMatchObject({ status: "failed", error: "Provider timeout" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(run.status).toBe("failed");
  });

  test("reordering the graph reorders execution: output validation before the provider fails closed", async () => {
    const { runtime, calls } = runtimeFor({ planner: rewritePlan(derived => withEdges({ ...derived, nodes: derived.nodes.map(node =>
      node.id === "validate-output" ? { ...node, dependsOn: ["gate-authorization"] }
      : node.id === "invoke-action" ? { ...node, dependsOn: ["validate-output"] }
      : node.id === "emit-audit" ? { ...node, dependsOn: ["invoke-action"] }
      : node) })) });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "reordered");
    // Array order is unchanged; only `dependsOn` moved. The walk followed the
    // edges, validated an output that did not exist yet, and never reached the
    // provider.
    expect(run).toMatchObject({ status: "failed", error: "output must be boolean" });
    expect(calls()).toBe(0);
    expect(run.steps.map(step => step.nodeId)).toEqual(["validate-input", "gate-authorization", "validate-output"]);
  });

  test("a plan with no Emit node cannot report success, because nothing wrote the audit record", async () => {
    const { runtime, calls } = runtimeFor({ planner: rewritePlan(derived => without(derived, "emit-audit")) });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "no-emit");
    expect(calls()).toBe(1);
    expect(run.output).toBe(true);
    // The work happened; the record did not. Reporting "succeeded" here is the one
    // outcome Phase 4 rules out.
    expect(run.status).toBe("failed");
    expect(run.error).toContain("completed without an Emit node");
    expect(runtime.events(run.id).map(event => event.type)).toEqual(["run.created", "authorization.decided", "provider.attempt.started", "provider.attempt.succeeded", "run.failed"]);
  });
});

describe("unimplemented node kinds fail closed with a recorded reason", () => {
  const unimplemented: ExecutionPlanNodeIR["kind"][] = ["Query", "Materialize", "Transform", "InvokeFunction", "InvokeModel"];

  test.each(unimplemented.map(kind => [kind] as [ExecutionPlanNodeIR["kind"]]))("a %s node refuses the run instead of being skipped", async (kind) => {
    const { runtime, calls } = runtimeFor({ planner: rewritePlan(derived => insertBefore(derived, "invoke-action", { id: `planned-${kind}`, kind, target: "whatever", inputs: {} })) });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, `unimplemented-${kind}`);
    expect(run.status).toBe("failed");
    expect(run.error).toBe(`Execution plan node planned-${kind} has kind ${kind}, which this runtime does not implement`);
    expect(calls()).toBe(0);
    // §17.5: the skip is on the run *and* in the append-only log, with a reason.
    const step = run.steps.at(-1)!;
    expect(step).toMatchObject({ nodeId: `planned-${kind}`, kind, status: "skipped" });
    expect(step.skipReason!.length).toBeGreaterThan(20);
    const skipped = runtime.events(run.id).find(event => event.type === "node.skipped");
    expect(skipped?.payload).toMatchObject({ nodeId: `planned-${kind}`, kind, skipReason: step.skipReason });
  });

  test("a skipped node never reports the run as passed, so no unimplemented kind can pass silently", async () => {
    for (const kind of unimplemented) {
      const { runtime } = runtimeFor({ planner: rewritePlan(derived => insertBefore(derived, "invoke-action", { id: "planned", kind, target: "t", inputs: {} })) });
      const run = await runtime.execute("ResolveTicket", { ticket }, context, `silent-${kind}`);
      expect(run.status).not.toBe("succeeded");
      expect(run.steps.some(step => step.status === "skipped")).toBe(true);
    }
  });
});

describe("a malformed plan is refused rather than partially executed", () => {
  const cases: readonly [string, (derived: ExecutionPlanIR) => ExecutionPlanIR, string][] = [
    ["a dependency cycle", derived => withEdges({ ...derived, nodes: derived.nodes.map(node => node.id === "validate-input" ? { ...node, dependsOn: ["emit-audit"] } : node) }), "has a dependency cycle"],
    ["an unknown dependency", derived => withEdges({ ...derived, nodes: derived.nodes.map(node => node.id === "invoke-action" ? { ...node, dependsOn: ["ghost"] } : node) }), "depends on unknown node ghost"],
    ["duplicate node ids", derived => withEdges({ ...derived, nodes: [...derived.nodes, { ...derived.nodes[0]!, dependsOn: [] }] }), "has duplicate node ids"],
    // Both halves of §7.6's redundant relation must agree: if they disagree one of
    // them is a false statement about what will run.
    ["edges that contradict dependsOn", derived => ({ ...derived, edges: [...derived.edges, { from: "emit-audit", to: "validate-input" }] }), "edges that do not match its dependsOn relation"],
    ["a Gate with a non-string capability", derived => insertBefore(derived, "invoke-action", { id: "bad-gate", kind: "Gate", target: "x", inputs: { capability: 7 } }), "needs a string capability"],
    ["a Gate with no requirement", derived => insertBefore(derived, "invoke-action", { id: "bare-gate", kind: "Gate", target: "x", inputs: {} }), "is a Gate with no requirement in its inputs"],
    ["a Validate with no subject", derived => insertBefore(derived, "invoke-action", { id: "bare-validate", kind: "Validate", target: "x", inputs: {} }), "is a Validate with no subject in its inputs"],
  ];

  test.each(cases)("%s is refused", async (_label, rewrite, message) => {
    const { runtime, calls } = runtimeFor({ planner: rewritePlan(rewrite) });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, `malformed-${_label}`);
    // `denied` for a rejected request, `failed` for a node that could not be
    // interpreted at all — either way the run is terminal, carries the reason, and
    // never reached the provider.
    expect(["denied", "failed"]).toContain(run.status);
    expect(run.error).toContain(message);
    expect(calls()).toBe(0);
  });
});

describe("every step carries a duration", () => {
  test("a successful run records one step per node, each with its own measured duration", async () => {
    const { runtime } = runtimeFor({}, () => new Promise(resolve => setTimeout(() => resolve(true), 20)));
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "durations");
    expect(run.status).toBe("succeeded");
    expect(run.steps.map(step => [step.nodeId, step.kind, step.status])).toEqual([
      ["validate-input", "Validate", "succeeded"],
      ["gate-authorization", "Gate", "succeeded"],
      ["invoke-action", "InvokeAction", "succeeded"],
      ["validate-output", "Validate", "succeeded"],
      ["emit-audit", "Emit", "succeeded"],
    ]);
    for (const step of run.steps) {
      expect(typeof step.durationMs).toBe("number");
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
      expect(step.startedAt).toBeGreaterThan(0);
    }
    // A real measurement, not a zero: the provider slept 20ms and only that step
    // is allowed to show it.
    const invoke = run.steps.find(step => step.kind === "InvokeAction")!;
    expect(invoke.durationMs).toBeGreaterThanOrEqual(15);
    expect(invoke.attempts).toEqual([{ attempt: 1, startedAt: invoke.attempts![0]!.startedAt, durationMs: invoke.attempts![0]!.durationMs, status: "succeeded" }]);
    expect(invoke.attempts![0]!.durationMs).toBeGreaterThanOrEqual(15);
    // The whole-run duration covers the steps rather than being computed apart
    // from them.
    expect(run.durationMs!).toBeGreaterThanOrEqual(invoke.durationMs);
    // Durations reach the log as well as the run, so an event stream alone answers
    // "how long did this attempt take".
    const succeeded = runtime.events(run.id).find(event => event.type === "provider.attempt.succeeded")!;
    expect(succeeded.payload).toMatchObject({ attempt: 1, durationMs: invoke.attempts![0]!.durationMs });
    expect(runtime.events(run.id).at(-1)!.payload).toMatchObject({ sink: "audit", durationMs: run.durationMs! });
  });

  test("a retrying run records a duration per attempt, not one for the node", async () => {
    let calls = 0;
    const { runtime } = runtimeFor({}, async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); if (calls < 3) throw new Error("transient"); return true });
    const run = await runtime.execute("ResolveTicket", { ticket }, { ...context, budget: { maxAttempts: 3 } }, "attempt-durations");
    expect(run).toMatchObject({ status: "succeeded", attempts: 3 });
    const attempts = run.steps.find(step => step.kind === "InvokeAction")!.attempts!;
    expect(attempts.map(attempt => [attempt.attempt, attempt.status])).toEqual([[1, "failed"], [2, "failed"], [3, "succeeded"]]);
    for (const attempt of attempts) expect(attempt.durationMs).toBeGreaterThanOrEqual(3);
    expect(attempts.filter(attempt => attempt.error === "transient")).toHaveLength(2);
    // The failure durations are in the log too, so a failed attempt is as
    // measurable as a successful one.
    for (const event of runtime.events(run.id).filter(record => record.type === "provider.attempt.failed")) expect(typeof event.payload.durationMs).toBe("number");
  });

  test("steps and durations survive serialisation, because the event store persists the run", async () => {
    const { runtime } = runtimeFor();
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "serialisable");
    expect(JSON.parse(JSON.stringify(run.steps))).toEqual(run.steps);
    expect(JSON.parse(JSON.stringify({ durationMs: run.durationMs, startedAt: run.startedAt }))).toEqual({ durationMs: run.durationMs, startedAt: run.startedAt });
  });

  test("a denied run still records the step that denied it, with its duration", async () => {
    const { runtime } = runtimeFor();
    const run = await runtime.execute("ResolveTicket", { ticket: { ...ticket, extra: 1 } }, context, "denied-duration");
    expect(run.status).toBe("denied");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ nodeId: "validate-input", status: "denied", error: "input.ticket.extra is unknown" });
    expect(typeof run.steps[0]!.durationMs).toBe("number");
    expect(typeof run.durationMs).toBe("number");
  });
});
