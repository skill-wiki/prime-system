/**
 * Tests for the dependency resolver.
 */

import { describe, test, expect } from "bun:test";
import { resolve } from "../src/resolver";
import type {
  PrimeAST,
  FieldNode,
  ArrayNode,
  StringNode,
  LinkShorthandNode,
  ReferenceNode,
} from "@aoe/types";
import type { InstalledPrime } from "../src/types";

// ─── Test Helpers ──────────────────────────────────────────────────────────

const loc = (line: number) => ({ line, column: 1, offset: 0 });

function makeField(key: string, value: any): FieldNode {
  return { type: "Field", key, value, loc: value.loc || loc(1) };
}

function makeString(value: string, line = 1): StringNode {
  return { type: "String", value, loc: loc(line) };
}

function makeArray(items: any[], line = 1): ArrayNode {
  return { type: "Array", items, loc: loc(line) };
}

function makeLinkShorthand(
  verb: string,
  target: string,
  line = 1
): LinkShorthandNode {
  return { type: "LinkShorthand", verb, target, loc: loc(line) };
}

function makeRef(name: string, line = 1): ReferenceNode {
  return { type: "Reference", path: [name], loc: loc(line) };
}

function makeAST(
  name: string,
  opts: {
    baseClass?: string;
    uses?: Array<{ name: string; line?: number }>;
    links?: Array<{ verb: string; target: string; line?: number }>;
    version?: string;
  } = {}
): PrimeAST {
  const {
    baseClass = "Method",
    uses = [],
    links = [],
    version = "1.0.0",
  } = opts;

  const body: FieldNode[] = [
    makeField("name", makeString(name, 2)),
    makeField("version", makeString(version, 3)),
  ];

  if (uses.length > 0) {
    body.push(
      makeField(
        "use",
        makeArray(
          uses.map((u) => makeRef(u.name, u.line || 5)),
          4
        )
      )
    );
  }

  if (links.length > 0) {
    body.push(
      makeField(
        "links",
        makeArray(
          links.map((l) => makeLinkShorthand(l.verb, l.target, l.line || 10)),
          9
        )
      )
    );
  }

  return {
    type: "PrimeDeclaration",
    name: name.replace(/-./g, (m) => m[1].toUpperCase()).replace(/^./, (m) => m.toUpperCase()),
    extends: baseClass,
    decorators: [],
    body,
    loc: loc(1),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("resolver", () => {
  describe("simple dependency resolution", () => {
    test("resolves a single use[] dependency", () => {
      const installed = new Map<string, InstalledPrime>();
      installed.set("test-coverage-standard", {
        name: "test-coverage-standard",
        version: "1.0.0",
        type: "Rule",
      });

      const ast = makeAST("tdd-method", {
        uses: [{ name: "test-coverage-standard" }],
      });

      const { graph, diagnostics } = resolve(ast, installed);

      expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
      expect(graph.nodes).toHaveLength(2);
      expect(graph.nodes.some((n) => n.id === "tdd-method")).toBe(true);
      expect(graph.nodes.some((n) => n.id === "test-coverage-standard")).toBe(true);
      expect(graph.edges).toHaveLength(1);
      expect(graph.edges[0].from).toBe("tdd-method");
      expect(graph.edges[0].to).toBe("test-coverage-standard");
    });

    test("resolves transitive dependencies", () => {
      const installed = new Map<string, InstalledPrime>();

      // A depends on B, B depends on C
      installed.set("dep-b", {
        name: "dep-b",
        version: "1.0.0",
        type: "Method",
        links: [{ type: "requires", to: "dep-c" }],
      });
      installed.set("dep-c", {
        name: "dep-c",
        version: "1.0.0",
        type: "Knowledge",
      });

      const ast = makeAST("root-prime", {
        uses: [{ name: "dep-b" }],
      });

      const { graph, diagnostics } = resolve(ast, installed);

      expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
      expect(graph.nodes).toHaveLength(3);
      expect(graph.nodes.some((n) => n.id === "dep-c")).toBe(true);
    });

    test("produces correct load order", () => {
      const installed = new Map<string, InstalledPrime>();
      installed.set("dep-a", {
        name: "dep-a",
        version: "1.0.0",
        type: "Knowledge",
      });

      const ast = makeAST("main-prime", {
        uses: [{ name: "dep-a" }],
      });

      const { graph } = resolve(ast, installed);

      // dep-a should come before main-prime in load order
      const depIdx = graph.loadOrder.indexOf("dep-a");
      const mainIdx = graph.loadOrder.indexOf("main-prime");
      expect(depIdx).toBeLessThan(mainIdx);
    });
  });

  describe("circular dependency detection", () => {
    test("detects direct circular dependencies", () => {
      const installed = new Map<string, InstalledPrime>();

      // A -> B -> A (circular)
      installed.set("prime-b", {
        name: "prime-b",
        version: "1.0.0",
        type: "Method",
        links: [{ type: "requires", to: "prime-a" }],
      });
      installed.set("prime-a", {
        name: "prime-a",
        version: "1.0.0",
        type: "Method",
      });

      const ast = makeAST("prime-a", {
        uses: [{ name: "prime-b" }],
      });

      const { diagnostics } = resolve(ast, installed);
      const circularErrors = diagnostics.filter(
        (d) => d.level === "error" && d.message.includes("Circular")
      );
      expect(circularErrors.length).toBeGreaterThanOrEqual(1);
    });

    test("detects transitive circular dependencies", () => {
      const installed = new Map<string, InstalledPrime>();

      // A -> B -> C -> A (circular via 3 nodes)
      installed.set("node-b", {
        name: "node-b",
        version: "1.0.0",
        type: "Method",
        links: [{ type: "requires", to: "node-c" }],
      });
      installed.set("node-c", {
        name: "node-c",
        version: "1.0.0",
        type: "Method",
        links: [{ type: "requires", to: "node-a" }],
      });
      installed.set("node-a", {
        name: "node-a",
        version: "1.0.0",
        type: "Method",
      });

      const ast = makeAST("node-a", {
        uses: [{ name: "node-b" }],
      });

      const { diagnostics } = resolve(ast, installed);
      const circularErrors = diagnostics.filter(
        (d) => d.level === "error" && d.message.includes("Circular")
      );
      expect(circularErrors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("exclusion conflict detection", () => {
    test("detects an exclusion conflict when both sides are in dependency tree", () => {
      const installed = new Map<string, InstalledPrime>();

      installed.set("tdd-method", {
        name: "tdd-method",
        version: "1.0.0",
        type: "Method",
      });
      installed.set("waterfall-testing", {
        name: "waterfall-testing",
        version: "1.0.0",
        type: "Method",
      });

      // Root uses tdd-method and waterfall-testing,
      // and tdd-method contradicts waterfall-testing
      const ast = makeAST("mixed-skill", {
        uses: [
          { name: "tdd-method", line: 5 },
          { name: "waterfall-testing", line: 6 },
        ],
        links: [
          { verb: "contradicts", target: "waterfall-testing", line: 10 },
        ],
      });

      const { diagnostics } = resolve(ast, installed);
      const contradictErrors = diagnostics.filter(
        (d) => d.level === "error" && d.message.includes("contradicts conflict")
      );
      expect(contradictErrors.length).toBeGreaterThanOrEqual(1);
    });

    test("does not report an exclusion conflict when only one side is present", () => {
      const installed = new Map<string, InstalledPrime>();

      installed.set("tdd-method", {
        name: "tdd-method",
        version: "1.0.0",
        type: "Method",
      });
      // waterfall-testing is NOT in the dependency tree

      const ast = makeAST("safe-skill", {
        uses: [{ name: "tdd-method" }],
        links: [
          { verb: "contradicts", target: "waterfall-testing", line: 10 },
        ],
      });

      const { diagnostics } = resolve(ast, installed);
      const contradictErrors = diagnostics.filter(
        (d) => d.level === "error" && d.message.includes("contradicts conflict")
      );
      // waterfall-testing is not in the tree, so no conflict
      expect(contradictErrors).toHaveLength(0);
    });
  });

  describe("deduplication", () => {
    test("deduplicates Primes reached via multiple paths", () => {
      const installed = new Map<string, InstalledPrime>();

      // Both dep-x and dep-y depend on shared-dep
      installed.set("dep-x", {
        name: "dep-x",
        version: "1.0.0",
        type: "Method",
        links: [{ type: "requires", to: "shared-dep" }],
      });
      installed.set("dep-y", {
        name: "dep-y",
        version: "1.0.0",
        type: "Method",
        links: [{ type: "requires", to: "shared-dep" }],
      });
      installed.set("shared-dep", {
        name: "shared-dep",
        version: "1.0.0",
        type: "Knowledge",
      });

      const ast = makeAST("root", {
        uses: [
          { name: "dep-x" },
          { name: "dep-y" },
        ],
      });

      const { graph, diagnostics } = resolve(ast, installed);

      // shared-dep should only appear once in nodes
      const sharedNodes = graph.nodes.filter((n) => n.id === "shared-dep");
      expect(sharedNodes).toHaveLength(1);

      // No errors
      expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(0);

      // Total unique nodes: root + dep-x + dep-y + shared-dep = 4
      expect(graph.nodes).toHaveLength(4);
    });
  });

  describe("version conflict detection", () => {
    test("detects version conflicts for the same dependency", () => {
      const installed = new Map<string, InstalledPrime>();

      installed.set("common-dep", {
        name: "common-dep",
        version: "1.0.0",
        type: "Knowledge",
      });

      // Root uses common-dep via two references with different versions
      const ast: PrimeAST = {
        type: "PrimeDeclaration",
        name: "Root",
        extends: "Method",
        decorators: [],
        body: [
          makeField("name", makeString("root-prime", 2)),
          makeField("version", makeString("1.0.0", 3)),
          makeField(
            "use",
            makeArray([
              { type: "Reference" as const, path: ["common-dep", "1.0.0"], loc: loc(5) },
              { type: "Reference" as const, path: ["common-dep", "2.0.0"], loc: loc(6) },
            ], 4)
          ),
        ],
        loc: loc(1),
      };

      const { diagnostics } = resolve(ast, installed);
      const versionErrors = diagnostics.filter(
        (d) => d.level === "error" && d.message.includes("Version conflict")
      );
      expect(versionErrors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("link types", () => {
    test("resolves links[] with various verb types", () => {
      const installed = new Map<string, InstalledPrime>();
      installed.set("owasp-top-10", {
        name: "owasp-top-10",
        version: "1.3.0",
        type: "Knowledge",
      });
      installed.set("security-checklist", {
        name: "security-checklist",
        version: "1.0.0",
        type: "Rule",
      });
      installed.set("dependency-audit", {
        name: "dependency-audit",
        version: "1.0.0",
        type: "Method",
      });

      const ast = makeAST("security-stride", {
        links: [
          { verb: "requires", target: "owasp-top-10" },
          { verb: "validates_with", target: "security-checklist" },
          { verb: "enhances", target: "dependency-audit" },
        ],
      });

      const { graph, diagnostics } = resolve(ast, installed);

      expect(diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
      expect(graph.nodes).toHaveLength(4); // root + 3 deps

      // Edge types are now the model's canonical relation names, not the v1
      // upper-case wire forms the resolver used to invent. `validates_with` is
      // a declared alias of `validates-with`, so the alias resolves to the
      // canonical spelling.
      const requiresEdge = graph.edges.find((e) => e.to === "owasp-top-10");
      expect(requiresEdge?.type).toBe("requires");
      // `requires` declares selection: closure — the target is mandatory.
      expect(requiresEdge?.required).toBe(true);

      const validatesEdge = graph.edges.find((e) => e.to === "security-checklist");
      expect(validatesEdge?.type).toBe("validates-with");
      // selection: informational — the old switch table said `true` here, which
      // no model field supports. See lane report W4-B §5.
      expect(validatesEdge?.required).toBe(false);
      // loadOrder: after
      expect(validatesEdge?.direction).toBe("after");

      const enhancesEdge = graph.edges.find((e) => e.to === "dependency-audit");
      expect(enhancesEdge?.type).toBe("enhances");
      expect(enhancesEdge?.required).toBe(false);
    });

    test("load direction comes from the model, not from a switch table", () => {
      const installed = new Map<string, InstalledPrime>();
      for (const name of ["upstream-fact", "downstream-method"]) {
        installed.set(name, { name, version: "1.0.0", type: "Knowledge" });
      }

      const ast = makeAST("supplier", {
        links: [{ verb: "supplies_to", target: "downstream-method" }],
      });

      const { graph } = resolve(ast, installed);
      const edge = graph.edges.find((e) => e.to === "downstream-method");

      // D-7: `supplies-to` declares loadOrder: after in the model
      // (protocolSemantic: source-supplier-precedes-target). The switch table
      // this replaced returned "before", i.e. the opposite.
      expect(edge?.type).toBe("supplies-to");
      expect(edge?.direction).toBe("after");
    });

    test("an undeclared verb is carried through without invented semantics", () => {
      const installed = new Map<string, InstalledPrime>();
      installed.set("some-target", { name: "some-target", version: "1.0.0", type: "Knowledge" });

      const ast = makeAST("root", {
        links: [{ verb: "x-model-never-declared-this", target: "some-target" }],
      });

      const { graph } = resolve(ast, installed);
      const edge = graph.edges.find((e) => e.to === "some-target");

      expect(edge?.type).toBe("x-model-never-declared-this");
      expect(edge?.direction).toBe("any");
      expect(edge?.required).toBe(false);
    });
  });
});
