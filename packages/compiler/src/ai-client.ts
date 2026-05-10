/**
 * @module ai-client
 * Thin wrapper around the Anthropic Messages API using raw fetch().
 *
 * Design principles:
 * - Zero external dependencies (no SDK)
 * - Graceful degradation: if no API key or API failure, returns empty string
 * - Never blocks compilation — AI checks are best-effort
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type AIProvider = "anthropic" | "deepseek" | "openai";

export interface AIClientOptions {
  /** API key. Resolved from env vars per-provider when omitted:
   *  - anthropic → ANTHROPIC_API_KEY
   *  - deepseek  → DEEPSEEK_API_KEY
   *  - openai    → OPENAI_API_KEY
   */
  apiKey?: string;
  /**
   * Model identifier. The provider is auto-detected from the prefix:
   * - "claude-..."   → anthropic
   * - "deepseek-..." → deepseek
   * - "gpt-..."      → openai
   * Override via `provider`.
   */
  model?: string;
  /** Override the auto-detected provider. */
  provider?: AIProvider;
  /** Maximum tokens in the response. Defaults to 4096. */
  maxTokens?: number;
  /** Request timeout in milliseconds. Defaults to 30000 (30s). */
  timeoutMs?: number;
}

/** Default models for each check level.
 *  These are the upgrade points: switch L2 to a cheaper / faster model
 *  by changing the env var PRIME_L2_MODEL (e.g. PRIME_L2_MODEL=deepseek-chat). */
export const AI_MODELS = {
  L2: getEnvModel("PRIME_L2_MODEL", "claude-haiku-4-5-20251001"),
  L3: getEnvModel("PRIME_L3_MODEL", "claude-sonnet-4-6"),
} as const;

function getEnvModel(varName: string, fallback: string): string {
  try {
    return ((globalThis as any).process?.env?.[varName] as string) || fallback;
  } catch {
    return fallback;
  }
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Helpers ──────────────────────────────────────────────────────────────

function detectProvider(model: string): AIProvider {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  return "anthropic"; // default
}

function envKey(provider: AIProvider): string {
  return {
    anthropic: "ANTHROPIC_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    openai: "OPENAI_API_KEY",
  }[provider];
}

/**
 * Resolve the API key from options or environment.
 * Returns undefined if no key is available.
 */
function resolveApiKey(options?: AIClientOptions, provider?: AIProvider): string | undefined {
  if (options?.apiKey) return options.apiKey;
  const p = provider ?? "anthropic";
  try {
    const env = (globalThis as any).process?.env;
    if (!env) return undefined;
    // Try the provider-specific key first, then ANTHROPIC_API_KEY as legacy
    return env[envKey(p)] || env.ANTHROPIC_API_KEY || undefined;
  } catch {
    return undefined;
  }
}

// ─── Main Function ────────────────────────────────────────────────────────

/**
 * Call the Anthropic Messages API with a single user prompt.
 *
 * Returns the assistant's text response, or an empty string if:
 * - No API key is configured
 * - The API call fails for any reason
 * - The response cannot be parsed
 *
 * This ensures compilation never blocks on AI availability.
 *
 * @param prompt - The user message to send
 * @param options - Optional configuration overrides
 * @returns The assistant's text response, or "" on any failure
 */
export async function callAI(
  prompt: string,
  options?: AIClientOptions
): Promise<string> {
  const model = options?.model ?? AI_MODELS.L2;
  const provider = options?.provider ?? detectProvider(model);
  const apiKey = resolveApiKey(options, provider);
  if (!apiKey) {
    return "";
  }

  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build provider-specific request
  const { url, headers, body } = buildRequest(provider, apiKey, model, prompt, maxTokens);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.warn(
        `[prime-compiler] ${provider} API returned ${response.status}: ${errorBody.slice(0, 200)}`
      );
      return "";
    }

    const data = await response.json();
    return parseResponse(provider, data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.warn(`[prime-compiler] ${provider} API call failed: ${message}`);
    return "";
  }
}

function buildRequest(
  provider: AIProvider,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number
): { url: string; headers: Record<string, string>; body: any } {
  if (provider === "anthropic") {
    return {
      url: ANTHROPIC_URL,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      },
    };
  }
  // OpenAI-compatible (DeepSeek + OpenAI use the same chat/completions schema)
  const url = provider === "deepseek" ? DEEPSEEK_URL : OPENAI_URL;
  return {
    url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
  };
}

function parseResponse(provider: AIProvider, data: any): string {
  if (data?.error) {
    console.warn(
      `[prime-compiler] ${provider} API error: ${data.error.message ?? data.error}`
    );
    return "";
  }
  if (provider === "anthropic") {
    if (Array.isArray(data?.content)) {
      const textBlock = data.content.find((b: any) => b.type === "text");
      return textBlock?.text ?? "";
    }
    return "";
  }
  // OpenAI-compatible
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * Check whether *any* supported provider has an API key configured.
 * Useful for skipping AI checks early and printing a user-friendly message.
 */
export function hasApiKey(options?: AIClientOptions): boolean {
  if (options?.apiKey) return true;
  try {
    const env = (globalThis as any).process?.env;
    if (!env) return false;
    return Boolean(
      env.ANTHROPIC_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY
    );
  } catch {
    return false;
  }
}
