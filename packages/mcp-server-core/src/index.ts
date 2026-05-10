#!/usr/bin/env bun
/**
 * @prime-lang/mcp-server-core
 *
 * Generic MCP server for any compiled Skill Wiki / Prime corpus.
 *
 * Exposes ONE tool: `prime_query`. It does not know about personas, design
 * registers, validation aesthetics, or any other domain-specific concept.
 * Domain wrappers (e.g. the 5-tool frontend-design MCP) are expected to
 * either layer on top of this server or replace it entirely.
 *
 * Design contract (architectural inversion — see PHILOSOPHY.md "Existence ≠
 * content"):
 *
 *   The server NEVER returns atom body content. It returns paths. The agent
 *   uses its own Read tool to load the projection level it actually needs.
 *
 * Configuration:
 *
 *   PRIME_DIR        absolute path to the compiled corpus (containing
 *                    `_index.xml` and per-atom directories). REQUIRED.
 *
 * Wire into Claude Code:
 *
 *   {
 *     "mcpServers": {
 *       "skill-wiki": {
 *         "command": "bunx",
 *         "args": ["@prime-lang/mcp-server-core"],
 *         "env": { "PRIME_DIR": "/abs/path/to/compiled" }
 *       }
 *     }
 *   }
 *
 * Tool surface:
 *
 *   prime_query({
 *     scope: "atoms" | "related" | "show",
 *     query?: string,            // for scope=atoms: keyword(s)
 *     id?: string,               // for scope=related|show: atom id
 *     level?: "summary" | "core" | "full",  // for scope=show
 *     kind?: string,             // optional filter (e.g. "rule", "pattern")
 *     limit?: number,            // top-N (default 10)
 *   })
 *     → {
 *         results: Array<{ id, kind, description, tokens, level, path }>,
 *         total_index_tokens: number,
 *       }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "fs";
import { join, resolve as resolveFsPath } from "path";
import {
  loadIndex,
  loadAtomMeta,
  resolveProjection,
  type GlobalIndex,
  discoverDomains,
  DomainRegistry,
  registerAll,
  type DomainPlugin,
} from "@prime-lang/runtime";

// ─── Config ──────────────────────────────────────────────────────────────

const PRIME_DIR = process.env.PRIME_DIR;
if (!PRIME_DIR) {
  console.error(
    "[prime-mcp-core] PRIME_DIR is required. Set it to the absolute path of " +
      "your compiled corpus (the directory containing `_index.xml`).",
  );
  process.exit(1);
}
if (!existsSync(join(PRIME_DIR, "_index.xml"))) {
  console.error(
    `[prime-mcp-core] PRIME_DIR=${PRIME_DIR} does not contain an _index.xml. ` +
      "Did you forget to run `prime compile`?",
  );
  process.exit(1);
}

// ─── Load index once at boot ─────────────────────────────────────────────

console.error("[prime-mcp-core] Loading corpus index...");
let index: GlobalIndex;
try {
  index = loadIndex(PRIME_DIR);
} catch (err) {
  console.error(`[prime-mcp-core] index load failed: ${err}`);
  process.exit(1);
}
console.error(
  `[prime-mcp-core] ${index.total} atoms · ${index.totalTokens} tokens · ` +
    `${index.clusters.length} clusters`,
);

// ─── Domain discovery ─────────────────────────────────────────────────────
//
// Searches for domain.yaml files in the following roots (processed in order;
// PRIME_DOMAINS_DIR env var takes precedence inside discoverDomains itself):
//
//   1. PRIME_DOMAINS_DIR env var  — single flat dir, one level deep
//   2. <PRIME_DIR>/../            — e.g. compiled/../ = corpus root
//   3. process.cwd()              — repo root (monorepo and direct-run setups)
//
// If no domain.yaml files are found the server still works; ranking falls
// back to the plain keyword scorer with no domain bias.

const domainRegistry = new DomainRegistry();

{
  // Collect unique search roots. discoverDomains respects PRIME_DOMAINS_DIR
  // internally so we don't need to special-case it here — we just ensure the
  // standard corpus-root and cwd are both scanned when that env is unset.
  const primeParent = resolveFsPath(PRIME_DIR, "..");
  const cwd = process.cwd();
  const roots = [primeParent];
  if (cwd !== primeParent) roots.push(cwd);

  const allPlugins: DomainPlugin[] = [];
  const seenNames = new Set<string>();

  for (const root of roots) {
    for (const p of discoverDomains(root)) {
      if (!seenNames.has(p.name)) {
        seenNames.add(p.name);
        allPlugins.push(p);
      }
    }
  }

  registerAll(domainRegistry, allPlugins);

  const names = domainRegistry.names();
  if (names.length > 0) {
    console.error(
      `[prime-mcp-core] domains: ${names.length} (${names.join(", ")})`,
    );
  } else {
    console.error("[prime-mcp-core] domains: 0 (no domain.yaml found — plain ranking active)");
  }
}

// Build a flat lookup: id → entry. Atom-loader's `entries` traversal handles
// the cluster nesting; we just need a Map for O(1) id resolution.
const byId = new Map<string, (typeof index.clusters)[0]["atoms"][0]>();
for (const cluster of index.clusters) {
  for (const atom of cluster.atoms) byId.set(atom.id, atom);
}

// ─── Scoring (kept simple — extension points for domain wrappers below) ──
//
// Scoring is intentionally kind-agnostic: all 28 atom kinds are treated
// equally so that non-frontend corpora (legal, recipes, security, …) are
// not silently penalised.
//
// Domain wrappers that need kind-priority reranking should:
//   1. Call prime_query to retrieve a raw candidate set, then
//   2. Apply their own rerank (e.g. boost "step"/"transform" for a cooking
//      corpus, or "check"/"rule" for a security corpus) in the wrapper layer.
//
// If you need a corpus-wide default boost, set PRIME_KIND_BOOSTS as a
// JSON map, e.g.: PRIME_KIND_BOOSTS='{"rule":0.5,"pattern":0.4}'

interface QueryResult {
  id: string;
  kind: string;
  description: string;
  tokens: number;
  level: "summary" | "core" | "full";
  path: string;
}

// Optional per-corpus kind boost map, read once at startup.
// Format: PRIME_KIND_BOOSTS='{"rule":0.5,"pattern":0.4}'
// Defaults to an empty map (no boost for any kind).
const _rawBoosts = process.env.PRIME_KIND_BOOSTS;
const KIND_BOOSTS: Record<string, number> = (() => {
  if (!_rawBoosts) return {};
  try { return JSON.parse(_rawBoosts) as Record<string, number>; }
  catch { return {}; }
})();

// Build a flat set of all domain tag vocabularies for fast brief→domain matching.
// Key: tag (lowercased), value: domain name that owns it.
// When a query or atom description contains a word that matches a domain tag,
// the atom gets a small domain-aware boost (+0.5) so in-domain results rise
// to the top without hard-excluding any other kind. This is intentionally small
// to preserve the kind-agnostic nature of the base scorer.
const _domainTagIndex = new Map<string, string>(); // tag → domain name
for (const name of domainRegistry.names()) {
  const plugin = domainRegistry.get(name)!;
  for (const tag of plugin.tags) {
    if (!_domainTagIndex.has(tag.toLowerCase())) {
      _domainTagIndex.set(tag.toLowerCase(), name);
    }
  }
}

function scoreAtom(
  atom: { id: string; kind: string; description?: string },
  q: string,
): number {
  if (!q) return 0.5;
  const blob = `${atom.id} ${atom.kind} ${atom.description ?? ""}`.toLowerCase();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const t of tokens) {
    if (blob.includes(t)) score += 1;
    if (atom.id.toLowerCase().includes(t)) score += 0.5;
  }
  // Domain-aware boost: if any query token matches a registered domain's tag
  // vocabulary, give the atom a +0.5 lift. This replaces the former kind-boost
  // with a corpus-agnostic mechanism driven by domain.yaml declarations.
  // (Also works without any registered domains — _domainTagIndex will be empty.)
  if (_domainTagIndex.size > 0) {
    for (const t of tokens) {
      if (_domainTagIndex.has(t)) {
        score += 0.5;
        break; // one boost per atom per query, not per matched tag
      }
    }
  }
  // Apply optional corpus-specific kind boost (0 for all kinds by default).
  return score + (KIND_BOOSTS[atom.kind] ?? 0);
}

function makeResult(
  atom: { id: string; kind: string; description?: string; tokens?: number },
  level: "summary" | "core" | "full",
): QueryResult | null {
  const path = resolveProjection(PRIME_DIR!, atom.id, level);
  if (!path) return null;
  return {
    id: atom.id,
    kind: atom.kind,
    description: atom.description ?? "",
    tokens: atom.tokens ?? 0,
    level,
    path,
  };
}

// ─── MCP server + tool ───────────────────────────────────────────────────

const server = new McpServer(
  { name: "prime-mcp-core", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

interface PrimeQueryArgs {
  scope: "atoms" | "related" | "show";
  query?: string;
  id?: string;
  level?: "summary" | "core" | "full";
  kind?: string;
  limit?: number;
}

const PRIME_QUERY_SCHEMA = z.object({
  scope: z.enum(["atoms", "related", "show"]),
  query: z.string().optional(),
  id: z.string().optional(),
  level: z.enum(["summary", "core", "full"]).optional().default("core"),
  kind: z.string().optional(),
  limit: z.number().int().positive().max(100).optional().default(10),
});

server.tool(
  "prime_query",
  "Browse the Skill Wiki corpus. Returns atom paths the agent should Read — " +
    "never content. Three scopes: atoms (keyword search), related (edge-graph " +
    "traversal from a given id), show (resolve a specific id at a given level).",
  async (extra) => {
    const raw = (extra as unknown as { params?: { arguments?: unknown } }).params?.arguments ?? {};
    const parsed = PRIME_QUERY_SCHEMA.safeParse(raw);
    const { scope, query, id, level, kind, limit } = parsed.success
      ? parsed.data
      : { scope: "atoms" as const, query: undefined, id: undefined, level: "core" as const, kind: undefined, limit: 10 };
    let results: QueryResult[] = [];

    if (scope === "atoms") {
      const candidates: Array<{ atom: typeof byId extends Map<any, infer V> ? V : never; score: number }> = [];
      for (const atom of byId.values()) {
        if (kind && atom.kind !== kind) continue;
        candidates.push({ atom, score: scoreAtom(atom, query ?? "") });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates.slice(0, limit)) {
        const r = makeResult(c.atom, level);
        if (r) results.push(r);
      }
    } else if (scope === "show") {
      if (!id) {
        return { content: [{ type: "text", text: "scope=show requires `id`." }] };
      }
      const atom = byId.get(id);
      if (!atom) {
        return { content: [{ type: "text", text: `Atom not found: ${id}` }] };
      }
      const r = makeResult(atom, level);
      if (r) results = [r];
    } else if (scope === "related") {
      if (!id) {
        return { content: [{ type: "text", text: "scope=related requires `id`." }] };
      }
      const meta = loadAtomMeta(PRIME_DIR!, id);
      if (!meta) {
        return { content: [{ type: "text", text: `Atom not found: ${id}` }] };
      }
      const seen = new Set<string>([id]);
      for (const edge of meta.relations ?? []) {
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        const target = byId.get(edge.target);
        if (!target) continue;
        if (kind && target.kind !== kind) continue;
        const r = makeResult(target, level);
        if (r) results.push({ ...r, description: `[${edge.type}] ${r.description}` });
        if (results.length >= limit) break;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { results, total_index_tokens: index.totalTokens },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Boot ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "[prime-mcp-core] ready · tool: prime_query · stdio transport active",
);
