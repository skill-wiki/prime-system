/**
 * @module test/tracing
 *
 * Evidence that the query path is observable, and that the observability is
 * *joined up*: a span in isolation proves nothing, because the value of a trace is
 * that retrieval, projection and budget sit under the request that caused them.
 */

import { describe, expect, test } from "bun:test";
import { SPAN_BUDGET, SPAN_EXPANSION, SPAN_PLAN, SPAN_RETRIEVAL } from "@skill-wiki/query-engine";
import { SPAN_PROJECTION } from "@skill-wiki/sdk";
import {
  TRACEPARENT_HEADER,
  formatTraceparent,
  toOtlpTracePayload,
} from "@skill-wiki/observability";
import { mountCorpora, switchRelease, EVENT_CORPUS_MOUNTED, EVENT_CORPUS_MOUNT_FAILED, EVENT_CORPUS_SWITCHED, SPAN_CORPUS_ACTIVATE, SPAN_CORPUS_MOUNT } from "../src/corpus.ts";
import { SPAN_HTTP_REQUEST } from "../src/handler.ts";
import { InMemorySpanSink, createRecordingTracer, createStepClock } from "@skill-wiki/observability";
import { PUBLIC_TOKEN, harness, post } from "./support/host.ts";

const query = (profile: string): unknown => ({ profile, maxTokens: 4000, text: "authentication" });

