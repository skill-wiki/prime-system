#!/usr/bin/env bun
/** Generic, bundle-backed MCP transport for compiled AOE corpora. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "url";
import { resolve as resolveFsPath } from "path";
import {
  loadCorpusSnapshot,
  loadIndex,
  loadAtomMeta,
  verifyCorpusSignature,
  type BundleDiagnostic,
  type GlobalIndex,
  type SnapshotRef,
} from "@skill-wiki/runtime";
import type { SnapshotRef as IrSnapshotRef } from "@skill-wiki/ir";
import type { Principal } from "@skill-wiki/query-engine";
import type { ProjectionScope, TransportKind } from "@skill-wiki/projection-engine";
import { createAoeQueryResponse, createAoePlanResponse, type ResourceIdentity } from "./query-response";
export {
  createAoeQueryResponse,
  createAoePlanResponse,
  createAoeResourceUri,
  type QueryResult,
  type QueryResponseResult,
  type AoeQueryResponse,
  type AoePlanResponse,
  type ResourceIdentity,
} from "./query-response";
export {
  buildCorpusGraph,
  type CorpusGraph,
  type AtomMetaLike,
  type IndexAtomLike,
} from "./corpus-graph";
export {
  DIAGNOSTICS_FILE,
  buildDiagnosticsDocument,
  classifyDangling,
  parseDanglingMessage,
  writeDiagnosticsDocument,
  type BundleDiagnosticsDocument,
  type ClassifyContext,
  type DanglingClass,
  type DanglingRecord,
} from "./diagnostics-sink";
export {
  cheaperProjections,
  loadServeModel,
  resolveModelRoot,
  ModelContextError,
  type ModelResolution,
  type ServeModel,
} from "./model-context";
export {
  MODEL_LOCK_FILE,
  ModelLockError,
  computeModelSchemaDigest,
  parseModelLock,
  verifyModelLock,
  type ModelLock,
  type ModelLockCode,
  type ModelLockDiagnostic,
  type ModelLockEntry,
} from "./model-lock";
export {
  DEFAULT_GENERATOR_BINDINGS,
  executeAoePlan,
  executeAoeQuery,
  resolveAoeUri,
  type GeneratorBinding,
  type GeneratorMechanism,
  type PlanArguments,
  type PlanOutcome,
  type QueryArguments,
  type ServeOptions,
  type ServeOutcome,
} from "./serve";

import { buildCorpusGraph, type CorpusGraph } from "./corpus-graph";
import { loadServeModel, resolveModelRoot, type ServeModel } from "./model-context";
import { verifyModelLock } from "./model-lock";
import { executeAoePlan, executeAoeQuery, resolveAoeUri, type PlanArguments, type QueryArguments, type ServeOptions } from "./serve";

export interface AoeMcpOptions {
  corpusDir: string;
  requireManifest?: boolean;
  stderr?: Pick<Console, "error">;
  environment?: Record<string, string | undefined>;
  /** Model Package root; overrides `AOE_MODEL_DIR` and bundle discovery. */
  modelRoot?: string;
}

export interface AoeMcpInstance {
  server: McpServer;
  index: GlobalIndex;
  snapshot: SnapshotRef;
  diagnostics: readonly BundleDiagnostic[];
  model: ServeModel;
  corpus: CorpusGraph;
  serve: ServeOptions;
}

