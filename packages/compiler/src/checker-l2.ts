/**
 * @module checker-l2
 * Level 2: Logic checker — AI-powered.
 *
 * Builds a prompt from the AST that asks AI to check:
 * - Step logic consistency (contradictions between steps)
 * - Unused inputs (declared but not referenced in steps)
 * - Unreachable outputs (declared but not produced by steps)
 * - Branch coverage (exception handling completeness)
 * - Warning relevance (domain-appropriate anti-patterns)
 * - Use reference utilization (declared dependencies actually used)
 *
 * AI integration: the compile() function in index.ts calls buildL2Prompt(),
 * sends it to the Anthropic API via ai-client.ts, then parses with parseL2Response().
 */

import type { PrimeAST, AtomDeclaration, FieldNode, ArrayNode, StringNode, StepNode } from "@skill-wiki/types";
import type { Diagnostic } from "./types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

// ─── Prompt Builder ────────────────────────────────────────────────────────

const RESPONSE_SPEC = `IMPORTANT: Respond with ONLY a JSON array. No markdown, no explanation, no code fences.
Each item must have this exact schema:
{"level":"error"|"warn"|"suggestion","line":<number>,"message":"<description>","suggestion":"<fix>"}

Rules:
- "error" = logical contradiction or broken reference
- "warn" = likely oversight that could cause problems
- "suggestion" = improvement opportunity
- "line" = the AST line where the issue originates, or 0 if not applicable
- If no issues found, respond with exactly: []`;

function buildMethodPrompt(astJson: string, relatedSection: string): string {
  return `You are the Prime compiler's L2 logic checker. Analyze this Method Prime AST for logical consistency.

Checks to perform:
1. Step logic consistency: Are there contradictions between steps (one asserts A while another asserts not-A)?
2. Require-step alignment: Do the require conditions match what the steps actually need?
3. Success criteria coverage: Do the steps produce everything listed in success_criteria?
4. Warning relevance: Are the warning triggers genuinely common mistakes in this domain?
5. Branch coverage: Do the branches cover all exceptions that could arise from the steps?
6. Use-reference utilization: Are all Primes declared in "use" actually referenced in steps (semantic, not string match)?
7. Unused inputs: Are all declared inputs semantically referenced in the steps?
8. Unreachable outputs: Are all declared outputs actually produced by the steps?

AST:
${astJson}
${relatedSection}

${RESPONSE_SPEC}`;
}

function buildKnowledgePrompt(astJson: string, relatedSection: string): string {
  return `You are the Prime compiler's L2 semantic checker. Analyze this Knowledge Prime AST for factual and epistemic quality.

Checks to perform:
1. Confidence calibration: Does each fact's confidence level (proven|consensus|emerging|disputed) match how well-established the claim actually is? Flag over-confident claims.
2. Fact-tag alignment: Do the tags accurately categorize the facts? Flag tags that are too broad, too narrow, or missing obvious ones.
3. Definition sharpness: Are definitions specific enough to distinguish the term from neighboring concepts? Flag vague or circular definitions.
4. Source attribution: Does the description claim authority ("industry standard", "best practice", "WCAG requires") without citing a source?
5. Scope clarity: Is the Prime's domain of applicability clear from description + tags? Flag if a reader could misapply it.
6. Classification coverage: If categories are present, do they exhaustively partition the domain? Flag obvious gaps.

AST:
${astJson}
${relatedSection}

${RESPONSE_SPEC}`;
}

function buildRulePrompt(astJson: string, relatedSection: string): string {
  return `You are the Prime compiler's L2 semantic checker. Analyze this Rule Prime AST for decidability and enforceability.

Checks to perform:
1. Decidability: Can each check's pass_condition be evaluated to a concrete true/false? Flag pass_conditions that are subjective or require human judgment without specifying how to judge.
2. Non-circularity: Does the pass_condition describe HOW to measure, distinct from WHAT the description says must hold? Flag echoing.
3. Scope correctness: Is applies_to (prime_types/prime_names/tags) consistent with the description? Flag when a rule claims to check "all UI" but applies_to only matches a narrow subset.
4. Threshold sanity: If thresholds are present, do block/warn/pass values form a strictly increasing ordering? (L1 catches static mis-ordering; here check if the CHOSEN values are industry-calibrated.)
5. Exemption traps: Are exemptions phrased so that a reasonable contributor can cite them without bypassing the intent of the rule?
6. Severity-action fit: If severity table is present, does the block action actually stop shipping (reject build, fail CI) rather than just log?

AST:
${astJson}
${relatedSection}

${RESPONSE_SPEC}`;
}

/**
 * Build the Level 2 semantic-check prompt from a Prime AST.
 * Dispatches on ast.extends — Method primes get a Method-specific prompt,
 * Knowledge and Rule primes get prompts tuned to their epistemic/decidability
 * concerns respectively.
 *
 * @param ast - The parsed Prime AST
 * @param relatedPrimesAst - Optional JSON string of related Prime ASTs
 * @returns The prompt string to send to an AI model
 */
export function buildL2Prompt(ast: AnyAST, relatedPrimesAst?: string): string {
  const astJson = JSON.stringify(ast, null, 2);
  const relatedSection = relatedPrimesAst
    ? `\nRelated Primes (already installed):\n${relatedPrimesAst}`
    : "\nRelated Primes (already installed): (none)";

  const extendsVal = isPrimeAST(ast) ? ast.extends : undefined;
  switch (extendsVal) {
    case "Knowledge":
      return buildKnowledgePrompt(astJson, relatedSection);
    case "Rule":
      return buildRulePrompt(astJson, relatedSection);
    case "Method":
    default:
      return buildMethodPrompt(astJson, relatedSection);
  }
}

// ─── Response Parser ───────────────────────────────────────────────────────

/**
 * Raw diagnostic item as returned by the AI model.
 */
interface RawL2Diagnostic {
  level?: string;
  line?: number;
  message?: string;
  suggestion?: string;
  fix?: string;
}

/**
 * Parse the AI response from a Level 2 logic check into Diagnostic[].
 *
 * Handles:
 * - Clean JSON array
 * - JSON wrapped in markdown code fences
 * - Graceful degradation on malformed responses
 *
 * @param response - The raw AI response string
 * @returns Array of diagnostics parsed from the response
 */
export function parseL2Response(response: string): Diagnostic[] {
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
    // No array found — if the response is non-empty, emit a warning
    if (jsonStr.length > 0 && jsonStr !== "[]") {
      diagnostics.push({
        level: "warn",
        line: 0,
        message: `L2 checker returned unparseable response`,
        source: "L2:logic",
      });
    }
    return diagnostics;
  }

  try {
    const items: RawL2Diagnostic[] = JSON.parse(arrayMatch[0]);

    if (!Array.isArray(items)) return diagnostics;

    for (const item of items) {
      if (!item.message) continue;

      const level = item.level === "error" || item.level === "warn" || item.level === "suggestion"
        ? item.level
        : "warn";

      diagnostics.push({
        level,
        line: typeof item.line === "number" ? item.line : 0,
        message: item.message,
        suggestion: item.suggestion || item.fix,
        source: "L2:logic",
      });
    }
  } catch {
    diagnostics.push({
      level: "warn",
      line: 0,
      message: "L2 checker response was not valid JSON",
      source: "L2:logic",
    });
  }

  return diagnostics;
}
