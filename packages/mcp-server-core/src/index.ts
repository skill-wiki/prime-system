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
  resolveProjection,
  discoverDomains,
  DomainRegistry,
  registerAll,
  type DomainPlugin,
  type BundleDiagnostic,
  type GlobalIndex,
  type SnapshotRef,
} from "@skill-wiki/runtime";
import {
  createPrimeQueryResponse,
  createPrimeResourceUri,
} from "./query-response";
export {
  createPrimeQueryResponse,
  createPrimeResourceUri,
  type QueryResult,
  type QueryResponseResult,
  type PrimeQueryResponse,
} from "./query-response";
import { executePrimeQuery, type QueryArguments } from "./query-engine";

export interface PrimeMcpOptions {
  primeDir: string;
  requireManifest?: boolean;
  stderr?: Pick<Console, "error">;
  environment?: Record<string, string | undefined>;
}

export interface PrimeMcpInstance {
  server: McpServer;
  index: GlobalIndex;
  snapshot: SnapshotRef;
  diagnostics: readonly BundleDiagnostic[];
}

const PRIME_QUERY_SCHEMA = z.object({
  scope: z.enum(["atoms", "related", "show"]),
  query: z.string().optional(),
  id: z.string().optional(),
  level: z.enum(["summary", "core", "full"]).optional().default("core"),
  kind: z.string().optional(),
  limit: z.number().int().positive().max(100).optional().default(10),
});

/**
 * Construct the server without connecting stdio. An environment can be
 * injected to make boot configuration deterministic in tests and embedders.
 * All filesystem reads happen once here, at boot, against compiled artifacts.
 */
export function createPrimeMcpServer(options: PrimeMcpOptions): PrimeMcpInstance {
  const stderr = options.stderr ?? console;
  const environment = options.environment ?? process.env;
  const loaded = loadCorpusSnapshot(options.primeDir, { requireManifest: options.requireManifest });
  for (const diagnostic of loaded.diagnostics) {
    stderr.error(`[prime-mcp-core] ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
  }
  const index = loadIndex(options.primeDir);
  const domainRegistry = new DomainRegistry();
  const primeParent = resolveFsPath(options.primeDir, "..");
  const roots = [primeParent];
  if (process.cwd() !== primeParent) roots.push(process.cwd());
  const plugins: DomainPlugin[] = [];
  const seenNames = new Set<string>();
  for (const root of roots) {
    for (const plugin of discoverDomains(root)) {
      if (!seenNames.has(plugin.name)) {
        seenNames.add(plugin.name);
        plugins.push(plugin);
      }
    }
  }
  registerAll(domainRegistry, plugins);
  const names = domainRegistry.names();
  if (names.length > 0) stderr.error(`[prime-mcp-core] domains: ${names.length} (${names.join(", ")})`);
  else stderr.error("[prime-mcp-core] domains: 0 (no domain.yaml found — plain ranking active)");

  const domainTags = new Set<string>();
  for (const name of names) {
    for (const tag of domainRegistry.get(name)!.tags) domainTags.add(tag.toLowerCase());
  }
  let kindBoosts: Record<string, number> = {};
  if (environment.PRIME_KIND_BOOSTS) {
    try { kindBoosts = JSON.parse(environment.PRIME_KIND_BOOSTS) as Record<string, number>; } catch { /* original behavior: no boosts */ }
  }

  const server = new McpServer({ name: "prime-mcp-core", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.tool(
    "prime_query",
    "Browse a compiled Prime corpus. Results contain projection paths, never source or projection content.",
    async (extra) => {
      const raw = (extra as unknown as { params?: { arguments?: unknown } }).params?.arguments ?? {};
      const parsed = PRIME_QUERY_SCHEMA.safeParse(raw);
      const args: QueryArguments = parsed.success ? parsed.data : { scope: "atoms", level: "core", limit: 10 };
      const outcome = executePrimeQuery(args, {
        atoms: index.atoms,
        kindBoosts,
        domainTags,
        loadMeta: (id) => loadAtomMeta(options.primeDir, id),
        resolveProjection: (id, level) => resolveProjection(options.primeDir, id, level),
      });
      if ("error" in outcome) return { content: [{ type: "text", text: outcome.error }] };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(createPrimeQueryResponse(loaded.snapshot, outcome.results, index.totalTokens), null, 2),
        }],
      };
    },
  );
  return { server, index, snapshot: loaded.snapshot, diagnostics: loaded.diagnostics };
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
  console.error("[prime-mcp-core] ready · tool: prime_query · stdio transport active");
}

const isEntrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolveFsPath(process.argv[1])).href;
if (isEntrypoint) {
  runStdioServer().catch((error) => {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "BOOT_FAILED";
    console.error(`[prime-mcp-core] error ${code}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
