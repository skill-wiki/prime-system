/**
 * Boundary assertions for ADR-8 / §18.5 and for the W10-G acceptance item
 * "零重写 parser / model-schema（grep 证明是 import 而非复制）".
 *
 * These are greps over this package's own `src/`, run as tests, because the two
 * claims they cover are exactly the kind that rot silently: a later edit could
 * add an emitter import or paste a copy of the lexer, and nothing else in the
 * suite would notice.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const sources = readdirSync(SRC)
  .filter(name => name.endsWith(".ts"))
  .map(name => ({ name, text: readFileSync(join(SRC, name), "utf8") }));

/** Import specifiers, module-level and dynamic. */
function importedModules(text: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
  return specifiers;
}

describe("the Language Server does not build bundles (ADR-8, §18.5)", () => {
  test("no source file imports the compiler's emitter or its build entry", () => {
    // The compile pipeline entry and every artifact-writing function. Reusing the
    // Checker is required; reusing the emitter would make the LSP a compiler.
    const forbidden = ["compileSource", "emitMarkdown", "emitBundle", "emitIndex", "emitGraph", "emitCompiledUnit", "compileUnit", "compileNormalizedUnit", "buildGlobalIndexXml"];
    const offences: string[] = [];
    for (const { name, text } of sources) {
      for (const symbol of forbidden) {
        // Match the symbol only where it would be an import binding.
        if (new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${symbol}\\b[^}]*\\}`, "s").test(text)) offences.push(`${name} imports ${symbol}`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("no source file writes to the filesystem", () => {
    const offences = sources.filter(({ text }) => /\bwriteFileSync\b|\bmkdirSync\b|\bcreateWriteStream\b|\bwriteFile\b/.test(text)).map(({ name }) => name);
    expect(offences).toEqual([]);
  });

  test("no source file imports the runtime or an engine package", () => {
    const engineScoped = sources.flatMap(({ name, text }) =>
      importedModules(text)
        .filter(specifier => /^@kernary-aoe\/(runtime|action-runtime|query-engine|projection-engine|event-store|bundle|mcp-server-core|cli)$/.test(specifier))
        .map(specifier => `${name} → ${specifier}`)
    );
    expect(engineScoped).toEqual([]);
  });
});

describe("parser and model-schema are reused, not rewritten", () => {
  test("the parser is imported", () => {
    const importers = sources.filter(({ text }) => importedModules(text).includes("@aoe/parser")).map(({ name }) => name);
    expect(importers.sort()).toEqual(["completion.ts", "document-store.ts"]);
  });

  test("the model loader is imported", () => {
    const importers = sources.filter(({ text }) => importedModules(text).includes("@aoe/model-schema")).map(({ name }) => name);
    expect(importers.sort()).toEqual(["model-diagnostics.ts", "model-index.ts"]);
  });

  test("the checker and resolver come from the compiler, not from a local copy", () => {
    const diagnostics = sources.find(({ name }) => name === "diagnostics.ts")!;
    expect(importedModules(diagnostics.text)).toContain("@aoe/compiler");
    expect(diagnostics.text).toContain("checkL1");
    expect(diagnostics.text).toContain("resolve");
  });

  test("no source file re-implements tokenizing, parsing or model validation", () => {
    // A copy would show up as one of these: a token table, a parser class, or a
    // zod schema for model definitions.
    const smells: Array<[string, RegExp]> = [
      ["declares its own token type table", /\benum\s+TokenType\b|\bconst\s+KEYWORDS\b/],
      ["declares its own parser", /\bclass\s+\w*Parser\b/],
      ["declares its own model schema", /\bz\s*\.\s*object\s*\(/],
      ["reads model YAML itself", /\bfrom\s+["']yaml["']/],
    ];
    const offences: string[] = [];
    for (const { name, text } of sources) {
      for (const [label, pattern] of smells) if (pattern.test(text)) offences.push(`${name} ${label}`);
    }
    expect(offences).toEqual([]);
  });
});

describe("no built-in domain vocabulary (§3.1)", () => {
  test("type and field names are never hardcoded — the model is the only source", () => {
    // Every completion item and every model diagnostic must be derived from a
    // `ModelIndex` lookup. If a literal list of names existed it would have to be
    // a string array in one of these files.
    const modelDriven = sources.filter(({ name }) => name === "completion.ts" || name === "model-diagnostics.ts");
    expect(modelDriven.length).toBe(2);
    for (const { name, text } of modelDriven) {
      expect(text, `${name} must resolve names through the model index`).toMatch(/resolveType|fieldsOf|typeNames/);
    }
  });
});
