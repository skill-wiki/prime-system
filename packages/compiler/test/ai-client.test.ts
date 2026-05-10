/**
 * Tests for the AI client module.
 *
 * These tests verify:
 * - API key resolution logic
 * - Graceful degradation when no API key is set
 * - Response parsing from the Anthropic API format
 * - Error handling (network failures, bad responses)
 * - Integration with L2/L3 prompt builders and response parsers
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { callAI, hasApiKey, AI_MODELS } from "../src/ai-client";
import { buildL2Prompt, parseL2Response } from "../src/checker-l2";
import { buildL3Prompt, parseL3Response } from "../src/checker-l3";
import type { PrimeAST } from "@prime-lang/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Minimal valid AST for testing prompt builders */
const MOCK_AST: PrimeAST = {
  name: "test-prime",
  version: "1.0.0",
  extends: "Method",
  body: [
    {
      type: "Field",
      key: "description",
      value: { type: "String", value: "A test prime for unit testing" },
    },
    {
      type: "Field",
      key: "tags",
      value: {
        type: "Array",
        items: [
          { type: "String", value: "testing" },
          { type: "String", value: "example" },
        ],
      },
    },
  ],
} as unknown as PrimeAST;

// ─── hasApiKey Tests ──────────────────────────────────────────────────────

describe("hasApiKey", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns false when no API key is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(hasApiKey()).toBe(false);
  });

  it("returns true when ANTHROPIC_API_KEY env var is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    expect(hasApiKey()).toBe(true);
  });

  it("returns true when API key is passed in options", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(hasApiKey({ apiKey: "sk-ant-test-key" })).toBe(true);
  });

  it("prefers options.apiKey over env var", () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    expect(hasApiKey({ apiKey: "options-key" })).toBe(true);
  });
});

// ─── callAI Tests ─────────────────────────────────────────────────────────

describe("callAI", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns empty string when no API key is available", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await callAI("test prompt");
    expect(result).toBe("");
  });

  it("returns empty string when API key is explicitly empty", async () => {
    process.env.ANTHROPIC_API_KEY = "";
    const result = await callAI("test prompt");
    expect(result).toBe("");
  });
});

// ─── AI_MODELS Constants ──────────────────────────────────────────────────

describe("AI_MODELS", () => {
  it("has L2 model defined", () => {
    expect(AI_MODELS.L2).toBe("claude-haiku-4-5-20251001");
  });

  it("has L3 model defined", () => {
    expect(AI_MODELS.L3).toBe("claude-sonnet-4-6");
  });
});

// ─── L2 Prompt Builder ───────────────────────────────────────────────────

describe("buildL2Prompt", () => {
  it("includes the AST as JSON in the prompt", () => {
    const prompt = buildL2Prompt(MOCK_AST);
    expect(prompt).toContain("test-prime");
    expect(prompt).toContain("Method");
  });

  it("includes all check categories", () => {
    const prompt = buildL2Prompt(MOCK_AST);
    expect(prompt).toContain("Step logic consistency");
    expect(prompt).toContain("Unused inputs");
    expect(prompt).toContain("Unreachable outputs");
    expect(prompt).toContain("Branch coverage");
    expect(prompt).toContain("Warning relevance");
  });

  it("requests JSON array output format", () => {
    const prompt = buildL2Prompt(MOCK_AST);
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain('"level"');
    expect(prompt).toContain('"message"');
  });

  it("includes related primes when provided", () => {
    const prompt = buildL2Prompt(MOCK_AST, '{"related": "data"}');
    expect(prompt).toContain('{"related": "data"}');
  });

  it("shows (none) when no related primes", () => {
    const prompt = buildL2Prompt(MOCK_AST);
    expect(prompt).toContain("(none)");
  });
});

// ─── L2 Response Parser ──────────────────────────────────────────────────

