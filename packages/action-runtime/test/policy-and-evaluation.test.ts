import { describe, expect, test } from "bun:test";
import { DeterministicExpressionProvider, EvaluationEngine, EvaluationProviderRegistry, EvaluationSuiteSchema } from "@aoe/evaluation-engine";
import { loadModelOrThrow, type ActionDefinition, type LoadedModel } from "@aoe/model-schema";
import { PolicyEngine, PolicySetSchema } from "@aoe/policy-engine";
import { ActionProviderRegistry, ActionRuntime, type RuntimeOptions } from "../src/index.ts";

const base = loadModelOrThrow(new URL("../../model-schema/test/fixtures/ticket-model", import.meta.url).pathname);
const context = { principal: "tester", roles: ["agent"], allowedCapabilities: [], budget: {}, snapshot: "snapshot-1", trace: "trace-1", tenant: "t-1", workspace: "w-1" };
const ticket = { title: "Fix", active: true, owner: { name: "Ada" } };
const authorizer = { authorize: async () => ({ allowed: true, reason: "test allow", evidence: [] }) };

/** The model is data, so each case states the declaration it needs instead of the suite carrying one shape for all of them. */
function modelWith(mutate: (action: ActionDefinition) => void): LoadedModel {
  const model = structuredClone(base) as LoadedModel;
  mutate(model.definitions.find((definition): definition is ActionDefinition => definition.kind === "action")!);
  return model;
}

function runtimeFor(mutate: (action: ActionDefinition) => void, options: Partial<RuntimeOptions> = {}) {
  let calls = 0;
  const actions = new ActionProviderRegistry().register("ticket-resolver", { execute: async () => { calls++; return true } });
  return { runtime: new ActionRuntime(modelWith(mutate), { actions, authorizer, ...options }), providerCalls: () => calls };
}

const policySet = (rules: readonly Record<string, unknown>[], fallback: "allow" | "deny" = "deny") => PolicySetSchema.parse({ protocol: "prime/policy/v1", name: "set-a", version: "1.0.0", default: fallback, rules });

const conditional = (action: ActionDefinition) => { action.approval = "conditional" };

describe("approval: conditional stops being a permanent refusal once a policy engine is wired", () => {
  test("without a policy provider it is still denied — this is the W7-B baseline, kept as a test so a regression is visible", async () => {
    const { runtime, providerCalls } = runtimeFor(conditional);
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "no-policy");
    expect(run).toMatchObject({ status: "denied", error: "No policy provider" });
    expect(providerCalls()).toBe(0);
    expect(runtime.events(run.id).map(event => event.type)).toEqual(["run.created", "authorization.decided", "policy.decided", "policy.denied"]);
  });

  test("with a declared policy set that matches, the same action really executes", async () => {
    const policy = new PolicyEngine(policySet([{ id: "conditional-for-agents", effect: "allow", description: "declared by the set", match: { approval: ["conditional"], sideEffects: ["none"], anyRole: ["agent"], tenants: ["t-1"] } }]));
    const { runtime, providerCalls } = runtimeFor(conditional, { policy });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "policy-allow");
    expect(run).toMatchObject({ status: "succeeded", output: true });
    expect(providerCalls()).toBe(1);
    expect(run.policyDecision?.allowed).toBe(true);
    expect(run.policyDecision?.reason).toContain("conditional-for-agents");
    expect(run.evidence).toEqual(expect.arrayContaining([{ kind: "policy-set", value: "set-a@1.0.0" }, { kind: "policy-rule", value: "conditional-for-agents" }]));
    expect(runtime.events(run.id).map(event => event.type)).toEqual(["run.created", "authorization.decided", "policy.decided", "provider.attempt.started", "provider.attempt.succeeded", "run.succeeded"]);
  });

  test("the engine carries no policy of its own: the same request is denied by a set that declares no matching rule", async () => {
    const policy = new PolicyEngine(policySet([{ id: "other-action-only", effect: "allow", match: { actions: ["SomethingElse"] } }]));
    const { runtime, providerCalls } = runtimeFor(conditional, { policy });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "policy-default-deny");
    expect(run.status).toBe("denied");
    expect(run.error).toContain("declared default is deny");
    expect(providerCalls()).toBe(0);
  });

  test("a matching deny outranks a matching allow, and the provider never runs", async () => {
    const policy = new PolicyEngine(policySet([{ id: "allow-all", effect: "allow", match: {} }, { id: "deny-untrusted-role", effect: "deny", match: { anyRole: ["agent"] } }], "allow"));
    const { runtime, providerCalls } = runtimeFor(conditional, { policy });
    expect((await runtime.execute("ResolveTicket", { ticket }, context, "policy-deny")).error).toContain("deny-untrusted-role");
    expect(providerCalls()).toBe(0);
  });

  test("a run claiming a different policy set is refused rather than governed by the loaded one (§8.5)", async () => {
    const policy = new PolicyEngine(policySet([{ id: "allow-all", effect: "allow", match: {} }]));
    const { runtime } = runtimeFor(conditional, { policy });
    const run = await runtime.execute("ResolveTicket", { ticket }, { ...context, policyRef: "some-other-set" }, "policy-ref");
    expect(run).toMatchObject({ status: "denied" });
    expect(run.error).toContain("Policy set mismatch");
    // The plan already carried the claim, so the refusal is attributable to the request rather than to the engine's mood.
    expect(run.plan.nodes.find(node => node.id === "gate-policy")?.inputs).toMatchObject({ policyRef: "some-other-set" });
  });
});

