import { describe, expect, test } from "bun:test";
import {
  DeterministicExpressionProvider,
  EvaluationEngine,
  EvaluationEngineError,
  EvaluationProviderRegistry,
  EvaluationSuiteSchema,
  type EvaluationProvider,
  type EvaluationSuite,
} from "../src/index.ts";

const context = { principal: "p-1", roles: ["role-a"], allowedCapabilities: ["cap.a"], tenant: "t-1", workspace: "w-1" };

const suite = (checks: readonly Record<string, unknown>[]): EvaluationSuite => EvaluationSuiteSchema.parse({ protocol: "prime/evaluation/v1", name: "suite-a", version: "1.0.0", checks });

const check = (over: Record<string, unknown> = {}) => ({ id: "c1", provider: "expression/default", severity: "error", with: { expression: "subject.n > 0" }, ...over });

const engineWith = (...providers: readonly EvaluationProvider[]) => { const registry = new EvaluationProviderRegistry(); for (const provider of providers) registry.register(provider); return new EvaluationEngine(registry) };

const nonDeterministic = (satisfied = true): EvaluationProvider => ({ id: "judge/external", kind: "llm-judge", deterministic: false, evaluate: async () => ({ satisfied, confidence: 0.6, evidence: [{ kind: "note", value: "opinion" }] }) });

const options = (over: Record<string, unknown> = {}) => ({ subject: { n: 1 }, context, modelVersion: "model-a@1.0.0", ...over });

describe("suite schema", () => {
  test("a suite with no checks is refused, so an empty document cannot become an all-pass outcome", () => {
    expect(EvaluationSuiteSchema.safeParse({ protocol: "prime/evaluation/v1", name: "s", version: "1.0.0", checks: [] }).success).toBe(false);
  });

  test("the protocol literal and the check shape are strict", () => {
    expect(EvaluationSuiteSchema.safeParse({ protocol: "prime/evaluation/v2", name: "s", version: "1.0.0", checks: [check()] }).success).toBe(false);
    expect(EvaluationSuiteSchema.safeParse({ protocol: "prime/evaluation/v1", name: "s", version: "1.0.0", checks: [{ ...check(), unexpected: 1 }] }).success).toBe(false);
    expect(EvaluationSuiteSchema.safeParse({ protocol: "prime/evaluation/v1", name: "s", version: "1.0.0", checks: [{ ...check(), severity: "fatal" }] }).success).toBe(false);
  });

  test("severity is the IR diagnostic closed set, reached by derivation rather than a second copy", () => {
    for (const severity of ["error", "warning", "info"]) expect(EvaluationSuiteSchema.safeParse({ protocol: "prime/evaluation/v1", name: "s", version: "1.0.0", checks: [{ ...check(), severity }] }).success).toBe(true);
  });
});

describe("fail closed", () => {
  test("an unregistered provider makes the check skipped and the outcome unsatisfied — never a pass", async () => {
    const outcome = await engineWith().evaluate(suite([check()]), options());
    expect(outcome.satisfied).toBe(false);
    expect(outcome.complete).toBe(false);
    expect(outcome.metrics).toEqual({ total: 1, satisfied: 0, failed: 0, skipped: 1 });
    expect(outcome.results[0]).toMatchObject({ check: "c1", provider: "expression/default", skipped: true, satisfied: false, confidence: 0 });
    expect(outcome.results[0]!.skipReason).toContain("No evaluation provider registered for expression/default");
    expect(outcome.results[0]!.skipReason).toContain("registered: none");
  });

  test("a skip sinks the outcome even when every check is informational: severity governs failure, not absence", async () => {
    const outcome = await engineWith().evaluate(suite([check({ severity: "info" }), check({ id: "c2", severity: "warning" })]), options());
    expect(outcome.results.every(result => result.skipped)).toBe(true);
    expect(outcome.satisfied).toBe(false);
  });

  test("a provider that throws is recorded as not having run, not as having failed", async () => {
    const throwing: EvaluationProvider = { id: "expression/default", kind: "deterministic-expression", deterministic: true, evaluate: async () => { throw new Error("provider is down") } };
    const outcome = await engineWith(throwing).evaluate(suite([check()]), options());
    expect(outcome.results[0]).toMatchObject({ skipped: true, satisfied: false });
    expect(outcome.results[0]!.skipReason).toContain("provider is down");
    expect(outcome.satisfied).toBe(false);
  });

  test("a check whose configuration the provider cannot use is skipped with the reason, not passed", async () => {
    const outcome = await engineWith(new DeterministicExpressionProvider()).evaluate(suite([check({ with: {} }), check({ id: "c2", with: { expression: "subject.f()" } })]), options());
    expect(outcome.results.map(result => result.skipped)).toEqual([true, true]);
    expect(outcome.results[0]!.skipReason).toContain("does not declare a string 'expression'");
    expect(outcome.results[1]!.skipReason).toContain("cannot answer");
  });

  test("a provider returning a confidence outside 0..1 has its verdict refused rather than recorded", async () => {
    const overconfident: EvaluationProvider = { id: "expression/default", kind: "deterministic-expression", deterministic: true, evaluate: async () => ({ satisfied: true, confidence: 4, evidence: [] }) };
    const outcome = await engineWith(overconfident).evaluate(suite([check()]), options());
    expect(outcome.results[0]).toMatchObject({ skipped: true, satisfied: false });
    expect(outcome.satisfied).toBe(false);
  });

  test("an evaluation that cannot name what it evaluated is refused outright", async () => {
    await expect(engineWith(new DeterministicExpressionProvider()).evaluate(suite([check()]), options({ modelVersion: "  " }))).rejects.toThrow(EvaluationEngineError);
  });
});

