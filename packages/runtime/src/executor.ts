/**
 * @module executor
 * PrimeExecutor — executes compiled Primes step by step.
 *
 * Execution phases (from Spec 06):
 *   1. MATCH    — scan Index, match user request to Prime
 *   2. REQUIRE  — check preconditions (require field)
 *   3. LOAD     — load dependencies by relationship order (REQUIRES -> SUPPLIES)
 *   4. EXECUTE  — execute steps in order
 *   5. VALIDATE — load associated Rules (VALIDATES), run checks
 *   6. EVALUATE — run success_criteria / failure_criteria
 *   7. REPORT   — output evaluation report (verdict + score + confidence)
 *
 * Error handling priority (inside out):
 *   Step.error_handler → Method.branches → VALIDATES Rule.severity → Stop
 */

import type { Method, Step, Branch, Precondition } from "@skill-wiki/types";
import type { PrimeLoader } from "./loader";
import type { IndexManager } from "./index-manager";
import type { EvaluationEngine } from "./evaluator";
import type { MethodLoader } from "./method-loader";
import type {
  ExecutionResult,
  ExecutionState,
  ExecutionError,
  RequirementResult,
  RequirementCheck,
  StepResult,
  LoadStep,
  ExecutionContext,
  PrimeEvaluationConfig,
} from "./types";

/**
 * Executes a compiled Prime through all seven phases.
 *
 * The executor coordinates between IndexManager (matching),
 * PrimeLoader (loading), and EvaluationEngine (evaluation).
 *
 * It tracks execution state including current step, completed steps,
 * loop iterations, and errors encountered.
 */
export class PrimeExecutor {
  private indexManager: IndexManager;
  private loader: PrimeLoader;
  private evaluator: EvaluationEngine;
  private methodLoader: MethodLoader | null;

  /**
   * Step executor function — called for each step during EXECUTE phase.
   * This is the integration point where the AI agent does actual work.
   *
   * In a real system, this would invoke the AI to perform the step.
   * For the runtime, it's a pluggable callback.
   *
   * @param step - The step definition to execute
   * @param context - Current execution context
   * @returns The step result
   */
  private stepExecutor: (step: Step, context: ExecutionContext) => StepResult | Promise<StepResult>;

  constructor(
    indexManager: IndexManager,
    loader: PrimeLoader,
    evaluator: EvaluationEngine,
    stepExecutor?: (step: Step, context: ExecutionContext) => StepResult | Promise<StepResult>,
    methodLoader?: MethodLoader,
  ) {
    this.indexManager = indexManager;
    this.loader = loader;
    this.evaluator = evaluator;
    this.stepExecutor = stepExecutor ?? this.defaultStepExecutor;
    this.methodLoader = methodLoader ?? null;
  }

