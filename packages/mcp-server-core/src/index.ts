#!/usr/bin/env bun
/** Generic, bundle-backed MCP transport for compiled Prime corpora. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "url";
import { resolve as resolveFsPath } from "path";
import {
  loadCorpusSnapshot,
  loadIndex,
  loadAtomMeta,
  type BundleDiagnostic,
  type GlobalIndex,
  type SnapshotRef,
} from "@skill-wiki/runtime";
import type { SnapshotRef as IrSnapshotRef } from "@skill-wiki/ir";
import type { Principal } from "@skill-wiki/query-engine";
import type { ProjectionScope, TransportKind } from "@skill-wiki/projection-engine";
import { createPrimeQueryResponse, type ResourceIdentity } from "./query-response";
export {
  createPrimeQueryResponse,
  createPrimeResourceUri,
  type QueryResult,
  type QueryResponseResult,
  type PrimeQueryResponse,
  type ResourceIdentity,
} from "./query-response";
export {
  buildCorpusGraph,
  type CorpusGraph,
  type AtomMetaLike,
  type IndexAtomLike,
} from "./corpus-graph";
export {
  cheaperProjections,
  loadServeModel,
  resolveModelRoot,
  ModelContextError,
  type ModelResolution,
  type ServeModel,
} from "./model-context";
export {
  DEFAULT_GENERATOR_BINDINGS,
  executePrimeQuery,
  resolvePrimeUri,
  type GeneratorBinding,
  type GeneratorMechanism,
  type QueryArguments,
  type ServeOptions,
  type ServeOutcome,
} from "./serve";

import { buildCorpusGraph, type CorpusGraph } from "./corpus-graph";
import { loadServeModel, resolveModelRoot, type ServeModel } from "./model-context";
import { executePrimeQuery, resolvePrimeUri, type QueryArguments, type ServeOptions } from "./serve";

export interface PrimeMcpOptions {
  primeDir: string;
  requireManifest?: boolean;
  stderr?: Pick<Console, "error">;
  environment?: Record<string, string | undefined>;
  /** Model Package root; overrides `PRIME_MODEL_DIR` and bundle discovery. */
  modelRoot?: string;
}

export interface PrimeMcpInstance {
  server: McpServer;
  index: GlobalIndex;
  snapshot: SnapshotRef;
  diagnostics: readonly BundleDiagnostic[];
  model: ServeModel;
  corpus: CorpusGraph;
  serve: ServeOptions;
}

const PRIME_QUERY_SCHEMA = z.object({
  scope: z.enum(["atoms", "related", "show"]),
  query: z.string().optional(),
  id: z.string().optional(),
  // Level names are Model Package data, so this is a string and an unknown value
  // is rejected by the projection catalog with the declared names listed. A `enum`
  // here would hard-code the v1 model's three level names into the protocol.
  level: z.string().optional(),
  kind: z.string().optional(),
  seeds: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(100).optional().default(10),
});

const PRIME_RESOURCE_SCHEMA = z.object({ uri: z.string().min(1) });

const TRANSPORT_ENV = "PRIME_TRANSPORT";
const TENANT_ENV = "PRIME_TENANT";
const WORKSPACE_ENV = "PRIME_WORKSPACE";
const MAX_TOKENS_ENV = "PRIME_MAX_TOKENS";
/** Local stdio agent: the pointer transport is the correct default for it (§9.5). */
const DEFAULT_TRANSPORT: TransportKind = "path";
const DEFAULT_TENANT = "local";
const DEFAULT_MAX_TOKENS = 8000;