describe("deterministic expression provider", () => {
  test("a registered provider really evaluates, and the verdict follows the subject", async () => {
    const engine = engineWith(new DeterministicExpressionProvider());
    const passing = await engine.evaluate(suite([check()]), options({ subject: { n: 1 } }));
    expect(passing).toMatchObject({ satisfied: true, complete: true, metrics: { total: 1, satisfied: 1, failed: 0, skipped: 0 } });
    const failing = await engine.evaluate(suite([check()]), options({ subject: { n: 0 } }));
    expect(failing).toMatchObject({ satisfied: false, complete: true, metrics: { total: 1, satisfied: 0, failed: 1, skipped: 0 } });
    expect(failing.results[0]).toMatchObject({ skipped: false, satisfied: false, deterministic: true, confidence: 1 });
  });

  test("severity decides which failures sink the outcome; a failed info or warning check is reported and does not", async () => {
    const engine = engineWith(new DeterministicExpressionProvider());
    const outcome = await engine.evaluate(suite([check({ id: "info", severity: "info" }), check({ id: "warn", severity: "warning" })]), options({ subject: { n: 0 } }));
    expect(outcome.metrics).toEqual({ total: 2, satisfied: 0, failed: 2, skipped: 0 });
    expect(outcome.satisfied).toBe(true);
    const withError = await engine.evaluate(suite([check({ id: "info", severity: "info" }), check({ id: "err", severity: "error" })]), options({ subject: { n: 0 } }));
    expect(withError.satisfied).toBe(false);
  });

  test("the result carries the whole §9.7 envelope on every check", async () => {
    const outcome = await engineWith(new DeterministicExpressionProvider()).evaluate(suite([check()]), options({ policyDecision: { allowed: true, reason: "rule r allows it" } }));
    const result = outcome.results[0]!;
    expect(Object.keys(result).sort()).toEqual(["check", "confidence", "deterministic", "evidence", "modelVersion", "policyDecision", "provider", "satisfied", "severity", "skipped"]);
    expect(result.modelVersion).toBe("model-a@1.0.0");
    expect(result.policyDecision).toEqual({ allowed: true, reason: "rule r allows it" });
    expect(result.evidence).toEqual([{ kind: "expression", value: "subject.n > 0" }, { kind: "provider", value: "expression/default" }]);
  });

  test("a skipped result carries the same envelope plus skipReason", async () => {
    const outcome = await engineWith().evaluate(suite([check()]), options({ policyDecision: { allowed: false, reason: "denied" } }));
    expect(Object.keys(outcome.results[0]!).sort()).toEqual(["check", "confidence", "deterministic", "evidence", "modelVersion", "policyDecision", "provider", "satisfied", "severity", "skipReason", "skipped"]);
  });

  test("registering the same provider id twice is refused, so a suite cannot be silently rerouted", () => {
    const registry = new EvaluationProviderRegistry();
    registry.register(new DeterministicExpressionProvider());
    expect(() => registry.register(new DeterministicExpressionProvider())).toThrow(/already registered/);
    expect(new EvaluationEngine(registry).registered()).toEqual(["expression/default"]);
  });
});

describe("§12.3: a non-deterministic validator is not a fail-open gate", () => {
  test("without a policy decision, a non-deterministic provider's verdict may not satisfy a check", async () => {
    const outcome = await engineWith(nonDeterministic()).evaluate(suite([check({ provider: "judge/external" })]), options());
    expect(outcome.results[0]).toMatchObject({ skipped: true, satisfied: false, deterministic: false });
    expect(outcome.results[0]!.skipReason).toContain("no policy decision was supplied");
    expect(outcome.satisfied).toBe(false);
  });

  test("a denying policy decision keeps it skipped and records why", async () => {
    const outcome = await engineWith(nonDeterministic()).evaluate(suite([check({ provider: "judge/external" })]), options({ policyDecision: { allowed: false, reason: "no rule permits an external judge" } }));
    expect(outcome.results[0]!.skipReason).toContain("no rule permits an external judge");
    expect(outcome.satisfied).toBe(false);
  });

  test("an allowing policy decision lets it run, and the verdict is recorded as non-deterministic", async () => {
    const outcome = await engineWith(nonDeterministic()).evaluate(suite([check({ provider: "judge/external" })]), options({ policyDecision: { allowed: true, reason: "rule judge-allowed allows it" } }));
    expect(outcome.results[0]).toMatchObject({ skipped: false, satisfied: true, deterministic: false, confidence: 0.6 });
    expect(outcome.satisfied).toBe(true);
  });

  test("a deterministic provider is not gated by policy, because it is not an opinion", async () => {
    const outcome = await engineWith(new DeterministicExpressionProvider()).evaluate(suite([check()]), options());
    expect(outcome.results[0]!.skipped).toBe(false);
  });
});
