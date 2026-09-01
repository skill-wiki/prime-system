/**
 * Plan §16 Phase 5 acceptance: **LSP diagnostics 与 CLI compile diagnostics 一致**.
 *
 * This is a real comparison, not a shape check: each case writes a `.prime` file
 * to disk, runs the CLI's own entry point `compileSource` over it, opens the same
 * bytes in the Language Server, and asserts the two diagnostic sets are equal
 * field by field — level, line, message, suggestion and source tag.
 *
 * The cases are chosen to cover every abort point in the pipeline, because the
 * abort point is what decides which stages contribute to the set:
 *   - syntax error   → compileSource aborts in `parse`
 *   - structural     → aborts in `check`, mixed error + warn severities
 *   - resolver       → aborts in `resolve`, `source: "resolver"`
 *   - clean          → no abort, empty set
 *
 * If the server ran a different stage order, used a different filename (parse
 * error messages embed it), or converted a line number wrongly, these fail.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSource, type Diagnostic as CompilerDiagnostic } from "@aoe/compiler";
import { asCompilerDiagnostic, createLanguageServer } from "../src/index";

/** A stable ordering so the comparison is set-wise, not emission-order-wise. */
function sortDiagnostics(diagnostics: readonly CompilerDiagnostic[]): readonly CompilerDiagnostic[] {
  return [...diagnostics].sort((left, right) => left.line - right.line || left.message.localeCompare(right.message));
}

interface Case {
  readonly label: string;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expectedPhase: "parse" | "check" | "resolve" | undefined;
  readonly expectedCount: number;
}

const CASES: readonly Case[] = [
  {
    label: "syntax error aborts in parse",
    entry: "broken.prime",
    files: { "broken.prime": `prime Broken extends Container {\n  name: "broken"\n  version "1.0.0"\n` },
    expectedPhase: "parse",
    expectedCount: 1,
  },
  {
    label: "structural errors abort in check",
    entry: "bad.prime",
    files: { "bad.prime": `prime Bad extends Container {\n  name: "Not_Kebab"\n  version: "1.0"\n}\n` },
    expectedPhase: "check",
    expectedCount: 2,
  },
  {
    label: "mixed error and warning severities in one check abort",
    entry: "solo.prime",
    files: {
      "solo.prime": `prime Solo extends Container {\n  name: "solo"\n  version: "1.0.0"\n  links: [\n    { type: requires, to: "absent-one" }\n    { type: enhances, to: "absent-two" }\n  ]\n}\n`,
    },
    expectedPhase: "check",
    expectedCount: 2,
  },
  {
    label: "circular dependency aborts in resolve",
    entry: "alpha.prime",
    files: {
      "alpha.prime": `prime Alpha extends Container {\n  name: "alpha"\n  version: "1.0.0"\n  links: [\n    { type: requires, to: "beta" }\n  ]\n}\n`,
      "beta.prime": `prime Beta extends Container {\n  name: "beta"\n  version: "1.0.0"\n  links: [\n    { type: requires, to: "alpha" }\n  ]\n}\n`,
    },
    expectedPhase: "resolve",
    expectedCount: 1,
  },
  {
    label: "a clean source produces an empty set on both sides",
    entry: "clean.prime",
    files: { "clean.prime": `prime Clean extends Container {\n  name: "clean"\n  version: "1.0.0"\n}\n` },
    expectedPhase: undefined,
    expectedCount: 0,
  },
];

