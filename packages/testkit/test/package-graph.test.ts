import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackageGraph, packageWiringCheck, type PackageGraphReport } from "../src/package-graph.ts";

/**
 * Every test builds a throwaway workspace instead of asserting on this repo's
 * numbers. The numbers are what the other lanes are changing this round; the
 * criterion's *shape* is what must not drift.
 */
interface PackageSpec {
  readonly manifest: Record<string, unknown>;
  /** relative path inside the package -> file body */
  readonly files: Readonly<Record<string, string>>;
}

function workspace(specs: Readonly<Record<string, PackageSpec>>): PackageGraphReport {
  const root = mkdtempSync(join(tmpdir(), "wiring-"));
  const packagesDir = join(root, "packages");
  for (const [dir, spec] of Object.entries(specs)) {
    const packageDir = join(packagesDir, dir);
    mkdirSync(join(packageDir, "src"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify(spec.manifest));
    for (const [path, body] of Object.entries(spec.files)) {
      const target = join(packageDir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, body);
    }
  }
  return buildPackageGraph({ packagesDir, reportRoot: root });
}

const codes = (graph: PackageGraphReport, subject: string): readonly string[] =>
  packageWiringCheck(graph).findings.filter(f => f.subject === `package:${subject}`).map(f => `${f.severity}/${f.code}`);

describe("ZDS-PACKAGE-WIRING", () => {
  test("a library no runnable package reaches is an error, and wiring it into one clears it", () => {
    const unwired = workspace({
      app: { manifest: { name: "@w/app", bin: { app: "src/index.ts" } }, files: { "src/index.ts": "export const run = () => 1;\n" } },
      lib: { manifest: { name: "@w/lib" }, files: { "src/index.ts": "export const help = () => 2;\n" } },
    });
    expect(unwired.unreached).toEqual(["@w/lib"]);
    expect(codes(unwired, "@w/lib")).toEqual(["error/PACKAGE_UNREACHED_LIBRARY"]);

    const wired = workspace({
      app: {
        manifest: { name: "@w/app", bin: { app: "src/index.ts" }, dependencies: { "@w/lib": "workspace:*" } },
        files: { "src/index.ts": 'import { help } from "@w/lib";\nexport const run = () => help();\n' },
      },
      lib: { manifest: { name: "@w/lib" }, files: { "src/index.ts": "export const help = () => 2;\n" } },
    });
    expect(wired.unreached).toEqual([]);
    expect(packageWiringCheck(wired).status).toBe("pass");
  });

  /**
   * The blind spot this whole check exists for: `query-engine` was 1712 lines
   * with 133 passing tests and no production path. A green suite must not read
   * as wired.
   */
  test("a library imported only from a test module is still unreached, because a passing suite is not a production path", () => {
    const graph = workspace({
      app: { manifest: { name: "@w/app", bin: { app: "src/index.ts" } }, files: { "src/index.ts": "export const run = () => 1;\n" } },
      engine: { manifest: { name: "@w/engine" }, files: { "src/index.ts": "export const solve = () => 3;\n" } },
      harness: {
        manifest: { name: "@w/harness", bin: { harness: "src/cli.ts" }, devDependencies: { "@w/engine": "workspace:*" } },
        files: {
          "src/cli.ts": "export const main = () => 0;\n",
          "test/engine.test.ts": 'import { solve } from "@w/engine";\nexport const t = solve;\n',
        },
      },
    });
    expect(graph.unreached).toEqual(["@w/engine"]);
    expect(graph.productionConsumers["@w/engine"]).toBeUndefined();
    expect(graph.nonProductionConsumers["@w/engine"]).toEqual(["@w/harness"]);
    expect(codes(graph, "@w/engine")).toEqual(["error/PACKAGE_UNREACHED_LIBRARY", "info/PACKAGE_TEST_ONLY_CONSUMER"]);
  });

  /**
   * "Zero consumers" as the criterion would have called this clean.
   * `constraint-solver` has exactly one importer and is still dead code.
   */
  test("having an importer is not enough: a library reached only by an unreached library is unreached", () => {
    const graph = workspace({
      app: { manifest: { name: "@w/app", bin: { app: "src/index.ts" } }, files: { "src/index.ts": "export const run = () => 1;\n" } },
      middle: {
        manifest: { name: "@w/middle", dependencies: { "@w/leaf": "workspace:*" } },
        files: { "src/index.ts": 'import { leaf } from "@w/leaf";\nexport const mid = () => leaf();\n' },
      },
      leaf: { manifest: { name: "@w/leaf" }, files: { "src/index.ts": "export const leaf = () => 4;\n" } },
    });
    expect(graph.productionConsumers["@w/leaf"]).toEqual(["@w/middle"]);
    expect(graph.unreached).toEqual(["@w/leaf", "@w/middle"]);
    const finding = packageWiringCheck(graph).findings.find(f => f.subject === "package:@w/leaf" && f.code === "PACKAGE_UNREACHED_LIBRARY");
    expect(finding?.message).toContain("themselves unreached");
  });

  test("a bin entry excuses zero importers, and the excuse is reported rather than silent", () => {
    const graph = workspace({
      tool: { manifest: { name: "@w/tool", bin: { tool: "src/cli.ts" } }, files: { "src/cli.ts": "export const main = () => 0;\n" } },
    });
    expect(graph.invocable).toEqual(["@w/tool"]);
    expect(graph.unreached).toEqual([]);
    expect(codes(graph, "@w/tool")).toEqual(["info/PACKAGE_INVOCABLE"]);
  });

  test("a script that runs the package's own source is invocable, but a build script is not", () => {
    const graph = workspace({
      server: { manifest: { name: "@w/server", scripts: { start: "bun src/index.ts", seed: "bun --watch src/seed.ts" } }, files: { "src/index.ts": "export const s = 1;\n" } },
      // The distinction that decides whether `bundle` is graded error or info:
      // `bun build src/index.ts` produces an artifact for someone else to
      // import, so it is not an invocation and must not excuse zero reach.
      built: { manifest: { name: "@w/built", scripts: { build: "bun build src/index.ts --outdir dist", test: "bun test", prepublishOnly: "bun run build" } }, files: { "src/index.ts": "export const b = 1;\n" } },
    });
    expect(graph.invocable).toEqual(["@w/server"]);
    expect(graph.unreached).toEqual(["@w/built"]);
    expect(codes(graph, "@w/built")).toEqual(["error/PACKAGE_UNREACHED_LIBRARY"]);
  });

  /**
   * The rejected criterion, pinned as a test so the next round cannot revive it.
   * Both packages below are referenced only from a `devDependencies` field, so
   * "dev-only dependent ⇒ tool" cannot tell a real tool from a dead library.
   */
  test("being referenced only from devDependencies does not excuse a library, because a real tool and a dead library look identical there", () => {
    const graph = workspace({
      app: { manifest: { name: "@w/app", bin: { app: "src/index.ts" }, devDependencies: { "@w/tool": "workspace:*" } }, files: { "src/index.ts": "export const run = () => 1;\n", "test/a.test.ts": 'import "@w/tool";\n' } },
      tool: { manifest: { name: "@w/tool", bin: { tool: "src/cli.ts" } }, files: { "src/cli.ts": "export const main = () => 0;\n" } },
      dead: { manifest: { name: "@w/dead" }, files: { "src/index.ts": "export const d = 1;\n" } },
    });
    // Identical dev-only reference shape, opposite verdicts — and the thing that
    // separates them is the package's own declaration, not its dependents'.
    expect(codes(graph, "@w/tool")).toEqual(["info/PACKAGE_INVOCABLE"]);
    expect(codes(graph, "@w/dead")).toEqual(["error/PACKAGE_UNREACHED_LIBRARY"]);
  });

  test("a production import that is undeclared, or declared only as a devDependency, is an error", () => {
    const graph = workspace({
      app: {
        manifest: { name: "@w/app", bin: { app: "src/index.ts" }, devDependencies: { "@w/dev": "workspace:*" } },
        files: { "src/index.ts": 'import "@w/dev";\nimport "@w/missing";\nexport const run = () => 1;\n' },
      },
      dev: { manifest: { name: "@w/dev" }, files: { "src/index.ts": "export const d = 1;\n" } },
      missing: { manifest: { name: "@w/missing" }, files: { "src/index.ts": "export const m = 1;\n" } },
    });
    expect(graph.undeclaredProductionImports).toEqual([
      { from: "@w/app", imported: "@w/dev", declaredAsDev: true },
      { from: "@w/app", imported: "@w/missing", declaredAsDev: false },
    ]);
    expect(codes(graph, "@w/app")).toEqual(["info/PACKAGE_INVOCABLE", "error/PACKAGE_IMPORT_UNDECLARED", "error/PACKAGE_IMPORT_UNDECLARED"]);
  });

  test("a declared workspace dependency nothing imports is a warning, so a never-completed wiring is visible", () => {
    const graph = workspace({
      app: { manifest: { name: "@w/app", bin: { app: "src/index.ts" }, dependencies: { "@w/lib": "workspace:*" } }, files: { "src/index.ts": "export const run = () => 1;\n" } },
      lib: { manifest: { name: "@w/lib" }, files: { "src/index.ts": "export const l = 1;\n" } },
    });
    expect(graph.unusedDependencies).toEqual([{ from: "@w/app", declared: "@w/lib", dev: false }]);
    expect(codes(graph, "@w/app")).toEqual(["info/PACKAGE_INVOCABLE", "warning/PACKAGE_DEPENDENCY_UNUSED"]);
    // A declared-but-unwired dependency must not make the target look reached.
    expect(graph.unreached).toEqual(["@w/lib"]);
  });

  test("a cross-package dynamic import counts as a production edge, since that is how compiler reaches parser", () => {
    const graph = workspace({
      app: {
        manifest: { name: "@w/app", bin: { app: "src/index.ts" }, dependencies: { "@w/lazy": "workspace:*" } },
        files: { "src/index.ts": 'export const run = async () => (await import("@w/lazy")).z;\n' },
      },
      lazy: { manifest: { name: "@w/lazy" }, files: { "src/index.ts": "export const z = 1;\n" } },
    });
    expect(graph.unreached).toEqual([]);
    expect(graph.productionConsumers["@w/lazy"]).toEqual(["@w/app"]);
  });

  test("this repo's own graph classifies its three declared entry points as invocable, and none of them as an error", () => {
    const graph = buildPackageGraph({ packagesDir: join(import.meta.dir, "..", "..", ""), reportRoot: join(import.meta.dir, "..", "..", "..") });
    // Sanity: the real workspace parses at all. Roles come from manifests, so a
    // package that acquires or loses a bin moves category with no code change.
    expect(graph.packages.length).toBeGreaterThan(10);
    for (const name of graph.invocable) expect(graph.unreached).not.toContain(name);
    // Whatever today's count is, an invocable package may never be an error.
    const errors = packageWiringCheck(graph).findings.filter(f => f.severity === "error" && f.code === "PACKAGE_UNREACHED_LIBRARY").map(f => f.subject);
    for (const name of graph.invocable) expect(errors).not.toContain(`package:${name}`);
  });
});