describe("a declared precondition is an expression, evaluated deterministically", () => {
  test("a declared expression decides the run when no precondition provider is injected", async () => {
    const declare = (action: ActionDefinition) => { action.preconditions = ["input.ticket.active == true"] };
    const passing = runtimeFor(declare);
    expect((await passing.runtime.execute("ResolveTicket", { ticket }, context, "precondition-true")).status).toBe("succeeded");
    const failing = runtimeFor(declare);
    const denied = await failing.runtime.execute("ResolveTicket", { ticket: { ...ticket, active: false } }, context, "precondition-false");
    expect(denied).toMatchObject({ status: "denied", error: "Precondition denied: input.ticket.active == true" });
    expect(failing.providerCalls()).toBe(0);
  });

  test("an expression the evaluator cannot answer denies the run and says why — it never passes by not understanding the question", async () => {
    const { runtime, providerCalls } = runtimeFor(action => { action.preconditions = ["ticket-open"] });
    const run = await runtime.execute("ResolveTicket", { ticket }, context, "precondition-unanswerable");
    expect(run.status).toBe("denied");
    expect(run.error).toContain("Unknown name in expression: ticket-open");
    expect(providerCalls()).toBe(0);
  });

  test("an injected provider still wins, because a model may declare a condition no expression can decide", async () => {
    const asked: string[] = [];
    const { runtime } = runtimeFor(action => { action.preconditions = ["ticket-open"] }, { preconditions: { check: async name => { asked.push(name); return true } } });
    expect((await runtime.execute("ResolveTicket", { ticket }, context, "precondition-injected")).status).toBe("succeeded");
    expect(asked).toEqual(["ticket-open"]);
  });
});

describe("the evaluation engine reached through an action provider", () => {
  const suite = EvaluationSuiteSchema.parse({ protocol: "prime/evaluation/v1", name: "suite-a", version: "1.0.0", checks: [{ id: "has-owner", provider: "expression/default", severity: "error", with: { expression: "subject.owner.name.length > 0" } }] });

  /** The action provider is where an evaluation belongs: §9.6 drives a provider, and §9.7 is what that provider consults. */
  const runtimeEvaluating = (engine: EvaluationEngine) => new ActionRuntime(modelWith(() => {}), {
    authorizer,
    actions: new ActionProviderRegistry().register("ticket-resolver", {
      execute: async (input, requestContext) => {
        const outcome = await engine.evaluate(suite, { subject: (input as { ticket: unknown }).ticket, context: requestContext, modelVersion: `${base.manifest.name}@${base.manifest.version}` });
        return outcome.satisfied;
      },
    }),
  });

  test("with the deterministic provider registered the evaluation really runs", async () => {
    const engine = new EvaluationEngine(new EvaluationProviderRegistry().register(new DeterministicExpressionProvider()));
    expect(await runtimeEvaluating(engine).execute("ResolveTicket", { ticket }, context, "eval-registered")).toMatchObject({ status: "succeeded", output: true });
  });

  test("with no provider registered the evaluation fails closed: output is false, not a pass", async () => {
    const engine = new EvaluationEngine(new EvaluationProviderRegistry());
    expect(await runtimeEvaluating(engine).execute("ResolveTicket", { ticket }, context, "eval-unregistered")).toMatchObject({ status: "succeeded", output: false });
  });
});
