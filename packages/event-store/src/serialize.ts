import { SerializationError } from "./contracts.ts";

/** Marker for a value JSON cannot carry. Kept explicit so replay is auditable. */
export interface UnstorableMarker {
  readonly $unstorable: string;
}

export interface Encoded {
  readonly json: string;
  /** True when at least one leaf was replaced by an `UnstorableMarker`. */
  readonly lossy: boolean;
}

function markerFor(value: unknown): UnstorableMarker {
  if (typeof value === "bigint") return { $unstorable: "bigint" };
  if (typeof value === "function") return { $unstorable: "function" };
  if (typeof value === "symbol") return { $unstorable: "symbol" };
  if (typeof value === "number") return { $unstorable: "non-finite-number" };
  return { $unstorable: typeof value };
}

/**
 * A store cannot fail closed on an unrepresentable run: action-runtime creates
 * and saves a run *before* fingerprinting on the dry-run path
 * (`newRun` at src/index.ts:29 is reached from `executeInner` with `dryRun`
 * true, and its own test feeds `metadata: BigInt(1)` down exactly that path).
 * Throwing there would turn a passing upstream test red, so the default is to
 * tag the leaf and flag the record lossy. `strict` restores fail-closed for
 * callers that would rather lose the write than lose fidelity.
 */
export function encode(value: unknown, strict = false): Encoded {
  let lossy = false;
  const seen = new Set<object>();

  const walk = (input: unknown, path: string): unknown => {
    if (input === null) return null;
    const kind = typeof input;
    if (kind === "string" || kind === "boolean") return input;
    if (kind === "number") {
      if (Number.isFinite(input)) return input;
      if (strict) throw new SerializationError(`${path} is a non-finite number`);
      lossy = true;
      return markerFor(input);
    }
    if (kind === "bigint" || kind === "function" || kind === "symbol") {
      if (strict) throw new SerializationError(`${path} is a ${kind}`);
      lossy = true;
      return markerFor(input);
    }
    if (kind === "undefined") {
      // `undefined` in an object is dropped by JSON anyway; recording it as a
      // marker keeps the shape observable after replay.
      if (strict) throw new SerializationError(`${path} is undefined`);
      lossy = true;
      return markerFor(input);
    }
    const object = input as object;
    if (seen.has(object)) {
      if (strict) throw new SerializationError(`${path} is a cycle`);
      lossy = true;
      return { $unstorable: "cycle" } satisfies UnstorableMarker;
    }
    seen.add(object);
    try {
      if (Array.isArray(input)) return input.map((item, index) => walk(item, `${path}[${index}]`));
      const source = input as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      // Sorted keys so two equal runs encode to identical bytes, which is what
      // makes a digest or a byte-level redaction assertion meaningful.
      for (const key of Object.keys(source).sort()) result[key] = walk(source[key], `${path}.${key}`);
      return result;
    } finally {
      seen.delete(object);
    }
  };

  return { json: JSON.stringify(walk(value, "$")) ?? "null", lossy };
}

export function decode<T>(json: string): T {
  return JSON.parse(json) as T;
}