describe("the query path emits the spans Phase 5 asks for", () => {
  test("one query produces retrieval, projection and budget spans under the request span", async () => {
    const h = harness({ requestId: "req-fixed" });
    const response = await h.handler(post("/v1/query", query(h.profile), PUBLIC_TOKEN));
    expect(response.status).toBe(200);

    const names = h.sink.names();
    for (const expected of [SPAN_HTTP_REQUEST, SPAN_PLAN, SPAN_RETRIEVAL, SPAN_EXPANSION, SPAN_BUDGET, SPAN_PROJECTION]) {
      expect(names).toContain(expected);
    }

    // One trace, and every span in it.
    const [request] = h.sink.named(SPAN_HTTP_REQUEST);
    expect(request).toBeDefined();
    expect(h.sink.ofTrace(request!.context.traceId)).toHaveLength(h.sink.all().length);

    const byName = new Map(h.sink.all().map(span => [span.name, span]));
    // Parentage, not merely co-membership: retrieval/expansion/budget hang off the
    // plan span, and the plan span hangs off the HTTP request span.
    expect(byName.get(SPAN_PLAN)!.context.parentSpanId).toBe(request!.context.spanId);
    for (const phase of [SPAN_RETRIEVAL, SPAN_EXPANSION, SPAN_BUDGET]) {
      expect(byName.get(phase)!.context.parentSpanId).toBe(byName.get(SPAN_PLAN)!.context.spanId);
    }
    expect(byName.get(SPAN_PROJECTION)!.context.parentSpanId).toBe(request!.context.spanId);
  });

  test("the phase spans carry the arithmetic a consumer would otherwise recompute", async () => {
    const h = harness();
    await h.handler(post("/v1/query", query(h.profile), PUBLIC_TOKEN));
    const byName = new Map(h.sink.all().map(span => [span.name, span]));

    const retrieval = byName.get(SPAN_RETRIEVAL)!;
    // The public principal is denied two of the five fixture units, and that
    // number is on the span rather than only inside the plan.
    expect(retrieval.attributes["aoe.acl_denied_units"]).toBe(2);
    expect(retrieval.attributes["aoe.admitted_units"]).toBe(3);
    expect(Array.isArray(retrieval.attributes["aoe.generators"])).toBe(true);

    const budget = byName.get(SPAN_BUDGET)!;
    expect(budget.attributes["aoe.max_tokens"]).toBe(4000);
    expect(typeof budget.attributes["aoe.consumed_tokens"]).toBe("number");
    expect(Array.isArray(budget.attributes["aoe.projection_chain"])).toBe(true);

    const projection = byName.get(SPAN_PROJECTION)!;
    expect(projection.attributes["aoe.materialized_units"]).toBe(
      (budget.attributes["aoe.assigned_units"] as number),
    );

    const http = byName.get(SPAN_HTTP_REQUEST)!;
    expect(http.kind).toBe("server");
    expect(http.attributes["http.request.method"]).toBe("POST");
    expect(http.attributes["url.path"]).toBe("/v1/query");
    expect(http.attributes["http.response.status_code"]).toBe(200);
    expect(http.attributes["aoe.principal_id"]).toBe("reader");
  });

  test("an inbound traceparent is joined rather than replaced, and echoed back", async () => {
    const h = harness();
    const upstream = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
    const request = post("/v1/query", query(h.profile), PUBLIC_TOKEN);
    request.headers.set(TRACEPARENT_HEADER, formatTraceparent(upstream));

    const response = await h.handler(request);
    expect(response.status).toBe(200);
    for (const span of h.sink.all()) expect(span.context.traceId).toBe(upstream.traceId);

    const echoed = response.headers.get(TRACEPARENT_HEADER);
    expect(echoed).not.toBeNull();
    expect(echoed!.startsWith(`00-${upstream.traceId}-`)).toBe(true);
  });

  test("a rejected request is still traced, with the denial on the span and not in the body", async () => {
    const h = harness();
    await h.handler(post("/v1/query", query(h.profile)));
    const [span] = h.sink.named(SPAN_HTTP_REQUEST);
    expect(span!.attributes["aoe.auth_denied"]).toBe(true);
    expect(span!.attributes["aoe.auth_reason"]).toBe("missing Authorization header");
    expect(span!.status.code).toBe("error");
  });

  test("a query rejected by the engine records the exception on the plan span", async () => {
    const h = harness();
    const response = await h.handler(post("/v1/query", { profile: "no-such-profile", maxTokens: 100 }, PUBLIC_TOKEN));
    expect(response.status).toBe(400);
    const [retrieval] = h.sink.named("aoe.query.retrieval");
    expect(retrieval!.status.code).toBe("error");
    expect(retrieval!.events.map(event => event.name)).toContain("exception");
  });

  test("the recorded spans encode as an OTLP/HTTP JSON payload", async () => {
    const h = harness();
    await h.handler(post("/v1/query", query(h.profile), PUBLIC_TOKEN));
    const payload = toOtlpTracePayload(h.sink.all(), {
      resource: { attributes: { "service.name": "aoe-http-server" } },
      scope: { name: "aoe-http-server", version: "0.2.0" },
    });
    const scopeSpans = payload.resourceSpans[0]!.scopeSpans[0]!;
    expect(scopeSpans.spans).toHaveLength(h.sink.all().length);
    const first = scopeSpans.spans[0]!;
    // 64-bit fields are strings in the JSON mapping; sending them as numbers
    // truncates every nanosecond timestamp.
    expect(typeof first.startTimeUnixNano).toBe("string");
    expect(typeof first.kind).toBe("number");
    // The whole payload must survive JSON, which is what an exporter does to it.
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});

describe("corpus mount and switch are observable events", () => {
  test("a failed mount is an event on a span that still completed", () => {
    const sink = new InMemorySpanSink();
    const tracer = createRecordingTracer({ sink, clock: createStepClock() });
    const outcome = mountCorpora([{ path: "/nonexistent/corpus-bundle" }], { tracer });

    expect(outcome.registry.size).toBe(0);
    expect(outcome.failed).toHaveLength(1);
    const [span] = sink.named(SPAN_CORPUS_MOUNT);
    expect(span!.attributes["aoe.failed_mounts"]).toBe(1);
    expect(span!.attributes["aoe.mounted"]).toBe(0);
    expect(span!.events.map(event => event.name)).toEqual([EVENT_CORPUS_MOUNT_FAILED]);
    // The operation reported its failures, so the span is not an error.
    expect(span!.status.code).toBe("unset");
    // Diagnostics are counted and coded, never inlined.
    const event = span!.events[0]!;
    expect(event.attributes["aoe.mount_path"]).toBe("/nonexistent/corpus-bundle");
    expect(Array.isArray(event.attributes["aoe.mount_codes"])).toBe(true);
    expect(EVENT_CORPUS_MOUNTED).toBe("aoe.corpus.mounted");
  });

  test("activating an unmounted release fails closed and says so on the span", () => {
    const sink = new InMemorySpanSink();
    const tracer = createRecordingTracer({ sink, clock: createStepClock() });
    const { registry } = mountCorpora([], { tracer });
    const outcome = switchRelease(registry, "com.example/corpus", "2026.01.01.1", { tracer });

    expect(outcome.ok).toBe(false);
    const [span] = sink.named(SPAN_CORPUS_ACTIVATE);
    expect(span!.status.code).toBe("error");
    expect(span!.attributes["aoe.activate_code"]).toBe("MOUNT_NOT_FOUND");
    expect(span!.events.map(event => event.name)).not.toContain(EVENT_CORPUS_SWITCHED);
  });
});
