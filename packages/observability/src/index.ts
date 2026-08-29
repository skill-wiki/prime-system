/**
 * @module @skill-wiki/observability
 *
 * The engine's tracing API package (plan §5 telemetry, Phase 5 "接
 * OpenTelemetry"). It plays the role `@opentelemetry/api` plays in an OTel
 * deployment: a dependency an engine package can take without acquiring an
 * exporter, a batching processor, a global registry or a startup side effect.
 *
 * Layering, which is the whole point:
 *
 *   engine packages  -> `Tracer` / `Span` / `NOOP_TRACER`   (this package, SPI only)
 *   host / server    -> `createRecordingTracer` + an exporter (this package, impl)
 *   collector        -> OTLP/HTTP JSON                       (`./otlp.ts`)
 *
 * An engine package therefore never decides *whether* telemetry is collected or
 * *where* it goes; it only decides what a span is called and what it says. The
 * default is `NOOP_TRACER`, so an unconfigured deployment emits nothing and pays
 * nothing.
 *
 * It owns no domain vocabulary and no span-name constants: a span name is data a
 * caller supplies, exactly like an attribute key. A list of "the spans this
 * system emits" living here would be the same mistake as a hardcoded closed set —
 * it would go stale silently and it would put a consumer's knowledge in the ruler.
 */

export {
  EXCEPTION_EVENT_NAME,
  EXCEPTION_MESSAGE_KEY,
  EXCEPTION_STACKTRACE_KEY,
  EXCEPTION_TYPE_KEY,
  type AttributeValue,
  type Attributes,
  type RecordedSpan,
  type Span,
  type SpanContext,
  type SpanEvent,
  type SpanKind,
  type SpanSink,
  type SpanStatus,
  type SpanStatusCode,
  type StartSpanOptions,
  type Tracer,
} from "./span.ts";

export {
  InMemorySpanSink,
  NOOP_TRACER,
  SYSTEM_CLOCK,
  createRecordingTracer,
  createStepClock,
  withAsyncSpan,
  withSpan,
  type Clock,
  type RecordingTracerOptions,
} from "./tracer.ts";

export {
  TRACEPARENT_HEADER,
  TRACEPARENT_VERSION,
  TRACE_FLAG_SAMPLED,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  type TraceparentParse,
} from "./trace-context.ts";

export {
  BatchingSpanSink,
  createOtlpHttpExporter,
  toAnyValue,
  toKeyValues,
  toOtlpTracePayload,
  type InstrumentationScope,
  type OtlpAnyValue,
  type OtlpExporterOptions,
  type OtlpKeyValue,
  type OtlpResource,
  type OtlpTracePayload,
  type SpanExporter,
} from "./otlp.ts";
