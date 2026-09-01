#!/usr/bin/env bun
/**
 * @module main
 *
 * The process entry point: read configuration, build a tracer, bind a socket.
 *
 * ## Why the engine context arrives from a host module rather than from a bundle path
 *
 * Turning a bundle directory into a `QueryEngineContext` needs three things: the
 * bundle→`GraphIR` adapter (`mcp-server-core`'s `buildCorpusGraph`), the Model
 * Package load (`loadServeModel`), **and** a `CandidateGeneratorRegistry` wired
 * from the model's declared generator bindings to the concrete lexical / facet /
 * graph mechanisms. The first two are exported. The third is not: it lives inside
 * `mcp-server-core/src/serve.ts` as private functions.
 *
 * Writing it again here would produce a second bundle→engine bridge that can
 * disagree with the first, which is precisely the failure mode
 * `sdk/src/embedded.ts` documents as the reason it refuses to read a bundle
 * itself. So this entry point takes a **host module**: a file that default-exports
 * `createHost()` returning the engine context, the snapshot and the credentials.
 * The lane report names the one change that would let this CLI take a plain
 * `--bundle` path instead.
 *
 * Configuration is environment-only for the credentials
 * (`AOE_HTTP_CREDENTIALS`), so a token is never an argv string visible in
 * `ps` output.
 */

import {
  BatchingSpanSink,
  NOOP_TRACER,
  createOtlpHttpExporter,
  createRecordingTracer,
  type Tracer,
} from "@skill-wiki/observability";
import type { QueryEngineContext } from "@skill-wiki/query-engine";
import { createEmbeddedTransport, type EmbeddedHost } from "@skill-wiki/sdk";
import { createBearerAuthenticator, parseCredentialSpec, type Credential } from "./auth.ts";
import { describeExposure, startServer, type RunningServer } from "./server.ts";

const CREDENTIALS_ENV = "AOE_HTTP_CREDENTIALS";
const HOST_MODULE_ENV = "AOE_HTTP_HOST_MODULE";
const HOSTNAME_ENV = "AOE_HTTP_HOSTNAME";
const PORT_ENV = "AOE_HTTP_PORT";
const OTLP_ENV = "AOE_OTLP_TRACES_ENDPOINT";
const SERVICE_NAME = "aoe-http-server";

/** What a host module must default-export as `createHost`. */
export interface HttpHostModule {
  createHost(): Promise<HttpHost> | HttpHost;
}

export interface HttpHost {
  readonly engine: QueryEngineContext;
  readonly embedded: Omit<EmbeddedHost, "tracer" | "traceParent">;
  /** Overrides `AOE_HTTP_CREDENTIALS` when the deployment holds its own secret store. */
  readonly credentials?: readonly Credential[];
}

export function buildTracer(environment: Record<string, string | undefined>): {
  readonly tracer: Tracer;
  readonly flush: () => Promise<void>;
} {
  const endpoint = environment[OTLP_ENV];
  // No endpoint means no tracer, not a tracer with a discarded sink: the noop
  // tracer allocates nothing per span, so an unconfigured deployment pays nothing
  // for instrumentation it cannot use.
  if (endpoint === undefined || endpoint === "") return { tracer: NOOP_TRACER, flush: async (): Promise<void> => {} };
  const sink = new BatchingSpanSink(createOtlpHttpExporter({
    endpoint,
    resource: { attributes: { "service.name": SERVICE_NAME } },
    scope: { name: SERVICE_NAME, version: "0.2.0" },
    onError: (error): void => {
      // Reported once per failed batch on stderr, never thrown: a collector being
      // unreachable must not fail a query. Silence here is what makes a dashboard
      // confidently wrong, so it is not an option either.
      console.error(`[${SERVICE_NAME}] telemetry export failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  }));
  return { tracer: createRecordingTracer({ sink }), flush: (): Promise<void> => sink.flush() };
}

function requireEnv(environment: Record<string, string | undefined>, name: string, why: string): string {
  const value = environment[name];
  if (value === undefined || value === "") throw new Error(`${name} is required: ${why}`);
  return value;
}

export async function run(environment: Record<string, string | undefined> = process.env): Promise<RunningServer> {
  const hostModulePath = requireEnv(
    environment,
    HOST_MODULE_ENV,
    "it must point at a module default-exporting createHost(), which supplies the engine context and generators",
  );
  const loaded = (await import(hostModulePath)) as { default?: HttpHostModule } & Partial<HttpHostModule>;
  const factory = loaded.default ?? loaded;
  if (typeof factory.createHost !== "function") {
    throw new Error(`${hostModulePath} must export createHost()`);
  }
  const host = await factory.createHost();

  const credentials = host.credentials ?? parseCredentialSpec(requireEnv(
    environment,
    CREDENTIALS_ENV,
    "this server has no anonymous mode; supply '<token>:<principalId>:<visibility,…>:<label,…>' entries",
  ));
  const authenticator = createBearerAuthenticator(credentials);
  const { tracer } = buildTracer(environment);
  const hostname = environment[HOSTNAME_ENV] ?? "127.0.0.1";
  const port = Number.parseInt(environment[PORT_ENV] ?? "0", 10);

  const server = await startServer({
    authenticator,
    engine: host.engine,
    tracer,
    hostname,
    port: Number.isInteger(port) && port >= 0 ? port : 0,
    transportFor: scope => createEmbeddedTransport({
      ...host.embedded,
      tracer: scope.tracer,
      ...(scope.parent === undefined ? {} : { traceParent: scope.parent }),
    }),
  });

  console.error(`[${SERVICE_NAME}] listening on ${server.url} — ${describeExposure({ hostname })}`);
  console.error(`[${SERVICE_NAME}] ${authenticator.credentialCount} credential(s); traces ${environment[OTLP_ENV] === undefined ? "disabled" : `to ${environment[OTLP_ENV]}`}`);
  return server;
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(`[${SERVICE_NAME}] refusing to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
