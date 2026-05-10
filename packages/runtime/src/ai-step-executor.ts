/**
 * @module ai-step-executor
 *
 * Factory that produces a step executor bound to an AI chat completion API.
 * Wires the executor into the Anthropic / OpenAI / DeepSeek chat format.
 *
 * Usage:
 *   const stepExec = createAIStepExecutor({
 *     endpoint: "https://api.anthropic.com/v1/messages",
 *     apiKey: process.env.ANTHROPIC_API_KEY!,
 *     model: "claude-sonnet-4-6",
 *     provider: "anthropic",
 *   });
 *   const executor = new PrimeExecutor(indexManager, loader, evaluator, stepExec);
 */

import type { Step } from "@prime-lang/types";
import type { ExecutionContext, StepResult } from "./types";

export type AIProvider = "anthropic" | "openai" | "deepseek";

export interface AIStepExecutorOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  provider: AIProvider;
  /** Optional system prompt prefix; appended before step-specific instructions */
  systemPreamble?: string;
  /** Request timeout in ms (default 60000) */
  timeoutMs?: number;
  /** Maximum tokens to sample (default 1024) */
  maxTokens?: number;
}

const DEFAULT_SYSTEM = `You are a Prime step executor. Each turn you receive ONE step from a Method and the current execution context. You perform that single step and return its output verbatim — no preamble, no chain-of-thought, no markdown headers unless the step asks for them.

If the step asks you to analyze, return the analysis.
If it asks you to generate code, return the code.
If it asks you to decide, return the decision with a one-line rationale.

If you cannot complete the step, return a line starting with "STEP_FAILED:" followed by a short reason.`;

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

interface OpenAICompatibleResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

/**
 * Build the chat message payload for a single step execution.
 */
function buildMessages(step: Step, context: ExecutionContext, provider: AIProvider) {
  const contextLines = [
    `INPUTS: ${JSON.stringify(context.inputs, null, 2)}`,
    context.step_results.length > 0
      ? `PRIOR_STEP_OUTPUTS: ${JSON.stringify(
          context.step_results.map((r) => ({ name: r.name, output: r.output })),
          null,
          2,
        )}`
      : null,
  ].filter(Boolean);

  const userContent = [
    `STEP: ${step.name}`,
    `DESCRIPTION: ${step.description}`,
    step.expect ? `EXPECT: ${JSON.stringify(step.expect)}` : null,
    ...contextLines,
    ``,
    `Perform this step. Return only the step output.`,
  ]
    .filter(Boolean)
    .join("\n");

  if (provider === "anthropic") {
    return {
      messages: [{ role: "user", content: userContent }],
    };
  }
  return {
    messages: [
      { role: "system", content: DEFAULT_SYSTEM },
      { role: "user", content: userContent },
    ],
  };
}

/**
 * Parse a response from any of the three providers into a plain text output.
 */
function parseResponse(data: unknown, provider: AIProvider): string {
  if (provider === "anthropic") {
    const resp = data as AnthropicResponse;
    const block = resp.content?.find((c) => c.type === "text");
    return block?.text ?? "";
  }
  const resp = data as OpenAICompatibleResponse;
  return resp.choices?.[0]?.message?.content ?? "";
}

/**
 * Create a step executor backed by an LLM chat API.
 */
export function createAIStepExecutor(
  opts: AIStepExecutorOptions,
): (step: Step, context: ExecutionContext) => Promise<StepResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const maxTokens = opts.maxTokens ?? 1024;
  const systemPrompt = opts.systemPreamble
    ? `${opts.systemPreamble}\n\n${DEFAULT_SYSTEM}`
    : DEFAULT_SYSTEM;

  return async (step, context) => {
    const payload = buildMessages(step, context, opts.provider);
    const body: Record<string, unknown> =
      opts.provider === "anthropic"
        ? {
            model: opts.model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: payload.messages,
          }
        : {
            model: opts.model,
            max_tokens: maxTokens,
            messages: payload.messages,
          };

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.provider === "anthropic") {
      headers["x-api-key"] = opts.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${opts.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        return {
          name: step.name,
          success: false,
          error: {
            step: step.name,
            message: `AI step executor HTTP ${res.status}: ${errText.slice(0, 500)}`,
            handled: false,
          },
        };
      }
      const data = await res.json();
      const output = parseResponse(data, opts.provider).trim();

      if (output.startsWith("STEP_FAILED:")) {
        return {
          name: step.name,
          success: false,
          output,
          error: {
            step: step.name,
            message: output.replace(/^STEP_FAILED:\s*/, ""),
            handled: false,
          },
        };
      }
      return { name: step.name, success: true, output };
    } catch (err) {
      return {
        name: step.name,
        success: false,
        error: {
          step: step.name,
          message: err instanceof Error ? err.message : String(err),
          handled: false,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * A mock step executor for tests — returns deterministic success outputs.
 * Clearly separate from defaultStepExecutor (which is now a loud no-op).
 */
export function createMockStepExecutor(
  outputs: Record<string, string> = {},
): (step: Step, context: ExecutionContext) => StepResult {
  return (step) => ({
    name: step.name,
    success: true,
    output: outputs[step.name] ?? `[mock] ${step.description}`,
  });
}