  /**
   * Execute a Prime by name with the given inputs.
   *
   * Runs through all 7 phases:
   * MATCH -> REQUIRE -> LOAD -> EXECUTE -> VALIDATE -> EVALUATE -> REPORT
   *
   * @param primeName - The Prime identifier to execute
   * @param inputs    - Input values (key-value pairs matching the Prime's input params)
   * @returns ExecutionResult with outputs, state, and evaluation
   */
  async execute(
    primeName: string,
    inputs: Record<string, any>,
  ): Promise<ExecutionResult> {
    // Initialize execution state
    const state: ExecutionState = {
      prime: primeName,
      status: "pending",
      current_step: null,
      steps_completed: [],
      loop_iteration: 0,
      errors_encountered: [],
      loaded_level: 0,
      loaded_blocks: [],
      dependencies_loaded: [],
      evaluation_result: null,
    };

    const context: ExecutionContext = {
      outputs: {},
      step_results: [],
      inputs,
    };

    try {
      // Phase 1: MATCH
      const entry = this.indexManager.getEntry(primeName);
      if (!entry) {
        state.status = "error";
        return {
          success: false,
          state,
          outputs: {},
          evaluation: undefined,
        };
      }

      // Phase 2: LOAD — resolve and load dependencies
      state.status = "loading";
      const loadSteps = this.loader.resolveLoadOrder(primeName);
      for (const ls of loadSteps) {
        try {
          this.loader.loadPrime(ls.name, ls.level);
          state.dependencies_loaded.push(ls.name);
        } catch {
          // Non-critical: dependency might not have compiled artifacts
        }
      }
      state.loaded_level = 1;

      // Phase 3: REQUIRE — check preconditions
      // We need the Method definition. Try to parse it from L2 content.
      const method = this.loadMethodDefinition(primeName);
      if (method) {
        const reqResult = this.checkRequirements(method, inputs);
        if (!reqResult.satisfied) {
          state.status = "error";
          const failedChecks = reqResult.checks
            .filter((c) => !c.met)
            .map((c) => c.error ?? c.condition);
          state.errors_encountered.push({
            step: "REQUIRE",
            message: `Preconditions not met: ${failedChecks.join("; ")}`,
            handled: false,
          });
          return {
            success: false,
            state,
            outputs: {},
          };
        }

        // Phase 4: EXECUTE — run steps
        state.status = "executing";
        const maxIterations = method.loop?.max_iterations ?? 1;

        for (
          let iteration = 0;
          iteration < maxIterations;
          iteration++
        ) {
          state.loop_iteration = iteration;

          for (const step of method.steps) {
            const stepResult = await this.executeStep(
              step,
              method.branches ?? [],
              context,
              state,
            );

            context.step_results.push(stepResult);

            if (!stepResult.success) {
              // Check if the error was fatal
              const lastError =
                state.errors_encountered[state.errors_encountered.length - 1];
              if (lastError && !lastError.handled) {
                state.status = "error";
                return {
                  success: false,
                  state,
                  outputs: context.outputs,
                };
              }
            }
          }

          // Check loop termination condition (if not last iteration)
          if (method.loop && iteration < maxIterations - 1) {
            // In a real system, the AI would evaluate the "until" condition
            // For the runtime, we always continue unless max_iterations is reached
          }
        }

        // Phase 5: VALIDATE — load and run validation rules
        const afterSteps = loadSteps.filter((ls) => ls.phase === "after");
        for (const ls of afterSteps) {
          try {
            this.loader.loadPrime(ls.name, ls.level);
          } catch {
            // Validation rule not available
          }
        }

        // Phase 6: EVALUATE
        state.status = "evaluating";
        const evalConfig = this.buildEvalConfig(method);
        if (evalConfig) {
          const report = this.evaluator.evaluate(evalConfig, context);
          state.evaluation_result = report;
        }
      } else {
        // No Method definition available — execute at a basic level
        state.status = "executing";
        // Without a Method definition, just mark as done
      }

      // Phase 7: REPORT
      state.status = "done";
      state.current_step = null;

      return {
        success: true,
        state,
        outputs: context.outputs,
        evaluation: state.evaluation_result ?? undefined,
      };
    } catch (err) {
      state.status = "error";
      state.errors_encountered.push({
        step: state.current_step ?? "unknown",
        message: err instanceof Error ? err.message : String(err),
        handled: false,
      });
      return {
        success: false,
        state,
        outputs: context.outputs,
      };
    }
  }

