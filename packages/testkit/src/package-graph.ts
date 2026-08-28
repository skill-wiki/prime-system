import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { check, finding, type CheckOutcome, type Finding } from "./diagnostics.ts";
import { reachableFrom } from "./domain-scan.ts";

/**
 * The blind spot both earlier scanner generations share.
 *
 * `ZDS-CORE-VOCABULARY` and `ZDS-CORE-CLOSED-SETS` ask "does this code know a
 * domain's names?". Neither asks "does anything run this code?". A package can
 * be 100% tested, carry zero domain words and zero closed-set literals, and
 * still have no effect on production — which is the state 4245 lines of engine
 * code were found in by hand, not by either gate.
 *
 * This gate measures reachability of the *package* graph, using the same
 * production-tier definition `domain-scan.ts` already uses for the module graph
 * (`reachableFrom`: the static-import closure of the declared entry points). A
 * test file is not in that closure, so a package that only its own tests and a
 * harness import is correctly counted as unreached.
 */

/**
 * Why a package may legitimately have no importers.
 *
 * The naive criterion — "no one imports it" — misfires on every entry point and
 * every tool, which is most of the outer layer of plan §15.2. So role is derived
 * from what the package's own manifest *declares about how it is used*, and the
 * two cases are structurally identical rather than two separate heuristics:
 *
 * - `invocable`: the manifest says the package is **run**, not imported —
 *   either a `bin` entry (npm's own declaration of an executable) or a script
 *   that executes a file inside the package's own source tree. Nothing is
 *   expected to import it, so zero importers is its normal, correct state.
 * - `library`: everything else. Its only way to affect production is for
 *   something that runs to reach it. Zero reach is therefore a defect.
 *
 * Deliberately NOT used as a signal: whether dependents list the package under
 * `devDependencies`. That looked like the way to separate a test tool from a
 * library, and it does not work — `bundle` and `testkit` are both referenced
 * only from a `devDependencies` field, yet `bundle` sits on the compile path
 * (§15.2 `artifact-store`) and its zero reach is exactly the defect we are
 * hunting. Using that signal would have graded `bundle` `info`.
 *
 * Also deliberately NOT used: the package's name. A list of "packages that are
 * allowed to be unconsumed" is the same failure mode as a hardcoded closed set:
 * it goes stale silently and it makes the ruler carry the knowledge it is
 * supposed to be measuring.
 */
export type PackageRole = "invocable" | "library";

/**
 * A script that runs the package's own source, as opposed to one that builds or
 * tests it. `bun build src/index.ts` produces an artifact for someone else to
 * import; `bun src/seed.ts` and `bun --watch src/index.ts` are invocations. The
 * distinction is positional: only flags may sit between the runtime and the
 * path, so a subcommand (`build`, `run`, `test`) breaks the match.
 */
const RUNS_OWN_SOURCE = /(?:^|&&|\|\||;)\s*(?:bun|bunx|node|tsx|ts-node|deno)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:\.\/)?src\//;

export interface WorkspacePackage {
  /** Declared package name, e.g. `@scope/query-engine`. */
  readonly name: string;
  /** Repo-relative directory, e.g. `packages/query-engine`. */
  readonly dir: string;
  readonly role: PackageRole;
  /** Which manifest field made it `invocable`. Empty for a library. */
  readonly roleEvidence: readonly string[];
  /** Workspace names in `dependencies`. */
  readonly dependencies: readonly string[];
  /** Workspace names in `devDependencies`. */
  readonly devDependencies: readonly string[];
  /** Workspace names imported from a module inside the production closure. */
  readonly productionImports: readonly string[];
  /** Workspace names imported only from modules outside it (tests, fixtures, dead files). */
  readonly nonProductionImports: readonly string[];
  readonly productionFiles: number;
  /** Lines of TypeScript inside the production closure — the size of what is or is not wired. */
  readonly productionLines: number;
}

export interface PackageGraphReport {
  readonly packages: readonly WorkspacePackage[];
  /** Packages the manifests declare as run rather than imported. BFS roots. */
  readonly invocable: readonly string[];
  /** Every package reachable from `invocable` through production imports. */
  readonly reachable: readonly string[];
  /** Library packages nothing runnable reaches: the defect set. */
  readonly unreached: readonly string[];
  /** name -> packages whose production closure imports it. */
  readonly productionConsumers: Readonly<Record<string, readonly string[]>>;
  /** name -> packages that import it only from outside their production closure. */
  readonly nonProductionConsumers: Readonly<Record<string, readonly string[]>>;
  /** Production imports absent from `dependencies`: resolution working by luck. */
  readonly undeclaredProductionImports: readonly { readonly from: string; readonly imported: string; readonly declaredAsDev: boolean }[];
  /** Declared workspace dependencies nothing in the package imports at all. */
  readonly unusedDependencies: readonly { readonly from: string; readonly declared: string; readonly dev: boolean }[];
}

interface Manifest {
  readonly name?: unknown;
  readonly bin?: unknown;
  readonly scripts?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}