const AOE_QUERY_SCHEMA = z.object({
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

/**
 * `aoe_plan` (§11.1). No `scope`: plan has one meaning. No `id`: a plan is over
 * a retrieval signal, and "the plan for one known unit" is `aoe_query`
 * `scope=show`.
 */
const AOE_PLAN_SCHEMA = z.object({
  query: z.string().optional(),
  seeds: z.array(z.string().min(1)).optional(),
  kind: z.string().optional(),
  level: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const AOE_RESOURCE_SCHEMA = z.object({ uri: z.string().min(1) });

const TRANSPORT_ENV = "AOE_TRANSPORT";
const TENANT_ENV = "AOE_TENANT";
const WORKSPACE_ENV = "AOE_WORKSPACE";
const MAX_TOKENS_ENV = "AOE_MAX_TOKENS";
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
export function createAoeMcpServer(options: AoeMcpOptions): AoeMcpInstance {
  const stderr = options.stderr ?? console;
  const environment = options.environment ?? process.env;
  const loaded = loadCorpusSnapshot(options.corpusDir, { requireManifest: options.requireManifest });
  verifyCorpusSignature(options.corpusDir);
  for (const diagnostic of loaded.diagnostics) {
    stderr.error(`[aoe-mcp] ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
  }
  const index = loadIndex(options.corpusDir);

  const resolution = resolveModelRoot(options.corpusDir, environment, options.modelRoot);
  const model = loadServeModel(resolution);
  // §8.4 lists model-lock integrity among the boot checks; nothing performed it,
  // so a manifest could name one model while a different one served the corpus.
  // A mismatch throws out of `createAoeMcpServer` — refusing to boot is the
  // only honest response to "the snapshot identity does not describe the answer".
  for (const diagnostic of verifyModelLock({
    bundleRoot: options.corpusDir,
    model: model.model,
    ...(loaded.manifest === undefined ? {} : {
      manifestModels: loaded.manifest.models,
      manifestSchemaDigest: loaded.manifest.schemaDigest,
    }),
  })) {
    stderr.error(`[aoe-mcp] ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
  }
  stderr.error(
    `[aoe-mcp] model ${model.model.manifest.name}@${model.model.manifest.version} (${resolution.origin}) · ` +
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
    loadMeta: (id) => loadAtomMeta(options.corpusDir, id),
    snapshot: irSnapshot,
    corpus: loaded.snapshot.corpus,
  });
  for (const diagnostic of corpus.diagnostics) {
    stderr.error(`[aoe-mcp] ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
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
    bundleRoot: resolveFsPath(options.corpusDir),
    scope: projectionScope,
    principal: localPrincipal(),
    transport: readTransport(environment),
    maxTokens: readPositiveInt(environment[MAX_TOKENS_ENV], DEFAULT_MAX_TOKENS),
  };

  const server = new McpServer({ name: "aoe-mcp", version: "0.2.0" }, { capabilities: { tools: {} } });
  // `registerTool` with an explicit `inputSchema` is the only form that both
  // advertises the parameters in `tools/list` and delivers parsed arguments to
  // the callback. The deprecated `tool(name, description, cb)` overload declares
  // a ZERO-ARGUMENT tool and hands the callback a `RequestHandlerExtra`, which
  // carries no `params` — so every call silently collapsed to the default scope.
  server.registerTool(
    "aoe_query",
    {
      description:
        "Browse a compiled AOE corpus. Every result carries an aoe:// resource URI; the payload is a projection path, inline content or the URI itself depending on the negotiated transport.",
      inputSchema: AOE_QUERY_SCHEMA,
    },
    async (args: QueryArguments) => {
      const outcome = executeAoeQuery(args, serve);
      if ("error" in outcome) return { content: [{ type: "text", text: outcome.error }] };
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            createAoeQueryResponse(
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
    "aoe_plan",
    {
      description:
        "Return the selection plan for a retrieval request without rendering it: candidates with per-axis scores, rejections with reasons, relation expansions, load order, and the budget arithmetic that chose each unit's projection level. Same request and same plan as aoe_query scope=atoms, minus the projection cost.",
      inputSchema: AOE_PLAN_SCHEMA,
    },
    async (args: PlanArguments) => {
      const outcome = executeAoePlan(args, serve);
      if ("error" in outcome) return { content: [{ type: "text", text: outcome.error }] };
      return {
        content: [{
          type: "text",
          text: JSON.stringify(createAoePlanResponse(loaded.snapshot, outcome.plan), null, 2),
        }],
      };
    },
  );
  server.registerTool(
    "aoe_resource",
    {
      description:
        "Resolve a aoe:// resource URI to its projection content. This is what makes the URI transport usable for a consumer that cannot read server-local paths (§11.3).",
      inputSchema: AOE_RESOURCE_SCHEMA,
    },
    async (args: { uri: string }) => {
      const outcome = resolveAoeUri(args.uri, serve);
      if ("error" in outcome) return { content: [{ type: "text", text: outcome.error }] };
      return { content: [{ type: "text", text: outcome.content }] };
    },
  );
  return { server, index, snapshot: loaded.snapshot, diagnostics: loaded.diagnostics, model, corpus, serve };
}

/** Production stdio entry point; kept separate so import remains side-effect free. */
export async function runStdioServer(environment: Record<string, string | undefined> = process.env): Promise<void> {
  const corpusDir = environment.AOE_CORPUS_DIR;
  if (!corpusDir) throw new Error("AOE_CORPUS_DIR is required and must point to a compiled corpus.");
  const instance = createAoeMcpServer({
    corpusDir,
    requireManifest: environment.AOE_REQUIRE_MANIFEST === "1",
    environment,
  });
  console.error(`[aoe-mcp] ${instance.index.total} units · ${instance.index.totalTokens} tokens · snapshot ${instance.snapshot.corpus}@${instance.snapshot.release}`);
  await instance.server.connect(new StdioServerTransport());
  console.error(`[aoe-mcp] ready · tools: aoe_query, aoe_plan, aoe_resource · transport ${instance.serve.transport} · stdio active`);
}

const isEntrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolveFsPath(process.argv[1])).href;
if (isEntrypoint) {
  runStdioServer().catch((error) => {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "BOOT_FAILED";
    console.error(`[aoe-mcp] error ${code}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
