/**
 * @module trace-context
 *
 * W3C Trace Context (`traceparent`) parsing and formatting, plus id generation.
 *
 * This exists so an incoming HTTP request can join a trace that started
 * somewhere else. Without it every server span is a root, and a trace that
 * crosses the process boundary — which is the only kind worth collecting from a
 * network surface — cannot be assembled. `traceparent` is the format because it
 * is what OTLP-speaking collectors and every OpenTelemetry SDK already send;
 * inventing a header here would make this server unjoinable.
 */

import { randomBytes } from "node:crypto";
import type { SpanContext } from "./span.ts";

export const TRACEPARENT_HEADER = "traceparent";

/** The only version this implementation claims to understand. */
export const TRACEPARENT_VERSION = "00";

export const TRACE_FLAG_SAMPLED = 0x01;

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

function hex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

export function generateTraceId(): string {
  // Retried rather than accepted: an all-zero id is invalid per the spec, and a
  // span carrying one is dropped by collectors — silently, which is worse than
  // the vanishingly rare extra draw.
  let id = hex(16);
  while (id === INVALID_TRACE_ID) id = hex(16);
  return id;
}

export function generateSpanId(): string {
  let id = hex(8);
  while (id === INVALID_SPAN_ID) id = hex(8);
  return id;
}

const LOWER_HEX = /^[0-9a-f]+$/;

function isHexOfLength(value: string, length: number): boolean {
  return value.length === length && LOWER_HEX.test(value);
}

export type TraceparentParse =
  | { readonly ok: true; readonly value: SpanContext }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses `00-<32 hex>-<16 hex>-<2 hex>`.
 *
 * Rejects rather than repairs. A caller that receives `{ ok: false }` starts a
 * new trace, which is exactly what the spec prescribes for an unparsable header;
 * quietly coercing a malformed id would attach this server's spans to a trace
 * that does not exist.
 */
export function parseTraceparent(raw: string): TraceparentParse {
  const parts = raw.trim().split("-");
  if (parts.length !== 4) return { ok: false, reason: `traceparent must have 4 fields, found ${parts.length}` };
  const [version, traceId, spanId, flags] = parts as [string, string, string, string];
  if (version !== TRACEPARENT_VERSION) return { ok: false, reason: `unsupported traceparent version '${version}'` };
  if (!isHexOfLength(traceId, 32) || traceId === INVALID_TRACE_ID) {
    return { ok: false, reason: "traceparent trace-id must be 32 lowercase hex characters and non-zero" };
  }
  if (!isHexOfLength(spanId, 16) || spanId === INVALID_SPAN_ID) {
    return { ok: false, reason: "traceparent parent-id must be 16 lowercase hex characters and non-zero" };
  }
  if (!isHexOfLength(flags, 2)) return { ok: false, reason: "traceparent trace-flags must be 2 lowercase hex characters" };
  return { ok: true, value: { traceId, spanId, traceFlags: Number.parseInt(flags, 16) } };
}

export function formatTraceparent(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `${TRACEPARENT_VERSION}-${context.traceId}-${context.spanId}-${flags}`;
}
