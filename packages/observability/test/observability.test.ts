import { describe, expect, test } from "bun:test";
import {
  BatchingSpanSink,
  InMemorySpanSink,
  NOOP_TRACER,
  createOtlpHttpExporter,
  createRecordingTracer,
  createStepClock,
  formatTraceparent,
  parseTraceparent,
  toAnyValue,
  toOtlpTracePayload,
  withSpan,
  type RecordedSpan,
} from "../src/index.ts";

function tracerWithSink(): { readonly sink: InMemorySpanSink; readonly tracer: ReturnType<typeof createRecordingTracer> } {
  const sink = new InMemorySpanSink();
  return { sink, tracer: createRecordingTracer({ sink, clock: createStepClock() }) };
}

describe("the recording tracer", () => {
  test("a child inherits the trace and records its parent", () => {
    const { sink, tracer } = tracerWithSink();
    const root = tracer.startSpan("root");
    const child = tracer.startSpan("child", { parent: root.context });
    child.end();
    root.end();

    const [recordedChild, recordedRoot] = sink.all() as [RecordedSpan, RecordedSpan];
    expect(recordedChild.context.traceId).toBe(recordedRoot.context.traceId);
    expect(recordedChild.context.parentSpanId).toBe(recordedRoot.context.spanId);
    expect(recordedRoot.context.parentSpanId).toBeUndefined();
    // Root started first and ended last, so its span strictly contains the child's.
    expect(recordedRoot.startTimeUnixNano < recordedChild.startTimeUnixNano).toBe(true);
    expect(recordedRoot.endTimeUnixNano > recordedChild.endTimeUnixNano).toBe(true);
  });

  test("end is idempotent, so a double end does not stretch the duration", () => {
    const { sink, tracer } = tracerWithSink();
    const span = tracer.startSpan("once");
    span.end();
    const firstEnd = sink.all()[0]!.endTimeUnixNano;
    span.end();
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0]!.endTimeUnixNano).toBe(firstEnd);
  });

  test("an attribute set after end is ignored rather than mutating a delivered span", () => {
    const { sink, tracer } = tracerWithSink();
    const span = tracer.startSpan("frozen");
    span.end();
    span.setAttribute("late", "value");
    expect(sink.all()[0]!.attributes.late).toBeUndefined();
  });

  test("withSpan records the exception, sets an error status and rethrows unchanged", () => {
    const { sink, tracer } = tracerWithSink();
    const boom = new TypeError("engine said no");
    expect(() => withSpan(tracer, "failing", {}, () => {
      throw boom;
    })).toThrow(boom);

    const [span] = sink.all() as [RecordedSpan];
    expect(span.status).toEqual({ code: "error", message: "engine said no" });
    const [event] = span.events;
    expect(event!.name).toBe("exception");
    expect(event!.attributes["exception.type"]).toBe("TypeError");
    expect(event!.attributes["exception.message"]).toBe("engine said no");
  });

  test("attributes are recorded in key order, so two identical spans serialise identically", () => {
    const { sink, tracer } = tracerWithSink();
    const span = tracer.startSpan("ordered", { attributes: { z: 1 } });
    span.setAttribute("a", true);
    span.setAttribute("m", "x");
    span.end();
    expect(Object.keys(sink.all()[0]!.attributes)).toEqual(["a", "m", "z"]);
  });

  test("the noop tracer records nothing and reports the invalid context", () => {
    const span = NOOP_TRACER.startSpan("ignored");
    span.setAttribute("a", 1);
    span.addEvent("e");
    span.end();
    // All-zero is the W3C "invalid" context: propagating it produces a traceparent
    // a collector drops, rather than a plausible id attaching spans to a fiction.
    expect(span.context.traceId).toBe("0".repeat(32));
    expect(span.context.spanId).toBe("0".repeat(16));
    expect(span.context.traceFlags).toBe(0);
  });
});

