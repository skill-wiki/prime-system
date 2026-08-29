/**
 * @module otlp
 *
 * OTLP/HTTP JSON encoding and export.
 *
 * This is the part that makes the word "OpenTelemetry" honest. The SPI in
 * `./span.ts` is OTel-*shaped*; this module emits the actual wire format defined
 * by `opentelemetry/proto/trace/v1/trace.proto` under the protobuf JSON mapping,
 * so any OTLP receiver — the Collector, Jaeger, Tempo, a vendor endpoint —
 * accepts it without a translation layer.
 *
 * Three details of that mapping are easy to get wrong and are therefore encoded
 * here rather than left to a caller:
 *
 * - `traceId` / `spanId` are lowercase hex strings in JSON (they are `bytes` in
 *   protobuf, and the JSON mapping for a trace id is hex, *not* base64 as the
 *   generic protobuf-JSON rule for `bytes` would suggest).
 * - 64-bit fields (`startTimeUnixNano`, `intValue`) are JSON *strings*. Emitting
 *   them as numbers silently truncates past 2^53, which for a nanosecond
 *   timestamp is every timestamp.
 * - `kind` and `status.code` are enum *numbers*, not the names used in the SPI.
 */

import type { Attributes, AttributeValue, RecordedSpan, SpanKind, SpanStatusCode } from "./span.ts";

/** `opentelemetry.proto.trace.v1.Span.SpanKind`. */
const SPAN_KIND_CODE: Readonly<Record<SpanKind, number>> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

/** `opentelemetry.proto.trace.v1.Status.StatusCode`. */
const STATUS_CODE: Readonly<Record<SpanStatusCode, number>> = {
  unset: 0,
  ok: 1,
  error: 2,
};

export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } };

export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export interface OtlpTracePayload {
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly OtlpKeyValue[] };
    readonly scopeSpans: readonly {
      readonly scope: { readonly name: string; readonly version?: string };
      readonly spans: readonly Readonly<Record<string, unknown>>[];
    }[];
  }[];
}

function scalarToAnyValue(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  // A whole number is an `intValue`; anything else is a double. Sending every
  // number as a double is lossless for the value but loses the type, and a
  // backend that facets on an attribute then sees `3` and `3.0` as two values.
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

export function toAnyValue(value: AttributeValue): OtlpAnyValue {
  if (Array.isArray(value)) {
    return { arrayValue: { values: (value as readonly (string | number | boolean)[]).map(scalarToAnyValue) } };
  }
  return scalarToAnyValue(value as string | number | boolean);
}

export function toKeyValues(attributes: Attributes): readonly OtlpKeyValue[] {
  return Object.entries(attributes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

function encodeSpan(span: RecordedSpan): Readonly<Record<string, unknown>> {
  const encoded: Record<string, unknown> = {
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    name: span.name,
    kind: SPAN_KIND_CODE[span.kind],
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    attributes: toKeyValues(span.attributes),
    events: span.events.map(event => ({
      name: event.name,
      timeUnixNano: event.timeUnixNano.toString(),
      attributes: toKeyValues(event.attributes),
    })),
    status: span.status.message === undefined
      ? { code: STATUS_CODE[span.status.code] }
      : { code: STATUS_CODE[span.status.code], message: span.status.message },
  };
  // Omitted rather than sent as an empty string: an empty `parentSpanId` is how a
  // root span is expressed, and some receivers reject the explicit empty field.
  if (span.context.parentSpanId !== undefined) encoded.parentSpanId = span.context.parentSpanId;
  return encoded;
}

export interface OtlpResource {
  readonly attributes: Attributes;
}

export interface InstrumentationScope {
  readonly name: string;
  readonly version?: string;
}

export function toOtlpTracePayload(
  spans: readonly RecordedSpan[],
  options: { readonly resource: OtlpResource; readonly scope: InstrumentationScope },
): OtlpTracePayload {
  return {
    resourceSpans: [{
      resource: { attributes: toKeyValues(options.resource.attributes) },
      scopeSpans: [{
        scope: options.scope.version === undefined
          ? { name: options.scope.name }
          : { name: options.scope.name, version: options.scope.version },
        spans: spans.map(encodeSpan),
      }],
    }],
  };
}

export interface OtlpExporterOptions {
  /** Full OTLP/HTTP traces endpoint, e.g. `http://127.0.0.1:4318/v1/traces`. */
  readonly endpoint: string;
  readonly resource: OtlpResource;
  readonly scope: InstrumentationScope;
  readonly headers?: Readonly<Record<string, string>>;
  /** Injected so a test can assert on the request without opening a socket. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Called when an export fails. Defaults to swallowing the failure: a telemetry
   * backend being down must not take a query with it. It is a parameter rather
   * than a hardcoded `catch {}` so an operator can choose to see it — silent
   * telemetry loss is the failure mode that makes a dashboard confidently wrong.
   */
  readonly onError?: (error: unknown) => void;
}

export interface SpanExporter {
  export(spans: readonly RecordedSpan[]): Promise<void>;
}

export function createOtlpHttpExporter(options: OtlpExporterOptions): SpanExporter {
  const send = options.fetch ?? globalThis.fetch;
  const onError = options.onError ?? ((): void => {});
  return {
    export: async (spans: readonly RecordedSpan[]): Promise<void> => {
      if (spans.length === 0) return;
      try {
        const response = await send(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...(options.headers ?? {}) },
          body: JSON.stringify(toOtlpTracePayload(spans, { resource: options.resource, scope: options.scope })),
        });
        if (!response.ok) onError(new Error(`OTLP endpoint answered ${response.status}`));
      } catch (error) {
        onError(error);
      }
    },
  };
}

/**
 * A sink that buffers finished spans and exports them in batches.
 *
 * `flush` is public and returns a promise because a short-lived process — a CLI
 * invocation, a test — must be able to await delivery. An exporter that only
 * flushes on a timer loses the last batch of every process that exits promptly,
 * which is most of them.
 */
export class BatchingSpanSink {
  private buffer: RecordedSpan[] = [];
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly exporter: SpanExporter,
    private readonly maxBatchSize: number = 128,
  ) {}

  accept(span: RecordedSpan): void {
    this.buffer.push(span);
    if (this.buffer.length >= this.maxBatchSize) void this.flush();
  }

  get pending(): number {
    return this.buffer.length;
  }

  flush(): Promise<void> {
    const batch = this.buffer;
    if (batch.length === 0) return this.inFlight;
    this.buffer = [];
    this.inFlight = this.inFlight.then(() => this.exporter.export(batch));
    return this.inFlight;
  }
}
