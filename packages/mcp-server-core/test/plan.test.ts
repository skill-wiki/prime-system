/**
 * `aoe_plan` and the MCP protocol layer.
 *
 * Two gaps are closed here, both named in `docs/lanes/W9-A-PHASE0-SPLIT-BRAIN.md`:
 *
 * §4.1 — there was no plan capability at all, so Phase 0's first acceptance
 * criterion ("query/plan/show report the same release/digest") had no third
 * party to compare against. It does now, and the comparison is asserted.
 *
 * §7.3 — *nothing* in this package's suite went through `createAoeMcpServer`
 * or the protocol, which is how a P0 (`tool(name, desc, cb)` registering
 * zero-argument tools, so arguments never reached a handler) survived eight
 * rounds behind 32 green tests. The `inputSchema.properties` assertions below are
 * exactly the shape that bug would have failed.
 */
import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadCorpusSnapshot, loadAtomMeta, loadIndex } from "@skill-wiki/runtime";
import type { SnapshotRef as IrSnapshotRef } from "@skill-wiki/ir";
import type { Principal } from "@skill-wiki/query-engine";
import { buildCorpusGraph } from "../src/corpus-graph";
import { loadServeModel, resolveModelRoot } from "../src/model-context";
import { createAoeMcpServer } from "../src/index";
import { executeAoePlan, executeAoeQuery, type ServeOptions } from "../src/serve";

const CORPUS = resolve(join(import.meta.dir, "../../../examples/hello-world/primes/compiled"));
const TEA = "@example/method-make-tea";

const PRINCIPAL: Principal = {
  id: "test",
  allowedVisibility: ["private", "shared", "public"],
  grantedPolicyLabels: [],
};

function serve(): ServeOptions {
  const index = loadIndex(CORPUS);
  const loaded = loadCorpusSnapshot(CORPUS, {});
  const model = loadServeModel(resolveModelRoot(CORPUS, {}));
  const snapshot: IrSnapshotRef = {
    modelRelease: model.model.manifest.version,
    modelDigest: loaded.snapshot.schemaDigest,
    corpusRelease: loaded.snapshot.release,
    corpusDigest: loaded.snapshot.contentDigest,
  };
  return {
    model,
    corpus: buildCorpusGraph({
      atoms: index.atoms,
      loadMeta: (id) => loadAtomMeta(CORPUS, id),
      snapshot,
      corpus: loaded.snapshot.corpus,
    }),
    bundleRoot: CORPUS,
    scope: {
      tenant: "local",
      workspace: "local",
      corpus: loaded.snapshot.corpus,
      release: loaded.snapshot.release,
      snapshot,
    },
    principal: PRINCIPAL,
    transport: "path",
    maxTokens: 8000,
  };
}

describe("executeAoePlan", () => {
  it("refuses a request with neither query nor seeds instead of enumerating", () => {
    const outcome = executeAoePlan({}, serve());
    if (!("error" in outcome)) throw new Error("expected a refusal");
    expect(outcome.error).toMatch(/requires `query` or `seeds`/);
  });

  it("treats an empty seeds array as no retrieval signal", () => {
    expect("error" in executeAoePlan({ seeds: [] }, serve())).toBe(true);
  });

  it("returns the selection plan itself, including the arithmetic behind it", () => {
    const outcome = executeAoePlan({ query: "tea" }, serve());
    if ("error" in outcome) throw new Error(outcome.error);
    const plan = outcome.plan;
    // A plan is only useful if it explains itself: candidates with per-axis
    // features, the projection loads the budget could afford, and a budget report.
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.selected.length).toBeGreaterThan(0);
    expect(plan.budget).toBeDefined();
    expect(plan.projectionLoads.length).toBeGreaterThan(0);
    expect(plan.snapshot.corpusRelease).toBeTruthy();
  });

  it("plans from seeds alone, so the graph axis is reachable without query text", () => {
    const outcome = executeAoePlan({ seeds: [TEA] }, serve());
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.plan.candidates.length).toBeGreaterThan(0);
  });

  it("is the same plan aoe_query renders, not a second opinion", () => {
    // This is the property that makes the tool honest. If plan and query built
    // their requests separately they could disagree, and a plan that does not
    // describe the query it claims to explain is worse than no plan tool.
    const options = serve();
    const plan = executeAoePlan({ query: "tea" }, options);
    if ("error" in plan) throw new Error(plan.error);
    const query = executeAoeQuery({ scope: "atoms", query: "tea", limit: 10 }, options);
    if ("error" in query) throw new Error(query.error);
    const planned = plan.plan.projectionLoads.flatMap((load) => load.unitIds);
    expect(query.results.map((result) => result.id)).toEqual(planned);
  });

  it("reports a narrower plan when a required facet excludes everything", () => {
    const outcome = executeAoePlan({ query: "tea", kind: "no-such-type" }, serve());
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.plan.selected).toHaveLength(0);
  });
});

describe("the MCP protocol surface", () => {
  async function connect() {
    const instance = createAoeMcpServer({ corpusDir: CORPUS, environment: {}, stderr: { error: () => {} } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "w10a-test", version: "0.0.0" });
    await Promise.all([instance.server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, instance };
  }

  function payload(result: unknown): Record<string, unknown> {
    const content = (result as { content: { type: string; text: string }[] }).content[0]!;
    return JSON.parse(content.text) as Record<string, unknown>;
  }

  it("advertises every tool with a non-empty inputSchema", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["aoe_plan", "aoe_query", "aoe_resource"]);
    for (const tool of listed.tools) {
      // The exact assertion the zero-argument-registration P0 would fail: a tool
      // registered through the deprecated three-argument overload advertises no
      // properties at all, so no client can call it correctly.
      expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
    }
    await client.close();
  });

  it("requires `scope` on aoe_query and `uri` on aoe_resource at the protocol level", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    const required = new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema.required ?? []]));
    expect(required.get("aoe_query")).toContain("scope");
    expect(required.get("aoe_resource")).toContain("uri");
    await client.close();
  });

  it("reports one and the same snapshot from query, plan and show (Phase 0 acceptance 1)", async () => {
    const { client } = await connect();
    const atoms = payload(await client.callTool({ name: "aoe_query", arguments: { scope: "atoms", limit: 2 } }));
    const show = payload(await client.callTool({ name: "aoe_query", arguments: { scope: "show", id: TEA } }));
    const plan = payload(await client.callTool({ name: "aoe_plan", arguments: { query: "tea" } }));
    expect(plan.snapshot).toEqual(atoms.snapshot);
    expect(show.snapshot).toEqual(atoms.snapshot);
    await client.close();
  });

  it("delivers arguments to aoe_plan rather than silently defaulting them", async () => {
    const { client } = await connect();
    const refused = await client.callTool({ name: "aoe_plan", arguments: {} });
    expect((refused as { content: { text: string }[] }).content[0]!.text).toMatch(/requires `query` or `seeds`/);
    const planned = payload(await client.callTool({ name: "aoe_plan", arguments: { query: "tea" } }));
    expect((planned.plan as { selected: unknown[] }).selected.length).toBeGreaterThan(0);
    await client.close();
  });

  it("reports an out-of-schema argument as an error result instead of querying something else", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "aoe_query", arguments: { scope: "not-a-scope" } }) as {
      isError?: boolean;
      content: { text: string }[];
    };
    // The SDK validates against the declared `inputSchema` and answers with a
    // tool error result rather than throwing at the client. What matters is that
    // the call did NOT succeed with a substituted default scope — that silent
    // substitution is exactly the pre-cutover P0 (W9-A §2.2).
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toMatch(/"results"/);
    await client.close();
  });
});