describe("LSP diagnostics equal CLI compile diagnostics", () => {
  for (const testCase of CASES) {
    test(testCase.label, () => {
      const directory = mkdtempSync(join(tmpdir(), "w10g-parity-"));
      for (const [name, source] of Object.entries(testCase.files)) writeFileSync(join(directory, name), source, "utf8");
      const file = join(directory, testCase.entry);

      // The CLI side. `outputDir` is inside the temp directory so the clean case
      // may emit without touching the repository.
      const compiled = compileSource({ file, outputDir: join(directory, "compiled") });
      expect(compiled.failedPhase).toBe(testCase.expectedPhase);
      expect(compiled.diagnostics.length).toBe(testCase.expectedCount);

      // The LSP side, over the same bytes, with no model configured — the CLI's
      // markdown path loads no Model Package either.
      const server = createLanguageServer();
      const uri = `file://${file}`;
      server.openDocument(uri, testCase.files[testCase.entry]!);
      const lsp = server.diagnostics(uri);

      expect(sortDiagnostics(lsp.compile.map(asCompilerDiagnostic))).toEqual(sortDiagnostics(compiled.diagnostics));
      // No model configured, so the LSP adds nothing beyond the compile set.
      expect(lsp.model).toEqual([]);
      expect(lsp.all.length).toBe(compiled.diagnostics.length);
    });
  }

  test("the abort point the server reports matches the phase the CLI failed in", () => {
    const directory = mkdtempSync(join(tmpdir(), "w10g-parity-phase-"));
    const cases: ReadonlyArray<readonly [string, string, string | undefined]> = [
      ["s.prime", `prime S extends Container {\n  name: "s"\n  version "1.0.0"\n`, "syntax"],
      ["c.prime", `prime C extends Container {\n  name: "Bad_Name"\n  version: "1.0.0"\n}\n`, "structure"],
      ["k.prime", `prime K extends Container {\n  name: "k"\n  version: "1.0.0"\n}\n`, undefined],
    ];
    for (const [name, source, abortedAt] of cases) {
      const file = join(directory, name);
      writeFileSync(file, source, "utf8");
      const server = createLanguageServer();
      const uri = `file://${file}`;
      server.openDocument(uri, source);
      const outcome = server.diagnostics(uri).compileOutcome;
      expect(outcome.kind).toBe("ran");
      expect(outcome.kind === "ran" ? outcome.abortedAt : "unreachable").toBe(abortedAt);
    }
  });

  test("a generic unit declaration is reported not-applicable, because the CLI entry throws on it", () => {
    const directory = mkdtempSync(join(tmpdir(), "w10g-parity-unit-"));
    const source = `unit Thing : @some-model/container {\n  label: "thing"\n}\n`;
    const file = join(directory, "thing.prime");
    writeFileSync(file, source, "utf8");

    // Recorded as an assertion rather than prose: `compileSource` calls
    // `parseLegacy`, which throws on the generic unit form.
    expect(() => compileSource({ file, outputDir: join(directory, "compiled") })).toThrow(/Generic unit is not supported by legacy consumers/);

    const server = createLanguageServer();
    const uri = `file://${file}`;
    server.openDocument(uri, source);
    const lsp = server.diagnostics(uri);
    expect(lsp.compile).toEqual([]);
    expect(lsp.compileOutcome).toEqual({ kind: "not-applicable", reason: "unit-form" });
  });
});

describe("diagnostic shape conversion", () => {
  test("round-trips a compiler diagnostic through the LSP shape", () => {
    const directory = mkdtempSync(join(tmpdir(), "w10g-roundtrip-"));
    const source = `prime Bad extends Container {\n  name: "Not_Kebab"\n  version: "1.0"\n}\n`;
    const file = join(directory, "bad.prime");
    writeFileSync(file, source, "utf8");
    const server = createLanguageServer();
    const uri = `file://${file}`;
    server.openDocument(uri, source);

    const [first] = server.diagnostics(uri).compile;
    expect(first).toBeDefined();
    // 1-based compiler line 2 ↔ 0-based LSP line 1.
    expect(first!.range.start.line).toBe(1);
    expect(first!.severity).toBe("error");
    expect(asCompilerDiagnostic(first!).line).toBe(2);
    expect(asCompilerDiagnostic(first!).level).toBe("error");
  });

  test("maps the compiler's warn level to an LSP warning and back", () => {
    const directory = mkdtempSync(join(tmpdir(), "w10g-warn-"));
    const source = `prime Solo extends Container {\n  name: "solo"\n  version: "1.0.0"\n  links: [\n    { type: requires, to: "absent-one" }\n    { type: enhances, to: "absent-two" }\n  ]\n}\n`;
    const file = join(directory, "solo.prime");
    writeFileSync(file, source, "utf8");
    const server = createLanguageServer();
    const uri = `file://${file}`;
    server.openDocument(uri, source);

    const severities = server.diagnostics(uri).compile.map(entry => entry.severity);
    expect(severities).toContain("error");
    expect(severities).toContain("warning");
    expect(server.diagnostics(uri).compile.map(entry => asCompilerDiagnostic(entry).level)).toContain("warn");
  });
});