function readTransport(environment: Record<string, string | undefined>): TransportKind {
  const raw = environment[TRANSPORT_ENV];
  return raw === "inline" || raw === "uri" || raw === "path" ? raw : DEFAULT_TRANSPORT;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The identity a request runs as.
 *
 * There is no authentication on a stdio MCP server, so there is no authenticated
 * principal to derive this from: the local user already has the bundle on disk.
 * The ACL is nonetheless wired and enforced ahead of everything else, so a corpus
 * format that starts carrying `visibility`/`policyLabels` is filtered on without
 * another cutover. See the lane report — this is a declared gap, not a default
 * chosen for convenience.
 */
function localPrincipal(): Principal {
  return {
    id: "local",
    allowedVisibility: ["private", "shared", "public"],
    grantedPolicyLabels: [],
  };
}

/**
 * Construct the server without connecting stdio. An environment can be
 * injected to make boot configuration deterministic in tests and embedders.
 * All filesystem reads happen once here, at boot, against compiled artifacts —
 * including every `atom.yaml`, because relation expansion needs the whole edge
 * set before it can walk any of it.
 */
export function createPrimeMcpServer(options: PrimeMcpOptions): PrimeMcpInstance {
  const stderr = options.stderr ?? console;
  const environment = options.environment ?? process.env;
  const loaded = loadCorpusSnapshot(options.primeDir, { requireManifest: options.requireManifest });
  for (const diagnostic of loaded.diagnostics) {
    stderr.error(`[prime-mcp-core] ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
  }
  const index = loadIndex(options.primeDir);

  const resolution = resolveModelRoot(options.primeDir, environment, options.modelRoot);
  const model = loadServeModel(resolution);
  stderr.error(
    `[prime-mcp-core] model ${model.model.manifest.name}@${model.model.manifest.version} (${resolution.origin}) · ` +
      `profiles ${Object.keys(model.profiles).sort().join(",")} · projections ${model.catalog.profiles().join(",")}`,
  );

  const irSnapshot: IrSnapshotRef = {
    modelRelease: model.model.manifest.version,
    modelDigest: loaded.snapshot.schemaDigest,
    corpusRelease: loaded.snapshot.release,
    corpusDigest: loaded.snapshot.contentDigest,
  };
  const corpus = buildCorpusGraph({
    atoms: index.atoms,
    loadMeta: (id) => loadAtomMeta(options.primeDir, id),
    snapshot: irSnapshot,
    corpus: loaded.snapshot.corpus,
  });
  for (const diagnostic of corpus.diagnostics) {
    stderr.error(`[prime-mcp-core] ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
  }

  const identity: ResourceIdentity = {
    tenant: environment[TENANT_ENV] ?? DEFAULT_TENANT,
    corpus: loaded.snapshot.corpus,
    release: loaded.snapshot.release,
  };
  const projectionScope: ProjectionScope = {
    tenant: identity.tenant,
    workspace: environment[WORKSPACE_ENV] ?? identity.tenant,
    corpus: identity.corpus,
    release: identity.release,
    snapshot: irSnapshot,
  };
  const serve: ServeOptions = {
    model,
    corpus,
    bundleRoot: resolveFsPath(options.primeDir),
    scope: projectionScope,
    principal: localPrincipal(),
    transport: readTransport(environment),
    maxTokens: readPositiveInt(environment[MAX_TOKENS_ENV], DEFAULT_MAX_TOKENS),
  };

  const server = new McpServer({ name: "prime-mcp-core", version: "0.1.0" }, { capabilities: { tools: {} } });
  // `registerTool` with an explicit `inputSchema` is the only form that both
  // advertises the parameters in `tools/list` and delivers parsed arguments to
  // the callback. The deprecated `tool(name, description, cb)` overload declares
  // a ZERO-ARGUMENT tool and hands the callback a `RequestHandlerExtra`, which
  // carries no `params` — so every call silently collapsed to the default scope.
  server.registerTool(
    "prime_query",
    {
      description:
        "Browse a compiled Prime corpus. Every result carries a prime:// resource URI; the payload is a projection path, inline content or the URI itself depending on the negotiated transport.",
      inputSchema: PRIME_QUERY_SCHEMA,
    },
    async (args: QueryArguments) => {
      const outcome = executePrimeQuery(args, serve);
      if ("error" in outcome) return { content: [{ type: "text", text: outcome.error }] };
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            createPrimeQueryResponse(
              loaded.snapshot,
              identity,
              outcome.results,
              index.totalTokens,
              outcome.diagnostics.map((d) => ({ code: d.code, message: d.message, severity: d.severity })),
            ),
            null,
            2,
          ),
        }],
      };
    },
  );
  server.registerTool(
    "prime_resource",
    {
      description:
        "Resolve a prime:// resource URI to its projection content. This is what makes the URI transport usable for a consumer that cannot read server-local paths (§11.3).",
      inputSchema: PRIME_RESOURCE_SCHEMA,
    },
    async (args: { uri: string }) => {
      const outcome = resolvePrimeUri(args.uri, serve);
      if ("error" in outcome) return { content: [{ type: "text", text: outcome.error }] };
      return { content: [{ type: "text", text: outcome.content }] };
    },
  );
  return { server, index, snapshot: loaded.snapshot, diagnostics: loaded.diagnostics, model, corpus, serve };
}

/** Production stdio entry point; kept separate so import remains side-effect free. */
export async function runStdioServer(environment: Record<string, string | undefined> = process.env): Promise<void> {
  const primeDir = environment.PRIME_DIR;
  if (!primeDir) throw new Error("PRIME_DIR is required and must point to a compiled corpus.");
  const instance = createPrimeMcpServer({
    primeDir,
    requireManifest: environment.PRIME_REQUIRE_MANIFEST === "1",
    environment,
  });
  console.error(`[prime-mcp-core] ${instance.index.total} atoms · ${instance.index.totalTokens} tokens · snapshot ${instance.snapshot.corpus}@${instance.snapshot.release}`);
  await instance.server.connect(new StdioServerTransport());
  console.error(`[prime-mcp-core] ready · tools: prime_query, prime_resource · transport ${instance.serve.transport} · stdio active`);
}

const isEntrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolveFsPath(process.argv[1])).href;
if (isEntrypoint) {
  runStdioServer().catch((error) => {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "BOOT_FAILED";
    console.error(`[prime-mcp-core] error ${code}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
