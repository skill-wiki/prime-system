/**
 * @module checker-l3
 * Level 3: Domain checker — AI-powered.
 *
 * Builds a prompt for domain-specific checks:
 * - Knowledge accuracy (facts correct, categories complete)
 * - Coverage completeness (missing important topics)
 * - Threshold calibration vs industry standards
 * - Terminology accuracy
 * - Best practice alignment (2026 standards)
 *
 * AI integration: the compile() function in index.ts calls buildL3Prompt(),
 * sends it to the Anthropic API via ai-client.ts, then parses with parseL3Response().
 */

import type {
  PrimeAST,
  FieldNode,
  ArrayNode,
  StringNode,
} from "@skill-wiki/types";
import type { Diagnostic } from "./types";

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract tags from the AST for domain context.
 */
function extractTags(ast: PrimeAST): string[] {
  const tagsField = ast.body.find((f) => f.key === "tags");
  if (!tagsField || tagsField.value.type !== "Array") return [];
  return (tagsField.value as ArrayNode).items
    .filter((item): item is StringNode => item.type === "String")
    .map((item) => item.value);
}

/**
 * Extract the description field value.
 */
function extractDescription(ast: PrimeAST): string {
  const descField = ast.body.find((f) => f.key === "description");
  if (!descField) return "";
  if (descField.value.type === "String") {
    return (descField.value as StringNode).value;
  }
  return "";
}

// ─── Prompt Builder ────────────────────────────────────────────────────────

/**
 * Build the Level 3 domain-check prompt from a Prime AST.
 *
 * The prompt instructs the AI (acting as a domain expert) to verify
 * accuracy, completeness, and calibration against current standards.
 *
 * @param ast - The parsed Prime AST
 * @returns The prompt string to send to an AI model
 */
export function buildL3Prompt(ast: PrimeAST): string {
  const baseClass = ast.extends || "Unknown";
  const tags = extractTags(ast);
  const description = extractDescription(ast);
  const astJson = JSON.stringify(ast, null, 2);

  const tagsStr = tags.length > 0 ? tags.join(", ") : "general";

  return `You are a domain expert acting as the Prime compiler's L3 domain checker.
Verify the accuracy, completeness, and calibration of the following Prime knowledge artifact.

Prime type: ${baseClass}
Name: ${ast.name}
Description: ${description}
Domain tags: ${tagsStr}

Content (AST):
${astJson}

Checks to perform:
1. Knowledge accuracy: Are all stated facts correct as of 2026? Identify any inaccuracies.
2. Coverage completeness: Are there important topics, edge cases, or sub-domains that are missing?
3. Terminology accuracy: Are all technical terms used correctly and consistently?
4. Type-specific checks:
   - If Knowledge: verify factual correctness and completeness of categorizations
   - If Method: verify steps reflect current best practices and are in correct order
   - If Rule: verify thresholds are calibrated against current industry standards
5. Obsolescence: Flag any outdated, deprecated, or superseded concepts
6. Standards alignment: Check compatibility with relevant industry standards and frameworks
7. Threshold calibration: If numeric thresholds exist, verify they match accepted benchmarks

IMPORTANT: Respond with ONLY a JSON array. No markdown, no explanation, no code fences.
Each item must have this exact schema:
{"level":"warn"|"suggestion","line":<number>,"message":"<description>","evidence":"<your basis>","suggestion":"<fix>"}

Rules:
- L3 never produces "error" level — only "warn" (likely inaccurate/incomplete) or "suggestion" (improvement)
- "evidence" = cite the standard, paper, or reasoning that supports your finding
- "line" = the line number in the AST where the issue originates, or 0 if not line-specific
- If no issues found, respond with exactly: []`;
}

// ─── Response Parser ───────────────────────────────────────────────────────

/**
 * Raw diagnostic item as returned by the AI model for L3 checks.
 */
interface RawL3Diagnostic {
  level?: string;
  line?: number;
  message?: string;
  evidence?: string;
  suggestion?: string;
  fix?: string;
}

/**
 * Parse the AI response from a Level 3 domain check into Diagnostic[].
 *
 * Handles:
 * - Clean JSON array
 * - JSON wrapped in markdown code fences
 * - Graceful degradation on malformed responses
 *
 * @param response - The raw AI response string
 * @returns Array of diagnostics parsed from the response
 */
export function parseL3Response(response: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Try to extract JSON array from the response
  let jsonStr = response.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find a JSON array in the response
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    if (jsonStr.length > 0 && jsonStr !== "[]") {
      diagnostics.push({
        level: "warn",
        line: 0,
        message: "L3 domain checker returned unparseable response",
        source: "L3:domain",
      });
    }
    return diagnostics;
  }

  try {
    const items: RawL3Diagnostic[] = JSON.parse(arrayMatch[0]);

    if (!Array.isArray(items)) return diagnostics;

    for (const item of items) {
      if (!item.message) continue;

      // L3 only produces warn and suggestion, never error
      const level =
        item.level === "warn" || item.level === "suggestion"
          ? item.level
          : "suggestion";

      // Build suggestion string, optionally including evidence
      let suggestion = item.suggestion || item.fix || undefined;
      if (item.evidence) {
        suggestion = suggestion
          ? `${suggestion} (Evidence: ${item.evidence})`
          : `Evidence: ${item.evidence}`;
      }

      diagnostics.push({
        level,
        line: typeof item.line === "number" ? item.line : 0,
        message: item.message,
        suggestion,
        source: "L3:domain",
      });
    }
  } catch {
    diagnostics.push({
      level: "warn",
      line: 0,
      message: "L3 domain checker response was not valid JSON",
      source: "L3:domain",
    });
  }

  return diagnostics;
}
