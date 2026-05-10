/**
 * Tests for the chunker — verifies 3-level content splitting.
 */

import { describe, test, expect } from "bun:test";
import { parse } from "../../parser/src/index";
import { chunk, estimateTokens } from "../src/chunker";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseSource(source: string) {
  const { ast, errors } = parse(source.trim());
  if (errors.length > 0) {
    throw new Error(`Parse errors: ${errors.map((e: any) => e.message).join(", ")}`);
  }
  return ast;
}

function makeAtom(kind: string, extras = "") {
  return `
prime Atom extends ${capitalise(kind)} {
  name: "test-atom"
  version: "1.0.0"
  description: "Test atom for ${kind}"
  tags: ["test", "${kind}"]
  domain: "test-domain"
  ${extras}
}`.trim();
}

function capitalise(s: string): string {
  // Map kind names to PascalCase class names used in 'extends'
  const MAP: Record<string, string> = {
    fact: "Knowledge",
    term: "Knowledge",
    value: "Knowledge",
    category: "Knowledge",
    example: "Knowledge",
    "counter-example": "Knowledge",
    source: "Knowledge",
    metric: "Knowledge",
    step: "Method",
    check: "Rule",
    transform: "Method",
    tool: "Knowledge",
    method: "Method",
    rule: "Rule",
    taxonomy: "Knowledge",
    pattern: "Knowledge",
    "anti-pattern": "Knowledge",
    type: "Knowledge",
    persona: "Knowledge",
    voice: "Knowledge",
    constraint: "Knowledge",
    template: "Knowledge",
    provocation: "Knowledge",
    collection: "Knowledge",
    scope: "Knowledge",
    tradeoff: "Knowledge",
    principle: "Knowledge",
    feedback: "Knowledge",
  };
  return MAP[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Summary level tests ───────────────────────────────────────────────────────

describe("chunker — summary level (L1)", () => {
  test("summary contains atom name and kind", () => {
    const ast = parseSource(makeAtom("fact", `facts: [{ statement: "this is the claim", confidence: "proven" }]`));
    const { summary } = chunk(ast);
    expect(summary).toContain("test-atom");
    expect(summary).toContain("knowledge"); // fact -> Knowledge extends class
  });

  test("summary contains description", () => {
    const ast = parseSource(makeAtom("fact", `facts: [{ statement: "x", confidence: "proven" }]`));
    const { summary } = chunk(ast);
    expect(summary).toContain("Test atom for fact");
  });

  test("summary contains tags", () => {
    const ast = parseSource(makeAtom("fact", `facts: [{ statement: "x", confidence: "proven" }]`));
    const { summary } = chunk(ast);
    expect(summary).toContain("test, fact");
  });

  test("summary is <= 50 tokens for simple atom", () => {
    const ast = parseSource(makeAtom("fact", `facts: [{ statement: "Short claim.", confidence: "proven" }]`));
    const { summary } = chunk(ast);
    const tok = estimateTokens(summary);
    expect(tok).toBeLessThanOrEqual(50);
  });

  test("summary contains 1-line claim for fact", () => {
    const ast = parseSource(makeAtom("fact", `facts: [{ statement: "The one-liner claim.", confidence: "proven" }]`));
    const { summary } = chunk(ast);
    expect(summary).toContain("The one-liner claim.");
  });

  test("summary contains first check description for rule", () => {
    const ast = parseSource(makeAtom("rule", `checks: [{ description: "Rule check statement", pass_condition: "measure it" }]`));
    const { summary } = chunk(ast);
    expect(summary).toContain("Rule check statement");
  });
});

// ── Core level tests ─────────────────────────────────────────────────────────

describe("chunker — core level (L2)", () => {
  test("core >= summary in byte size", () => {
    const src = makeAtom("method", `steps: [
      LOAD { "Load the artifact" }
      ANALYZE { "Run heuristics" }
      SUMMARIZE { "Report findings" }
    ]`);
    const ast = parseSource(src);
    const { summary, core } = chunk(ast);
    expect(core.length).toBeGreaterThanOrEqual(summary.length);
  });

  test("core contains steps for Method atom", () => {
    const ast = parseSource(makeAtom("method", `steps: [
      LOAD { "Load the artifact" }
      ANALYZE { "Analyze results" }
    ]`));
    const { core } = chunk(ast);
    expect(core).toContain("LOAD");
    expect(core).toContain("ANALYZE");
  });

  test("core contains checks for Rule atom", () => {
    const ast = parseSource(makeAtom("rule", `checks: [
      { description: "Check the contrast ratio", pass_condition: "ratio >= 4.5" }
    ]`));
    const { core } = chunk(ast);
    expect(core).toContain("Check the contrast ratio");
  });

  test("core contains facts for Knowledge atom", () => {
    const ast = parseSource(makeAtom("fact", `facts: [
      { statement: "The important fact statement here.", confidence: "proven" }
    ]`));
    const { core } = chunk(ast);
    expect(core).toContain("The important fact statement here.");
  });

  test("core is <= 200 tokens for a typical atom", () => {
    const ast = parseSource(makeAtom("rule", `checks: [
      { description: "Check A", pass_condition: "pass" }
      { description: "Check B", pass_condition: "pass" }
    ]`));
    const { core } = chunk(ast);
    expect(estimateTokens(core)).toBeLessThanOrEqual(200);
  });
});

// ── Full level tests ─────────────────────────────────────────────────────────

describe("chunker — full level (L3)", () => {
  test("full >= core in byte size", () => {
    const ast = parseSource(makeAtom("fact", `
      facts: [{ statement: "Fact claim here.", confidence: "proven" }]
      source: { url: "https://example.com/spec", type: "primary" }
      notes: "Extended notes about this fact."
    `));
    const { core, full } = chunk(ast);
    expect(full.length).toBeGreaterThanOrEqual(core.length);
  });

  test("full contains sources", () => {
    const ast = parseSource(makeAtom("fact", `
      facts: [{ statement: "Claim.", confidence: "proven" }]
      source: { url: "https://w3.org/TR/WCAG22", type: "primary" }
    `));
    const { full } = chunk(ast);
    expect(full).toContain("https://w3.org/TR/WCAG22");
  });

  test("full contains notes and rationale", () => {
    const ast = parseSource(makeAtom("fact", `
      facts: [{ statement: "Claim.", confidence: "proven" }]
      notes: "Extended implementation notes."
      rationale: "Why this matters for users."
    `));
    const { full } = chunk(ast);
    expect(full).toContain("Extended implementation notes.");
    expect(full).toContain("Why this matters for users.");
  });

  test("full contains relations", () => {
    const ast = parseSource(makeAtom("fact", `
      facts: [{ statement: "Claim.", confidence: "proven" }]
      specializes: "@w3c/wcag-criterion"
      enhances: ["@community/focus-ring-pattern"]
    `));
    const { full } = chunk(ast);
    expect(full).toContain("@w3c/wcag-criterion");
  });

  test("full is <= 500 tokens for typical atoms", () => {
    const ast = parseSource(makeAtom("method", `
      steps: [
        LOAD { "Load artifact" }
        ANALYZE { "Apply heuristics" }
        SLOP { "Detect slop" }
        REPORT { "Generate report" }
      ]
      notes: "Use this method for all design reviews."
    `));
    const { full } = chunk(ast);
    expect(estimateTokens(full)).toBeLessThanOrEqual(500);
  });
});

// ── All 28 atom kinds ─────────────────────────────────────────────────────────

describe("chunker — handles all atom kind families", () => {
  // Data/Value kinds (legacy extends Knowledge)
  test("fact kind — chunks without error", () => {
    const ast = parseSource(makeAtom("fact", `facts: [{ statement: "s", confidence: "proven" }]`));
    const levels = chunk(ast);
    expect(levels.summary).toBeTruthy();
    expect(levels.core).toBeTruthy();
    expect(levels.full).toBeTruthy();
  });

  test("term kind — chunks without error", () => {
    const ast = parseSource(makeAtom("term", `facts: [{ statement: "definition here", confidence: "consensus" }]`));
    const levels = chunk(ast);
    expect(levels.summary).toBeTruthy();
  });

  test("collection kind — includes in core", () => {
    const ast = parseSource(makeAtom("collection", `includes: ["@rule/design-health", "@method/critique"]`));
    const { core } = chunk(ast);
    expect(core).toContain("@rule/design-health");
  });

  test("rule kind — checks in core", () => {
    const ast = parseSource(makeAtom("rule", `checks: [{ description: "Must pass this", pass_condition: "x > 0" }]`));
    const { core } = chunk(ast);
    expect(core).toContain("Must pass this");
  });

  test("method kind — steps in core", () => {
    const ast = parseSource(makeAtom("method", `steps: [STEP1 { "Do the thing" } STEP2 { "Done" }]`));
    const { core } = chunk(ast);
    expect(core).toContain("STEP1");
  });

  test("taxonomy kind — chunks without error", () => {
    const ast = parseSource(makeAtom("taxonomy", `facts: [{ statement: "taxonomy root", confidence: "consensus" }]`));
    const levels = chunk(ast);
    expect(levels.summary).toBeTruthy();
  });

  test("principle kind — statement in summary", () => {
    const ast = parseSource(makeAtom("principle", `
      facts: [{ statement: "Clarity over cleverness always.", confidence: "consensus" }]
    `));
    const { summary } = chunk(ast);
    expect(summary).toContain("Clarity over cleverness always.");
  });

  test("constraint kind — chunks without error", () => {
    const ast = parseSource(makeAtom("constraint", `
      facts: [{ statement: "No Inter font.", confidence: "consensus" }]
      values: ["Inter", "Roboto", "Arial"]
    `));
    const { core } = chunk(ast);
    expect(core).toContain("Inter");
  });
});

// ── Token count accuracy ──────────────────────────────────────────────────────

describe("chunker — token estimation", () => {
  test("estimateTokens returns chars / 4 (ceiling)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});