describe("W3C trace context", () => {
  test("format and parse are inverses", () => {
    const context = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1 };
    const header = formatTraceparent(context);
    expect(header).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const parsed = parseTraceparent(header);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value : undefined).toEqual(context);
  });

  test("malformed and all-zero ids are rejected rather than repaired", () => {
    for (const header of [
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`,
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
      "not-a-header",
    ]) {
      expect(parseTraceparent(header).ok).toBe(false);
    }
  });
});

describe("OTLP/HTTP JSON encoding", () => {
  test("value kinds map to the protocol's AnyValue variants", () => {
    expect(toAnyValue("s")).toEqual({ stringValue: "s" });
    expect(toAnyValue(true)).toEqual({ boolValue: true });
    // A whole number keeps its integer type, and 64-bit ints are strings.
    expect(toAnyValue(7)).toEqual({ intValue: "7" });
    expect(toAnyValue(1.5)).toEqual({ doubleValue: 1.5 });
    expect(toAnyValue(["a", "b"])).toEqual({ arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } });
  });

  test("a root span omits parentSpanId and a child carries it as hex", () => {
    const { sink, tracer } = tracerWithSink();
    const root = tracer.startSpan("root", { kind: "server" });
    const child = tracer.startSpan("child", { parent: root.context });
    child.setStatus({ code: "ok" });
    child.end();
    root.end();

    const payload = toOtlpTracePayload(sink.all(), {
      resource: { attributes: { "service.name": "test" } },
      scope: { name: "test", version: "0.1.0" },
    });
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    const encodedChild = spans.find(span => span.name === "child")!;
    const encodedRoot = spans.find(span => span.name === "root")!;
    expect(encodedChild.parentSpanId).toBe(root.context.spanId);
    expect("parentSpanId" in encodedRoot).toBe(false);
    expect(encodedRoot.kind).toBe(2);
    expect(encodedChild.status).toEqual({ code: 1 });
    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "test" } },
    ]);
  });

  test("the exporter posts JSON and reports a failure without throwing", async () => {
    const { sink, tracer } = tracerWithSink();
    tracer.startSpan("exported").end();

    const seen: { url?: string; body?: string; contentType?: string | null } = {};
    const exporter = createOtlpHttpExporter({
      endpoint: "http://127.0.0.1:4318/v1/traces",
      resource: { attributes: { "service.name": "test" } },
      scope: { name: "test" },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.url = String(url);
        seen.body = String(init?.body);
        seen.contentType = new Headers(init?.headers).get("content-type");
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await exporter.export(sink.all());
    expect(seen.url).toBe("http://127.0.0.1:4318/v1/traces");
    expect(seen.contentType).toBe("application/json");
    expect(JSON.parse(seen.body!)).toHaveProperty("resourceSpans");

    const errors: unknown[] = [];
    const failing = createOtlpHttpExporter({
      endpoint: "http://127.0.0.1:4318/v1/traces",
      resource: { attributes: {} },
      scope: { name: "test" },
      fetch: (async (): Promise<Response> => {
        throw new Error("connection refused");
      }) as unknown as typeof globalThis.fetch,
      onError: error => errors.push(error),
    });
    // Resolves, not rejects: a collector being down must not fail a query.
    await failing.export(sink.all());
    expect(errors).toHaveLength(1);
  });

  test("an empty batch is not sent at all", async () => {
    let calls = 0;
    const exporter = createOtlpHttpExporter({
      endpoint: "http://127.0.0.1:4318/v1/traces",
      resource: { attributes: {} },
      scope: { name: "test" },
      fetch: (async (): Promise<Response> => {
        calls += 1;
        return new Response("{}");
      }) as unknown as typeof globalThis.fetch,
    });
    await exporter.export([]);
    expect(calls).toBe(0);
  });

  test("the batching sink flushes on demand so a short-lived process loses nothing", async () => {
    const batches: number[] = [];
    const sinkUnderTest = new BatchingSpanSink({
      export: async (spans): Promise<void> => {
        batches.push(spans.length);
      },
    }, 1000);
    const tracer = createRecordingTracer({ sink: sinkUnderTest, clock: createStepClock() });
    tracer.startSpan("a").end();
    tracer.startSpan("b").end();
    expect(sinkUnderTest.pending).toBe(2);
    await sinkUnderTest.flush();
    expect(batches).toEqual([2]);
    expect(sinkUnderTest.pending).toBe(0);
  });
});
