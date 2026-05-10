import { describe, it, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PrimeExecutor } from "../src/executor";
import { IndexManager } from "../src/index-manager";
import { PrimeLoader } from "../src/loader";
import { EvaluationEngine } from "../src/evaluator";
import { MethodLoader } from "../src/method-loader";
import { createMockStepExecutor } from "../src/ai-step-executor";
import type { Method, Step } from "@skill-wiki/types";
import type { ExecutionContext, StepResult } from "../src/types";

type StepExecutorFn = (step: Step, context: ExecutionContext) => StepResult | Promise<StepResult>;

function makeExecutor(stepExec?: StepExecutorFn) {
  const index = new IndexManager();
  const loader = new PrimeLoader("/tmp");
  const evaluator = new EvaluationEngine();
  return new PrimeExecutor(index, loader, evaluator, stepExec);
}

const SAMPLE_METHOD: Method = {
  type: "Method",
  name: "sample-method",
  version: "1.0.0",
  description: "Sample two-step method",
  input: [],
  output: [],
  steps: [
    { name: "step-one", description: "do first thing", error_handler: { message: "fail hard" } },
    { name: "step-two", description: "do second thing", error_handler: { message: "fail hard" } },
  ],
};

describe("PrimeExecutor — defaultStepExecutor (no-op)", () => {
  it("refuses to execute steps without an injected executor", async () => {
    const exec = makeExecutor();
    const result = await exec.executeMethod(SAMPLE_METHOD, {});
    // Previously: silently returned success:true with fake "Executed: ..." outputs.
    // Now: fails loudly (either via unhandled error or step error propagation).
    expect(result.success).toBe(false);
    expect(result.state.steps_completed.length).toBe(0);
    expect(result.state.errors_encountered.length).toBeGreaterThan(0);
  });
});

describe("PrimeExecutor — createMockStepExecutor", () => {
  it("runs all steps and returns their outputs", async () => {
    const mock = createMockStepExecutor({
      "step-one": "first-done",
      "step-two": "second-done",
    });
    const exec = makeExecutor(mock);
    const result = await exec.executeMethod(SAMPLE_METHOD, {});
    expect(result.success).toBe(true);
    expect(result.state.steps_completed).toEqual(["step-one", "step-two"]);
    expect(result.state.status).toBe("done");
  });
});

describe("MethodLoader", () => {
  it("reads a methods.json file and returns Methods by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "method-loader-"));
    const path = join(dir, "methods.json");
    writeFileSync(path, JSON.stringify({
      "@test/sample": {
        kind: "method",
        name: "sample-from-loader",
        version: "1.0.0",
        description: "loaded from disk",
        steps: [
          { name: "s1", description: "do s1", error_handler: { message: "fail" } },
        ],
      },
    }));
    const loader = new MethodLoader(path);
    expect(loader.size()).toBe(1);
    const m = loader.getMethod("@test/sample");
    expect(m).not.toBeNull();
    expect(m!.steps[0].name).toBe("s1");
  });

  it("returns null when the methods.json is missing", () => {
    const loader = new MethodLoader("/tmp/definitely-does-not-exist.json");
    expect(loader.size()).toBe(0);
    expect(loader.getMethod("@anything/here")).toBeNull();
  });

  it("resolves trailing-slug lookups for non-namespaced names", () => {
    const dir = mkdtempSync(join(tmpdir(), "method-loader-slug-"));
    const path = join(dir, "methods.json");
    writeFileSync(path, JSON.stringify({
      "@community/design-qa-pre-ship-checklist": {
        kind: "method", name: "qa", version: "1.0.0", description: "", steps: [],
      },
    }));
    const loader = new MethodLoader(path);
    // Direct id works
    expect(loader.getMethod("@community/design-qa-pre-ship-checklist")).not.toBeNull();
    // Plain slug doesn't resolve at MethodLoader level — executor does the fallback
    expect(loader.getMethod("design-qa-pre-ship-checklist")).toBeNull();
  });
});

describe("PrimeExecutor — async step executor", () => {
  it("awaits a Promise<StepResult>", async () => {
    const asyncExec = async (step: { name: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      return { name: step.name, success: true, output: `async-${step.name}` };
    };
    const exec = makeExecutor(asyncExec);
    const result = await exec.executeMethod(SAMPLE_METHOD, {});
    expect(result.success).toBe(true);
    // Async executor outputs propagate through context.step_results; state doesn't expose them but success signal suffices.
    expect(result.state.steps_completed.length).toBe(2);
  });
});
