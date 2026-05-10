/**
 * @module checker-l2-heuristic
 * Level 2 — offline heuristic semantic checks.
 *
 * Runs deterministic pattern matching on the AST to surface common semantic
 * issues without an LLM call. When ANTHROPIC_API_KEY is set, the full LLM L2
 * (checker-l2.ts) runs *after* this pass — the heuristic findings are cheap
 * signals that should be fixed before paying for deeper semantic review.
 *
 * Checks (Knowledge/Rule-focused, matches the YAML-migrated atom corpus):
 *   K1. fact statement identical to description (no information added)
 *   K2. fact statement shorter than 20 characters (shallow claim)
 *   K3. tags empty or single-item (weak categorization)
 *   R1. check description identical to pass_condition (circular)
 *   R2. pass_condition contains a vague hedge verb only
 *        ("verify", "ensure", "check", "appropriate") → not decidable
 *   R3. check pass_condition shorter than 10 chars (undertested)
 *   G1. description equals name (no information delta)
 *   G2. no version field or version === "0.0.0" (unpublished)
 */

import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  ValueNode,
  ArrayNode,
  ObjectNode,
  StringNode,
} from "@skill-wiki/types";
import type { Diagnostic } from "./types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

const VAGUE_VERBS = [
  "verify",
  "verify that",
  "ensure",
  "check",
  "check that",
  "confirm",
  "make sure",
  "appropriate",
  "correct",
  "proper",
  "as needed",
  "if needed",
];

function findField(ast: AnyAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

function fieldAsString(field: FieldNode | undefined): string | undefined {
  if (!field) return undefined;
  if (field.value.type !== "String") return undefined;
  return (field.value as StringNode).value;
}

function objectField(obj: ObjectNode, key: string): ValueNode | undefined {
  return obj.fields.find((f) => f.key === key)?.value;
}

function objectStringField(obj: ObjectNode, key: string): string | undefined {
  const v = objectField(obj, key);
  if (!v || v.type !== "String") return undefined;
  return (v as StringNode).value;
}

function getArrayItems(field: FieldNode | undefined): ValueNode[] {
  if (!field) return [];
  if (field.value.type !== "Array") return [];
  return (field.value as ArrayNode).items;
}

function isVagueOnly(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return true;
  for (const verb of VAGUE_VERBS) {
    // if the whole passage is just the hedge verb or hedge+1 filler word, flag it
    if (lower === verb) return true;
    if (lower.startsWith(verb + " ") && lower.split(/\s+/).length <= 3) return true;
  }
  return false;
}

function emit(
  diagnostics: Diagnostic[],
  level: Diagnostic["level"],
  message: string,
  suggestion?: string,
  code?: string
): void {
  diagnostics.push({
    level,
    line: 0,
    message,
    suggestion,
    source: "L2:heuristic" + (code ? `:${code}` : ""),
  });
}

function checkGeneric(ast: AnyAST, diagnostics: Diagnostic[]): void {
  const name = fieldAsString(findField(ast, "name"));
  const description = fieldAsString(findField(ast, "description"));
  const version = fieldAsString(findField(ast, "version"));

  if (name && description && name.trim().toLowerCase() === description.trim().toLowerCase()) {
    emit(
      diagnostics,
      "warn",
      `description is identical to name — no information added`,
      `rewrite description to explain WHEN/WHY, not WHAT`,
      "G1"
    );
  }

  if (!version || version === "0.0.0") {
    emit(
      diagnostics,
      "suggestion",
      `version is ${version ?? "unset"} — mark published atoms with a real semver`,
      undefined,
      "G2"
    );
  }
}

function checkKnowledge(ast: AnyAST, diagnostics: Diagnostic[]): void {
  const description = fieldAsString(findField(ast, "description"));
  const facts = getArrayItems(findField(ast, "facts"));
  const tags = getArrayItems(findField(ast, "tags"));

  if (tags.length <= 1) {
    emit(
      diagnostics,
      "suggestion",
      `${tags.length} tag${tags.length === 1 ? "" : "s"} — weak categorization (target ≥ 2 orthogonal tags)`,
      undefined,
      "K3"
    );
  }

  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    if (f.type !== "Object") continue;
    const statement = objectStringField(f as ObjectNode, "statement");
    if (!statement) continue;

    if (description && statement.trim().toLowerCase() === description.trim().toLowerCase()) {
      emit(
        diagnostics,
        "warn",
        `fact[${i}].statement duplicates description — no new information`,
        `expand the fact with an example, mechanism, or consequence`,
        "K1"
      );
    }

    if (statement.trim().length < 20) {
      emit(
        diagnostics,
        "warn",
        `fact[${i}].statement is only ${statement.trim().length} chars — likely too shallow to be actionable`,
        undefined,
        "K2"
      );
    }
  }
}

function checkRule(ast: AnyAST, diagnostics: Diagnostic[]): void {
  const checks = getArrayItems(findField(ast, "checks"));

  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    if (c.type !== "Object") continue;
    const desc = objectStringField(c as ObjectNode, "description");
    const pass = objectStringField(c as ObjectNode, "pass_condition");
    if (!desc || !pass) continue;

    if (desc.trim().toLowerCase() === pass.trim().toLowerCase()) {
      emit(
        diagnostics,
        "warn",
        `checks[${i}]: description and pass_condition are identical — the check is circular`,
        `pass_condition should describe HOW to measure, not WHAT is checked`,
        "R1"
      );
    }

    if (isVagueOnly(pass)) {
      emit(
        diagnostics,
        "warn",
        `checks[${i}].pass_condition is a vague hedge ("${pass.slice(0, 40)}...") — not decidable`,
        `replace with a concrete, measurable condition (numeric threshold, output pattern, tool command)`,
        "R2"
      );
    }

    if (pass.trim().length < 10) {
      emit(
        diagnostics,
        "warn",
        `checks[${i}].pass_condition is only ${pass.trim().length} chars — unlikely to be testable`,
        undefined,
        "R3"
      );
    }
  }
}

/**
 * Run offline heuristic L2 checks.
 * Type-dispatches on the `extends` base class.
 */
export function checkL2Heuristic(ast: AnyAST): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  checkGeneric(ast, diagnostics);

  const extendsVal = isPrimeAST(ast) ? ast.extends : undefined;
  switch (extendsVal) {
    case "Knowledge":
      checkKnowledge(ast, diagnostics);
      break;
    case "Rule":
      checkRule(ast, diagnostics);
      break;
    default:
      // Method and user-defined subclasses — covered by LLM L2 only.
      break;
  }

  return diagnostics;
}