function readManifest(dir: string): Manifest | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function stringKeys(node: unknown): readonly string[] {
  return node !== null && typeof node === "object" ? Object.keys(node as Record<string, unknown>) : [];
}

function roleOf(manifest: Manifest): { readonly role: PackageRole; readonly evidence: readonly string[] } {
  const evidence: string[] = [];
  if (typeof manifest.bin === "string") evidence.push("bin");
  else for (const key of stringKeys(manifest.bin)) evidence.push(`bin.${key}`);
  const scripts = manifest.scripts;
  if (scripts !== null && typeof scripts === "object") {
    for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof command === "string" && RUNS_OWN_SOURCE.test(command)) evidence.push(`scripts.${name}`);
    }
  }
  return evidence.length > 0 ? { role: "invocable", evidence } : { role: "library", evidence: [] };
}

function walkTs(dir: string, out: string[]): void {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      walkTs(join(dir, entry.name), out);
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(join(dir, entry.name));
  }
}

/**
 * Also matches a bare side-effect `import "x";`, which the first draft missed.
 * That is a real production edge — a module loaded purely for its side effects
 * is loaded — and omitting it makes the gate fail *open*: the target reads as
 * unreached and gets deleted while something still depends on it.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|;\s*import\s+)["']([^"']+)["']/gm;

/** Which of `names` a source file imports. Subpath imports (`@s/x/y`) count as `@s/x`. */
function importedWorkspaceNames(source: string, names: ReadonlySet<string>): ReadonlySet<string> {
  const found = new Set<string>();
  SPECIFIER.lastIndex = 0;
  for (let m = SPECIFIER.exec(source); m !== null; m = SPECIFIER.exec(source)) {
    const specifier = m[1]!;
    for (const name of names) if (specifier === name || specifier.startsWith(`${name}/`)) found.add(name);
  }
  return found;
}

export interface PackageGraphOptions {
  /** Directory holding the workspace packages, e.g. `<repo>/packages`. */
  readonly packagesDir: string;
  /** Paths are reported relative to this. */
  readonly reportRoot: string;
}

export function buildPackageGraph(options: PackageGraphOptions): PackageGraphReport {
  const packagesDir = resolve(options.packagesDir);
  const reportRoot = resolve(options.reportRoot);
  const dirs = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(packagesDir, e.name)).sort()
    : [];

  const manifests = new Map<string, { readonly dir: string; readonly manifest: Manifest }>();
  for (const dir of dirs) {
    const manifest = readManifest(dir);
    // No manifest means no declared identity, so nothing can import it by name
    // and it cannot be part of the workspace graph at all.
    if (manifest === undefined || typeof manifest.name !== "string") continue;
    manifests.set(manifest.name, { dir, manifest });
  }
  const names = new Set(manifests.keys());

  const packages: WorkspacePackage[] = [];
  for (const [name, { dir, manifest }] of [...manifests].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const production = reachableFrom(dir);
    const all: string[] = [];
    walkTs(dir, all);
    const productionImports = new Set<string>();
    const anyImports = new Set<string>();
    let productionLines = 0;
    for (const file of all.sort()) {
      const source = readFileSync(file, "utf8");
      const imported = importedWorkspaceNames(source, names);
      for (const other of imported) if (other !== name) anyImports.add(other);
      if (!production.has(file)) continue;
      productionLines += source.split("\n").length;
      for (const other of imported) if (other !== name) productionImports.add(other);
    }
    const { role, evidence } = roleOf(manifest);
    packages.push({
      name,
      dir: relative(reportRoot, dir),
      role,
      roleEvidence: evidence,
      dependencies: stringKeys(manifest.dependencies).filter(d => names.has(d)).sort(),
      devDependencies: stringKeys(manifest.devDependencies).filter(d => names.has(d)).sort(),
      productionImports: [...productionImports].sort(),
      nonProductionImports: [...anyImports].filter(d => !productionImports.has(d)).sort(),
      productionFiles: [...production].length,
      productionLines,
    });
  }

  const byName = new Map(packages.map(p => [p.name, p]));
  const invocable = packages.filter(p => p.role === "invocable").map(p => p.name);
  // Reach is transitive from what runs, not "has at least one importer". A
  // library imported only by an unreached library is itself unreached — which is
  // the whole point: `constraint-solver` has an importer and still cannot affect
  // production, because its only importer is `query-engine`, which nothing runs.
  const reachable = new Set<string>();
  const queue = [...invocable];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const next of byName.get(name)?.productionImports ?? []) if (!reachable.has(next)) queue.push(next);
  }

  const productionConsumers: Record<string, string[]> = {};
  const nonProductionConsumers: Record<string, string[]> = {};
  for (const p of packages) {
    for (const target of p.productionImports) (productionConsumers[target] ??= []).push(p.name);
    for (const target of p.nonProductionImports) (nonProductionConsumers[target] ??= []).push(p.name);
  }

  const undeclaredProductionImports = packages.flatMap(p => p.productionImports
    .filter(i => !p.dependencies.includes(i))
    .map(i => ({ from: p.name, imported: i, declaredAsDev: p.devDependencies.includes(i) })));
  const unusedDependencies = packages.flatMap(p => [
    ...p.dependencies.filter(d => !p.productionImports.includes(d) && !p.nonProductionImports.includes(d)).map(d => ({ from: p.name, declared: d, dev: false })),
    ...p.devDependencies.filter(d => !p.productionImports.includes(d) && !p.nonProductionImports.includes(d)).map(d => ({ from: p.name, declared: d, dev: true })),
  ]);

  return {
    packages,
    invocable,
    reachable: [...reachable].sort(),
    unreached: packages.filter(p => p.role === "library" && !reachable.has(p.name)).map(p => p.name),
    productionConsumers: Object.fromEntries(Object.entries(productionConsumers).map(([k, v]) => [k, v.sort()])),
    nonProductionConsumers: Object.fromEntries(Object.entries(nonProductionConsumers).map(([k, v]) => [k, v.sort()])),
    undeclaredProductionImports,
    unusedDependencies,
  };
}