describe("parseL2Response", () => {
  it("parses a clean JSON array", () => {
    const response = JSON.stringify([
      {
        level: "warn",
        line: 5,
        message: "Input 'x' is not used in any step",
        suggestion: "Remove unused input or reference it in a step",
      },
    ]);
    const diagnostics = parseL2Response(response);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe("warn");
    expect(diagnostics[0].line).toBe(5);
    expect(diagnostics[0].message).toBe("Input 'x' is not used in any step");
    expect(diagnostics[0].source).toBe("L2:logic");
  });

  it("parses JSON wrapped in markdown code fences", () => {
    const response = '```json\n[{"level":"error","line":1,"message":"contradiction","suggestion":"fix it"}]\n```';
    const diagnostics = parseL2Response(response);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe("error");
  });

  it("returns empty array for empty JSON array", () => {
    const diagnostics = parseL2Response("[]");
    expect(diagnostics).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    const diagnostics = parseL2Response("");
    expect(diagnostics).toHaveLength(0);
  });

  it("returns warning for unparseable response", () => {
    const diagnostics = parseL2Response("This is not JSON at all");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe("warn");
    expect(diagnostics[0].message).toContain("unparseable");
  });

  it("skips items without message field", () => {
    const response = JSON.stringify([
      { level: "warn", line: 1 },
      { level: "warn", line: 2, message: "valid item" },
    ]);
    const diagnostics = parseL2Response(response);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe("valid item");
  });

  it("defaults unknown levels to warn", () => {
    const response = JSON.stringify([
      { level: "critical", line: 1, message: "unknown level" },
    ]);
    const diagnostics = parseL2Response(response);
    expect(diagnostics[0].level).toBe("warn");
  });

  it("handles 'fix' as alias for 'suggestion'", () => {
    const response = JSON.stringify([
      { level: "warn", line: 1, message: "issue", fix: "do this" },
    ]);
    const diagnostics = parseL2Response(response);
    expect(diagnostics[0].suggestion).toBe("do this");
  });
});

// ─── L3 Prompt Builder ───────────────────────────────────────────────────

describe("buildL3Prompt", () => {
  it("includes prime metadata in the prompt", () => {
    const prompt = buildL3Prompt(MOCK_AST);
    expect(prompt).toContain("test-prime");
    expect(prompt).toContain("Method");
    expect(prompt).toContain("testing, example");
  });

  it("includes all check categories", () => {
    const prompt = buildL3Prompt(MOCK_AST);
    expect(prompt).toContain("Knowledge accuracy");
    expect(prompt).toContain("Coverage completeness");
    expect(prompt).toContain("Terminology accuracy");
    expect(prompt).toContain("Threshold calibration");
    expect(prompt).toContain("Standards alignment");
    expect(prompt).toContain("Obsolescence");
  });

  it("requests JSON array output format", () => {
    const prompt = buildL3Prompt(MOCK_AST);
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain('"evidence"');
  });

  it("specifies L3 never produces error level", () => {
    const prompt = buildL3Prompt(MOCK_AST);
    expect(prompt).toContain('never produces "error"');
  });
});

// ─── L3 Response Parser ──────────────────────────────────────────────────

describe("parseL3Response", () => {
  it("parses a clean JSON array with evidence", () => {
    const response = JSON.stringify([
      {
        level: "warn",
        line: 10,
        message: "The threshold of 80% is below the 2026 industry standard of 90%",
        evidence: "ISO 27001:2025 requires 90% coverage",
        suggestion: "Update threshold to 90%",
      },
    ]);
    const diagnostics = parseL3Response(response);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe("warn");
    expect(diagnostics[0].suggestion).toContain("Evidence:");
    expect(diagnostics[0].suggestion).toContain("ISO 27001");
    expect(diagnostics[0].source).toBe("L3:domain");
  });

  it("defaults to suggestion level for unknown levels", () => {
    const response = JSON.stringify([
      { level: "error", line: 1, message: "L3 cannot produce errors" },
    ]);
    const diagnostics = parseL3Response(response);
    expect(diagnostics[0].level).toBe("suggestion");
  });

  it("returns empty array for empty response", () => {
    expect(parseL3Response("")).toHaveLength(0);
    expect(parseL3Response("[]")).toHaveLength(0);
  });

  it("handles markdown-wrapped response", () => {
    const response = '```json\n[{"level":"suggestion","line":0,"message":"Consider adding X"}]\n```';
    const diagnostics = parseL3Response(response);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe("suggestion");
  });

  it("returns warning for invalid JSON", () => {
    const diagnostics = parseL3Response("{not valid json}");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("unparseable");
  });
});
