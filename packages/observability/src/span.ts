/**
 * @module span
 *
 * The tracing SPI. It is shaped after the OpenTelemetry *API* surface — span
 * kinds, status codes, attribute value domain, span events, W3C trace context —
 * and deliberately not after any OpenTelemetry *SDK*.
 *
 * Why an API package rather than a direct dependency on `@opentelemetry/api`:
 * the same reason that package exists at all. An engine package must be able to
 * emit a span without pulling a tracer implementation, an exporter, a batching
 * processor or a global registration side effect into its dependency closure.
 * The wire format we owe the outside world is OTLP (`./otlp.ts` emits it
 * verbatim), and OTLP is a protocol, not a library — so the protocol is what
 * this package implements. Swapping in `@opentelemetry/api` later is a change to
 * `./tracer.ts` only, because nothing outside this package names a span class.
 *
 * Everything here is structural: there is not one domain name, and not one
 * hardcoded span name. A caller names its own spans, exactly as it names its own
 * attributes.
 */

/** OTLP `AnyValue`, restricted to what a span attribute may hold. */
export type AttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type Attributes = Readonly<Record<string, AttributeValue>>;

/**
 * OTLP `SpanKind`, minus `SPAN_KIND_UNSPECIFIED`. Unspecified is absent because
 * every call site here knows whether it is serving a request, making one, or
 * doing work in-process, and an "unspecified" default is how that knowledge gets
 * dropped.
 */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/**
 * OTLP `StatusCode`. `unset` is the correct state for a span that completed
 * without the caller making a claim about it — it is not a synonym for `ok`,
 * and collapsing the two would make "nobody checked" indistinguishable from
 * "checked and fine".
 */
export type SpanStatusCode = "unset" | "ok" | "error";

export interface SpanStatus {
  readonly code: SpanStatusCode;
  readonly message?: string;
}

/**
 * W3C trace context identity. Hex, lowercase, 32/16 characters — the same
 * encoding `traceparent` uses, so `./trace-context.ts` can format one without a
 * conversion step that could normalise differently in each direction.
 */
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  /** W3C `trace-flags`; bit 0 is "sampled". */
  readonly traceFlags: number;
  readonly parentSpanId?: string;
}

export interface SpanEvent {
  readonly name: string;
  readonly timeUnixNano: bigint;
  readonly attributes: Attributes;
}

export interface StartSpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  /**
   * Explicit parent. Omitting it makes the span a root, which is why it is
   * required to be explicit: an ambient "current span" global is what makes a
   * trace depend on execution context the type system cannot see, and every
   * async boundary in this repo would be a place for it to silently detach.
   */
  readonly parent?: SpanContext;
}

export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttributeValue): void;
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  setStatus(status: SpanStatus): void;
  /**
   * Records the exception as an OTLP `exception` event *and* sets the status to
   * `error`. The two are not separable: a span carrying an exception event but an
   * `unset` status reads as a success in every backend's error rate.
   */
  recordException(error: unknown): void;
  /** Idempotent. A second call is ignored rather than moving `endTimeUnixNano`. */
  end(attributes?: Attributes): void;
}

export interface Tracer {
  startSpan(name: string, options?: StartSpanOptions): Span;
}

/** A finished span, as a plain value. This is what an exporter receives. */
export interface RecordedSpan {
  readonly name: string;
  readonly kind: SpanKind;
  readonly context: SpanContext;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly attributes: Attributes;
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
}

export interface SpanSink {
  /** Called once per span, at `end()`. */
  accept(span: RecordedSpan): void;
}

/**
 * The OTLP `exception.*` attribute names. Quoted here once so a backend's
 * built-in exception handling actually fires: these keys are part of the
 * protocol's semantic conventions, not names this repo chose.
 */
export const EXCEPTION_EVENT_NAME = "exception";
export const EXCEPTION_TYPE_KEY = "exception.type";
export const EXCEPTION_MESSAGE_KEY = "exception.message";
export const EXCEPTION_STACKTRACE_KEY = "exception.stacktrace";
