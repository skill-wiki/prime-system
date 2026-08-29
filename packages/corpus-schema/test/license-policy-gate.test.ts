/**
 * The deny gate, exercised against the real corpus declaration.
 *
 * `prime-corpus.yaml`'s `policy.deny` comment has always promised that copyleft
 * "must fail the gate if a later migration pulls it in, rather than arriving
 * unnoticed". Nothing pinned that promise. The L14-A licence audit found it had
 * already been broken: 73 published units carried GPL-3.0 upstream content while
 * declaring no `license:` field, so no GPL-3.0 string existed anywhere in the
 * declaration for `policy.deny` to match. The evaluator was correct; it was never
 * handed the fact.
 *
 * These tests are the missing pin. They load the shipped declaration, then
 * re-admit a quarantined unit's licence as a source set and assert the gate turns
 * red — so the next migration that drops a per-unit licence on the way in fails
 * loudly instead of passing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { CorpusPackageDeclarationSchema, resolveCorpusPackage } from "../src/index.ts";

const DECLARATION_PATH = new URL(
  "../../../../prime-corpus-frontend-design/prime-corpus.yaml",
  import.meta.url,
).pathname;

function shippedDeclaration(): Record<string, unknown> {
  return parseYaml(readFileSync(DECLARATION_PATH, "utf8")) as Record<string, unknown>;
}

/** Resolve a declaration object and return every licence-related diagnostic code. */
function licenseDiagnostics(raw: unknown): readonly string[] {
  const parsed = CorpusPackageDeclarationSchema.safeParse(raw);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("declaration did not parse");
  const resolved = resolveCorpusPackage(parsed.data, {
    availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] },
  });
  return resolved.diagnostics
    .filter(d => d.code.includes("LICENSE"))
    .map(d => d.code);
}

describe("prime-corpus.yaml deny gate", () => {
  test("the shipped declaration raises no licence error", () => {
    const codes = licenseDiagnostics(shippedDeclaration());
    expect(codes.filter(c => c !== "CORPUS_LICENSE_INCOMPLETE")).toEqual([]);
  });

  test("re-admitting a GPL-3.0 source set is DENIED", () => {
    const declaration = shippedDeclaration();
    const sources = declaration["sources"] as Record<string, unknown>[];
    // The exact shape of the 73 units in sources/quarantine/gpl-3.0/, e.g.
    // @community/principle-security-copy, whose own notes name
    // github.com/spencergoldade/cursor-designer (GPL-3.0).
    sources.push({
      id: "community-gpl-readmitted",
      origin: "https://github.com/spencergoldade/cursor-designer",
      path: "primes-v3/sources/@community",
      license: "GPL-3.0 AND Apache-2.0",
      unitCount: 73,
    });
    const codes = licenseDiagnostics(declaration);
    expect(codes).toContain("LICENSE_DENIED");
  });

  test("a GPL-3.0 unit cannot hide behind a disjunction", () => {
    const declaration = shippedDeclaration();
    const sources = declaration["sources"] as Record<string, unknown>[];
    sources.push({
      id: "community-gpl-disjunctive",
      origin: "https://github.com/spencergoldade/cursor-designer",
      path: "primes-v3/sources/@community",
      license: "MIT OR GPL-3.0",
      unitCount: 1,
    });
    // allowDisjunctiveEscape is false, so a satisfying MIT branch is not enough:
    // the corpus may not pick the branch on a consumer's behalf.
    expect(licenseDiagnostics(declaration)).toContain("LICENSE_NOT_ALLOWED");
  });

  test("CC-BY-NC-SA-4.0 is denied, not merely un-allowed", () => {
    const declaration = shippedDeclaration();
    const sources = declaration["sources"] as Record<string, unknown>[];
    sources.push({
      id: "community-nc-readmitted",
      origin: "legacy primes/ units carrying CC-BY-NC-SA-4.0",
      path: "primes-v3/sources/@community",
      license: "CC-BY-NC-SA-4.0 AND Apache-2.0",
      unitCount: 12,
    });
    expect(licenseDiagnostics(declaration)).toContain("LICENSE_DENIED");
  });

  test("an undeclared-provenance set cannot pass requireDeclared", () => {
    const declaration = shippedDeclaration();
    const sources = declaration["sources"] as Record<string, unknown>[];
    // The 17 units in sources/quarantine/undeclared-provenance/ name an upstream
    // code repository and record no terms.
    //
    // Measured, and worth knowing: the literal string `unknown` does NOT come back
    // as LICENSE_UNPARSABLE. It matches the grammar's identifier production, so it
    // parses as an unrecognised licence id and is refused by the allow-list
    // instead. Both outcomes are a red gate, which is what matters here, but a
    // corpus that wants "no assertion" to be self-describing must write
    // NOASSERTION — that is the token the parser treats as unparsable.
    sources.push({
      id: "community-unknown-readmitted",
      origin: "upstream repository named in the unit, terms never recorded",
      path: "primes-v3/sources/@community",
      license: "unknown",
      unitCount: 17,
    });
    expect(licenseDiagnostics(declaration)).toContain("LICENSE_NOT_ALLOWED");

    const noassertion = shippedDeclaration();
    (noassertion["sources"] as Record<string, unknown>[]).push({
      id: "community-noassertion-readmitted",
      origin: "upstream repository named in the unit, terms never recorded",
      path: "primes-v3/sources/@community",
      license: "NOASSERTION",
      unitCount: 17,
    });
    expect(licenseDiagnostics(noassertion)).toContain("LICENSE_UNPARSABLE");
  });
});
