import type { RunScope } from "./contracts.ts";

export interface RedactionContext {
  readonly scope: RunScope;
  readonly runId: string;
}

export interface EventRedactionContext extends RedactionContext {
  readonly type: string;
}

/**
 * §12.3: "Secret 不进入 event payload". The hook runs *before* anything reaches
 * a backend, and its output is also what `append()` returns, so an in-process
 * consumer cannot read a value that was withheld from disk.
 */
export interface Redactor {
  event(
    payload: Readonly<Record<string, unknown>>,
    context: EventRedactionContext,
  ): Record<string, unknown>;
  /** Runs also cover secrets: `run.input` and `run.output` are user data. */
  run(run: unknown, context: RedactionContext): unknown;
}

export const identityRedactor: Redactor = {
  event: (payload) => ({ ...payload }),
  run: (run) => run,
};

export const REDACTED = "[redacted]";

/**
 * Field names come from the caller, never from a built-in list: the engine core
 * owns no vocabulary of what is secret (§3.1). Matching is on the property key
 * at any depth, case-insensitively, because a model may spell the same field
 * `apiKey` in one place and `apikey` in another.
 */
export function fieldRedactor(fieldNames: readonly string[], marker: string = REDACTED): Redactor {
  const targets = new Set(fieldNames.map((name) => name.toLowerCase()));

  const walk = (value: unknown, seen: Set<object>): unknown => {
    if (value === null || typeof value !== "object") return value;
    const object = value as object;
    if (seen.has(object)) return value;
    seen.add(object);
    try {
      if (Array.isArray(value)) return value.map((item) => walk(item, seen));
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        result[key] = targets.has(key.toLowerCase()) ? marker : walk(source[key], seen);
      }
      return result;
    } finally {
      seen.delete(object);
    }
  };

  return {
    event: (payload) => walk(payload, new Set()) as Record<string, unknown>,
    run: (run) => walk(run, new Set()),
  };
}

/** Composes redactors left to right. */
export function composeRedactors(...redactors: readonly Redactor[]): Redactor {
  return {
    event: (payload, context) =>
      redactors.reduce<Record<string, unknown>>(
        (current, redactor) => redactor.event(current, context),
        { ...payload },
      ),
    run: (run, context) => redactors.reduce((current, redactor) => redactor.run(current, context), run),
  };
}
