/**
 * @module tracer
 *
 * Two tracers and one sink.
 *
 * `createRecordingTracer` is the real one: it measures, it records, and it hands
 * every finished span to a sink. `NOOP_TRACER` is the default an engine package
 * uses when no host configured tracing — it allocates one frozen object per span
 * and does nothing else, so an instrumented code path costs the same as an
 * uninstrumented one when nobody is listening. That is what makes it acceptable
 * to put `tracer.startSpan(...)` on the query hot path at all.
 *
 * The clock is injectable for the same reason the id generators are: a test that
 * asserts on span duration or ordering cannot do so against a wall clock, and a
 * test that cannot assert on a span is not evidence the span exists.
 */

import {
  EXCEPTION_EVENT_NAME,
  EXCEPTION_MESSAGE_KEY,
  EXCEPTION_STACKTRACE_KEY,
  EXCEPTION_TYPE_KEY,
  type Attributes,
  type AttributeValue,
  type RecordedSpan,
  type Span,
  type SpanContext,
  type SpanEvent,
  type SpanKind,
  type SpanSink,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "./span.ts";
import { TRACE_FLAG_SAMPLED, generateSpanId, generateTraceId } from "./trace-context.ts";

export interface Clock {
  /** Unix nanoseconds. `bigint` because a millisecond clock cannot express OTLP timestamps without lying about precision. */
  nowUnixNano(): bigint;
}

const MILLIS_TO_NANOS = 1_000_000n;

export const SYSTEM_CLOCK: Clock = {
  nowUnixNano: (): bigint => BigInt(Date.now()) * MILLIS_TO_NANOS,
};

/**
 * A monotonically increasing clock over a fixed origin. Two spans started in the
 * same millisecond get distinct, ordered timestamps, so a test can assert parent
 * spans start before children without sleeping.
 */
export function createStepClock(options: { readonly originUnixNano?: bigint; readonly stepNanos?: bigint } = {}): Clock {
  let now = options.originUnixNano ?? 0n;
  const step = options.stepNanos ?? MILLIS_TO_NANOS;
  return {
    nowUnixNano: (): bigint => {
      now += step;
      return now;
    },
  };
}

export class InMemorySpanSink implements SpanSink {
  private readonly spans: RecordedSpan[] = [];

  accept(span: RecordedSpan): void {
    this.spans.push(span);
  }

  /** Finished spans in completion order. */
  all(): readonly RecordedSpan[] {
    return [...this.spans];
  }

  named(name: string): readonly RecordedSpan[] {
    return this.spans.filter(span => span.name === name);
  }

  names(): readonly string[] {
    return this.spans.map(span => span.name);
  }

  ofTrace(traceId: string): readonly RecordedSpan[] {
    return this.spans.filter(span => span.context.traceId === traceId);
  }

  clear(): void {
    this.spans.length = 0;
  }
}

export interface RecordingTracerOptions {
  readonly sink: SpanSink;
  readonly clock?: Clock;
  readonly newTraceId?: () => string;
  readonly newSpanId?: () => string;
}

class RecordingSpan implements Span {
  readonly context: SpanContext;
  private readonly attributes = new Map<string, AttributeValue>();
  private readonly events: SpanEvent[] = [];
  private status: SpanStatus = { code: "unset" };
  private ended = false;

  constructor(
    private readonly name: string,
    private readonly kind: SpanKind,
    context: SpanContext,
    private readonly startTimeUnixNano: bigint,
    private readonly clock: Clock,
    private readonly sink: SpanSink,
    initial: Attributes,
  ) {
    this.context = context;
    for (const [key, value] of Object.entries(initial)) this.attributes.set(key, value);
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (this.ended) return;
    this.attributes.set(key, value);
  }

  setAttributes(attributes: Attributes): void {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
  }

  addEvent(name: string, attributes: Attributes = {}): void {
    if (this.ended) return;
    this.events.push({ name, timeUnixNano: this.clock.nowUnixNano(), attributes: { ...attributes } });
  }

  setStatus(status: SpanStatus): void {
    if (this.ended) return;
    this.status = status;
  }

  recordException(error: unknown): void {
    if (this.ended) return;
    const attributes: Record<string, AttributeValue> = {
      [EXCEPTION_TYPE_KEY]: error instanceof Error ? error.name : typeof error,
      [EXCEPTION_MESSAGE_KEY]: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof Error && typeof error.stack === "string") {
      attributes[EXCEPTION_STACKTRACE_KEY] = error.stack;
    }
    this.addEvent(EXCEPTION_EVENT_NAME, attributes);
    this.setStatus({
      code: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  end(attributes: Attributes = {}): void {
    // A double `end` is a caller bug, but throwing here would turn an
    // instrumentation mistake into a request failure. Ignoring keeps the first,
    // true duration instead of stretching it to the second call.
    if (this.ended) return;
    this.setAttributes(attributes);
    this.ended = true;
    this.sink.accept({
      name: this.name,
      kind: this.kind,
      context: this.context,
      startTimeUnixNano: this.startTimeUnixNano,
      endTimeUnixNano: this.clock.nowUnixNano(),
      attributes: Object.fromEntries([...this.attributes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      events: [...this.events],
      status: this.status,
    });
  }
}

export function createRecordingTracer(options: RecordingTracerOptions): Tracer {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const newTraceId = options.newTraceId ?? generateTraceId;
  const newSpanId = options.newSpanId ?? generateSpanId;
  return {
    startSpan: (name: string, spanOptions: StartSpanOptions = {}): Span => {
      const parent = spanOptions.parent;
      const context: SpanContext = parent === undefined
        ? { traceId: newTraceId(), spanId: newSpanId(), traceFlags: TRACE_FLAG_SAMPLED }
        : { traceId: parent.traceId, spanId: newSpanId(), traceFlags: parent.traceFlags, parentSpanId: parent.spanId };
      return new RecordingSpan(
        name,
        spanOptions.kind ?? "internal",
        context,
        clock.nowUnixNano(),
        clock,
        options.sink,
        spanOptions.attributes ?? {},
      );
    },
  };
}

const NOOP_CONTEXT: SpanContext = { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };

const NOOP_SPAN: Span = Object.freeze({
  context: NOOP_CONTEXT,
  setAttribute: (): void => {},
  setAttributes: (): void => {},
  addEvent: (): void => {},
  setStatus: (): void => {},
  recordException: (): void => {},
  end: (): void => {},
});

/**
 * The default for every engine package. Its span context is the all-zero
 * "invalid" context from the W3C spec, so a caller that propagates it downstream
 * emits an invalid `traceparent` that a collector drops — rather than a
 * plausible-looking id that would attach real spans to a fabricated trace.
 */
export const NOOP_TRACER: Tracer = Object.freeze({
  startSpan: (): Span => NOOP_SPAN,
});

/**
 * Runs `body` inside a span, ending it exactly once on both paths and recording
 * a thrown error before rethrowing it.
 *
 * Errors propagate unchanged: an exception's identity is part of the engine's
 * contract, and a tracer that wrapped it would make failure handling depend on
 * whether tracing was switched on.
 */
export function withSpan<T>(
  tracer: Tracer,
  name: string,
  options: StartSpanOptions,
  body: (span: Span) => T,
): T {
  const span = tracer.startSpan(name, options);
  try {
    const result = body(span);
    span.end();
    return result;
  } catch (error) {
    span.recordException(error);
    span.end();
    throw error;
  }
}

export async function withAsyncSpan<T>(
  tracer: Tracer,
  name: string,
  options: StartSpanOptions,
  body: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, options);
  try {
    const result = await body(span);
    span.end();
    return result;
  } catch (error) {
    span.recordException(error);
    span.end();
    throw error;
  }
}