  /**
   * Check all preconditions for a Method against the given inputs.
   *
   * Each precondition's condition string is matched against the inputs:
   * - If the condition references an input name, check the input exists
   * - If the condition is a general requirement, evaluate it as met
   *   (in a real system, the AI would evaluate this)
   */
  checkRequirements(
    prime: Method,
    inputs: Record<string, any>,
  ): RequirementResult {
    if (!prime.require || prime.require.length === 0) {
      return { satisfied: true, checks: [] };
    }

    const checks: RequirementCheck[] = prime.require.map((req) => {
      // Simple heuristic: check if any input parameter names appear in the condition
      const met = this.evaluateCondition(req.condition, inputs);
      return {
        condition: req.condition,
        met,
        error: met ? undefined : req.error_if_unmet,
      };
    });

    return {
      satisfied: checks.every((c) => c.met),
      checks,
    };
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * Execute a single step with error handling.
   */
  private async executeStep(
    step: Step,
    branches: Branch[],
    context: ExecutionContext,
    state: ExecutionState,
  ): Promise<StepResult> {
    state.current_step = step.name;

    // Execute the step
    let result = await this.stepExecutor(step, context);
    let retries = 0;

    // If step failed, apply error handling
    if (!result.success) {
      const handled = await this.handleStepError(step, branches, context, state, result);
      result = handled.result;
      retries = handled.retries;
    }

    // Execute sub-steps if present
    if (step.sub_steps && result.success) {
      for (const sub of step.sub_steps) {
        const subResult = await this.executeStep(sub, branches, context, state);
        context.step_results.push(subResult);
        if (!subResult.success) {
          // Propagate sub-step failure
          result.success = false;
          result.error = subResult.error;
          break;
        }
      }
    }

    if (result.success) {
      state.steps_completed.push(step.name);
    }

    return {
      ...result,
      retries: retries > 0 ? retries : undefined,
    };
  }

  /**
   * Handle a step error using the error handling hierarchy:
   * 1. Step.error_handler (retry, fallback, @safe)
   * 2. Method.branches (match condition)
   * 3. Report unhandled
   */
  private async handleStepError(
    step: Step,
    branches: Branch[],
    context: ExecutionContext,
    state: ExecutionState,
    initialResult: StepResult,
  ): Promise<{ result: StepResult; retries: number }> {
    let retries = 0;
    let result = initialResult;
    const handler = step.error_handler;

    // Layer 1: Step-level error handler
    if (handler === "@safe") {
      // @safe — ignore the error
      state.errors_encountered.push({
        step: step.name,
        message: result.error?.message ?? "Step failed",
        handled: true,
        handler: "@safe",
      });
      return {
        result: { ...result, success: true },
        retries: 0,
      };
    }

    if (typeof handler === "object" && handler !== null) {
      // Structured error handler with retry/fallback
      const maxRetries = handler.retry ?? 0;

      while (retries < maxRetries) {
        retries++;
        result = await this.stepExecutor(step, context);
        if (result.success) {
          state.errors_encountered.push({
            step: step.name,
            message: `Retry ${retries}/${maxRetries} succeeded`,
            handled: true,
            handler: `retry(${retries})`,
          });
          return { result, retries };
        }
      }

      // Retries exhausted — try fallback
      if (handler.fallback) {
        state.errors_encountered.push({
          step: step.name,
          message: `Retries exhausted, executing fallback: ${handler.fallback}`,
          handled: true,
          handler: `fallback: ${handler.fallback}`,
        });
        return {
          result: {
            name: step.name,
            success: true,
            output: `Fallback: ${handler.fallback}`,
          },
          retries,
        };
      }

      // No fallback — escalate
      if (handler.escalate) {
        state.errors_encountered.push({
          step: step.name,
          message: handler.escalate,
          handled: false,
          handler: "escalate",
        });
      } else {
        state.errors_encountered.push({
          step: step.name,
          message: handler.message,
          handled: false,
        });
      }
      return { result, retries };
    }

    // Simple string error handler
    if (typeof handler === "string") {
      state.errors_encountered.push({
        step: step.name,
        message: handler,
        handled: false,
      });
    }

    // Layer 2: Method-level branches
    for (const branch of branches) {
      if (this.matchBranchCondition(branch.condition, step, context)) {
        state.errors_encountered.push({
          step: step.name,
          message: `Branch matched: ${branch.condition} -> ${branch.action}`,
          handled: true,
          handler: `branch: ${branch.action}`,
        });
        return {
          result: {
            name: step.name,
            success: true,
            output: `Branch action: ${branch.action}`,
          },
          retries,
        };
      }
    }

    // Unhandled error
    if (state.errors_encountered.length === 0 ||
        state.errors_encountered[state.errors_encountered.length - 1].step !== step.name) {
      state.errors_encountered.push({
        step: step.name,
        message: result.error?.message ?? "Step failed (unhandled)",
        handled: false,
      });
    }

    return { result, retries };
  }

  /**
   * Match a branch condition against the current execution context.
   * Uses simple keyword matching on the condition text.
   */
  private matchBranchCondition(
    condition: string,
    step: Step,
    context: ExecutionContext,
  ): boolean {
    const lowerCondition = condition.toLowerCase();
    const stepName = step.name.toLowerCase();

    // Check if the condition references the current step
    if (lowerCondition.includes(stepName)) {
      // Check if the condition matches the failure scenario
      if (
        lowerCondition.includes("fail") ||
        lowerCondition.includes("error") ||
        lowerCondition.includes("failed")
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Evaluate a precondition against inputs.
   */
  private evaluateCondition(
    condition: string,
    inputs: Record<string, any>,
  ): boolean {
    const lowerCondition = condition.toLowerCase();

    // Check if the condition references input parameters that exist
    for (const [key, value] of Object.entries(inputs)) {
      if (lowerCondition.includes(key.toLowerCase())) {
        // The condition mentions this input — check it has a value
        if (value === undefined || value === null || value === "") {
          return false;
        }
      }
    }

    // If the condition mentions "recognized" or "available", check inputs exist
    if (lowerCondition.includes("recognized") || lowerCondition.includes("available")) {
      return Object.keys(inputs).length > 0;
    }

    // Default: consider the condition met (AI would evaluate in real system)
    return true;
  }

  /**
   * Default step executor — EXPLICIT NO-OP.
   *
   * Prior behavior (removed 2026-04-17) silently returned success:true with
   * a fake "Executed: ..." output, which caused tests to pass even when no
   * real step execution happened. That masked the fact that PrimeExecutor
   * has no built-in AI connection — the step executor MUST be injected.
   *
   * Current behavior: return success:false with a loud error so callers
   * can't accidentally run a no-op Prime to completion. Use
   * `createAIStepExecutor()` to get a working implementation.
   */
  private defaultStepExecutor(step: Step, _context: ExecutionContext): StepResult {
    return {
      name: step.name,
      success: false,
      error: {
        step: step.name,
        message: `PrimeExecutor has no step executor wired up — step "${step.name}" cannot run. ` +
          `Construct PrimeExecutor with a real executor: ` +
          `new PrimeExecutor(index, loader, evaluator, createAIStepExecutor({...}))`,
        handled: false,
      },
    };
  }

  /**
   * Load a Method definition by id.
   *
   * Three fallback paths, in order:
   * 1. injected MethodLoader (reads compile-all.ts methods.json)
   * 2. verbatim id match from the compiled artifact pool
   * 3. null — caller must use executeMethod(method, inputs) with a
   *    materialized Method object
   */
  private loadMethodDefinition(name: string): Method | null {
    if (this.methodLoader) {
      const direct = this.methodLoader.getMethod(name);
      if (direct) return direct;
      // Try @namespace/slug vs plain slug — callers may pass either form
      if (!name.startsWith("@")) {
        for (const id of this.methodLoader.ids()) {
          if (id.endsWith(`/${name}`)) return this.methodLoader.getMethod(id);
        }
      }
    }
    return null;
  }

  /**
   * Build evaluation config from a Method's criteria.
   */
  private buildEvalConfig(method: Method): PrimeEvaluationConfig | null {
    if (!method.success_criteria || method.success_criteria.length === 0) {
      return null;
    }

    return {
      success_criteria: {
        mode: "weighted",
        min_score: 0.8,
        criteria: method.success_criteria.map((c, i) => ({
          id: `criterion_${i}`,
          description: c.description,
          decidability:
            c.decidability === "@decidable" ? ("decidable" as const) : ("subjective" as const),
          weight: 1.0 / method.success_criteria!.length,
        })),
      },
      failure_criteria: method.failure_criteria
        ? {
            mode: "any" as const,
            criteria: method.failure_criteria.map((c, i) => ({
              id: `failure_${i}`,
              description: c.description,
              decidability:
                c.decidability === "@decidable"
                  ? ("decidable" as const)
                  : ("subjective" as const),
              weight: 1.0,
            })),
          }
        : undefined,
    };
  }

  /**
   * Execute a Method directly (without loading from disk).
   * Useful when the Method object is already available.
   */
  async executeMethod(
    method: Method,
    inputs: Record<string, any>,
  ): Promise<ExecutionResult> {
    const state: ExecutionState = {
      prime: method.name,
      status: "pending",
      current_step: null,
      steps_completed: [],
      loop_iteration: 0,
      errors_encountered: [],
      loaded_level: 2,
      loaded_blocks: [],
      dependencies_loaded: [],
      evaluation_result: null,
    };

    const context: ExecutionContext = {
      outputs: {},
      step_results: [],
      inputs,
    };

    try {
      // Phase 3: REQUIRE
      const reqResult = this.checkRequirements(method, inputs);
      if (!reqResult.satisfied) {
        state.status = "error";
        const failedChecks = reqResult.checks
          .filter((c) => !c.met)
          .map((c) => c.error ?? c.condition);
        state.errors_encountered.push({
          step: "REQUIRE",
          message: `Preconditions not met: ${failedChecks.join("; ")}`,
          handled: false,
        });
        return { success: false, state, outputs: {} };
      }

      // Phase 4: EXECUTE
      state.status = "executing";
      const maxIterations = method.loop?.max_iterations ?? 1;

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        state.loop_iteration = iteration;

        for (const step of method.steps) {
          const stepResult = await this.executeStep(
            step,
            method.branches ?? [],
            context,
            state,
          );
          context.step_results.push(stepResult);

          if (!stepResult.success) {
            const lastError =
              state.errors_encountered[state.errors_encountered.length - 1];
            if (lastError && !lastError.handled) {
              state.status = "error";
              return { success: false, state, outputs: context.outputs };
            }
          }
        }
      }

      // Phase 6: EVALUATE
      state.status = "evaluating";
      const evalConfig = this.buildEvalConfig(method);
      if (evalConfig) {
        const report = this.evaluator.evaluate(evalConfig, context);
        state.evaluation_result = report;
      }

      // Phase 7: REPORT
      state.status = "done";
      state.current_step = null;

      return {
        success: true,
        state,
        outputs: context.outputs,
        evaluation: state.evaluation_result ?? undefined,
      };
    } catch (err) {
      state.status = "error";
      state.errors_encountered.push({
        step: state.current_step ?? "unknown",
        message: err instanceof Error ? err.message : String(err),
        handled: false,
      });
      return { success: false, state, outputs: context.outputs };
    }
  }
}