/**
 * Five codes, because five different actions follow and one number sends a lane
 * to the wrong one:
 *
 * | code                            | severity | what to do                              |
 * |---------------------------------|----------|-----------------------------------------|
 * | `PACKAGE_UNREACHED_LIBRARY`     | error    | wire it into a running path, or delete it |
 * | `PACKAGE_INVOCABLE`             | info     | nothing: it is run, not imported        |
 * | `PACKAGE_TEST_ONLY_CONSUMER`    | info     | detail on an unreached package: its only importer is a test |
 * | `PACKAGE_IMPORT_UNDECLARED`     | error    | add the dependency; resolution is working by luck |
 * | `PACKAGE_DEPENDENCY_UNUSED`     | warning  | drop the dependency, or notice the wiring never happened |
 *
 * Only the two errors gate. `PACKAGE_INVOCABLE` is emitted rather than stayed
 * silent so that a reader can see *why* a package was excused, and so that a
 * package which becomes excused by acquiring a `bin` shows up as a diff.
 */
export function packageWiringCheck(graph: PackageGraphReport): CheckOutcome {
  const byName = new Map(graph.packages.map(p => [p.name, p]));
  const findings: Finding[] = [];
  for (const name of graph.unreached) {
    const p = byName.get(name)!;
    const consumers = graph.productionConsumers[name] ?? [];
    const why = consumers.length === 0
      ? "no package imports it"
      : `its only production importer(s) (${consumers.join(", ")}) are themselves unreached`;
    findings.push(finding(
      "PACKAGE_UNREACHED_LIBRARY",
      `${p.productionLines} line(s) in ${p.productionFiles} module(s) that no invocable package reaches: ${why}`,
      "error",
      { subject: `package:${name}`, path: p.dir },
    ));
    const testConsumers = graph.nonProductionConsumers[name] ?? [];
    if (testConsumers.length > 0) findings.push(finding(
      "PACKAGE_TEST_ONLY_CONSUMER",
      `imported only from outside a production closure, by ${testConsumers.join(", ")}: a passing test suite is not a production path`,
      "info",
      { subject: `package:${name}` },
    ));
  }
  for (const name of graph.invocable) {
    const p = byName.get(name)!;
    findings.push(finding(
      "PACKAGE_INVOCABLE",
      `run rather than imported (${p.roleEvidence.join(", ")}), so having no importer is correct`,
      "info",
      { subject: `package:${name}` },
    ));
  }
  for (const u of graph.undeclaredProductionImports) findings.push(finding(
    "PACKAGE_IMPORT_UNDECLARED",
    `production code imports ${u.imported}, which is ${u.declaredAsDev ? "declared only as a devDependency" : "not declared as a dependency"}`,
    "error",
    { subject: `package:${u.from}` },
  ));
  for (const u of graph.unusedDependencies) findings.push(finding(
    "PACKAGE_DEPENDENCY_UNUSED",
    `declares ${u.declared} in ${u.dev ? "devDependencies" : "dependencies"} but no module imports it`,
    "warning",
    { subject: `package:${u.from}` },
  ));
  return check("ZDS-PACKAGE-WIRING", "Every library package is reachable from something that runs", findings);
}

export function formatPackageGraph(graph: PackageGraphReport): string {
  const consumers = (name: string): string => {
    const production = graph.productionConsumers[name] ?? [];
    const test = graph.nonProductionConsumers[name] ?? [];
    const parts = [`${production.length}`];
    if (test.length > 0) parts.push(`(+${test.length} test-only)`);
    return parts.join(" ");
  };
  return [
    `packages: ${graph.packages.length}; invocable: ${graph.invocable.length}; reachable: ${graph.reachable.length}; unreached libraries: ${graph.unreached.length}`,
    "",
    "| package | role | role evidence | production lines | production consumers | reached |",
    "|---|---|---|---|---|---|",
    ...graph.packages.map(p => `| ${p.name} | ${p.role} | ${p.roleEvidence.join(", ") || "—"} | ${p.productionLines} | ${consumers(p.name)} | ${graph.reachable.includes(p.name) ? "yes" : "**NO**"} |`),
  ].join("\n");
}
