/**
 * @module @skill-wiki/parser
 * Parser for .prime source files.
 *
 * Converts .prime source text into an AST (Abstract Syntax Tree).
 * The AST can then be consumed by the compiler, linter, or other tools.
 *
 * @example — legacy `prime` syntax
 * ```typescript
 * import { parse } from '@skill-wiki/parser';
 *
 * const { ast, errors } = parse(`
 *   prime Example extends Knowledge {
 *     name: "example"
 *     version: "1.0.0"
 *   }
 * `);
 * // ast.type === "PrimeDeclaration"
 * ```
 *
 * @example — new 28-type atom syntax
 * ```typescript
 * import { parse } from '@skill-wiki/parser';
 *
 * const { ast, errors } = parse(`
 *   fact WcagFocusContrast {
 *     statement: "Focus ring contrast must be ≥ 3:1"
 *     confidence: proven
 *   }
 * `);
 * // ast.type === "AtomDeclaration"  ast.kind === "fact"
 * ```
 */

import type { SyntaxAST, LegacySyntaxAST } from "@skill-wiki/types";
import { tokenize } from "./lexer.ts";
import { Parser } from "./parser.ts";
import { ParseError } from "./errors.ts";

/**
 * Parse a .prime source string into an AST.
 *
 * Handles both the legacy `prime Name extends Base { ... }` form (→ PrimeAST)
 * and the new 28-type atom form `<kind> Name { ... }` (→ AtomDeclaration).
 *
 * @param source - The raw .prime source text
 * @param filename - Optional filename for error messages and source maps
 * @returns Object containing the AST (PrimeAST | AtomDeclaration) and any
 *          parse errors encountered
 */
export function parse(
  source: string,
  filename?: string
): { ast: SyntaxAST; errors: ParseError[] } {
  const tokens = tokenize(source, filename);
  const parser = new Parser(tokens, filename, source);
  return parser.parse();
}
/** Parse only legacy declarations; generic units are deliberately rejected. */
export function parseLegacy(source: string, filename?: string): { ast: LegacySyntaxAST; errors: ParseError[] } {
  const result = parse(source, filename);
  const ast = result.ast;
  if (ast.type === "UnitDeclaration") {
    throw new ParseError({ message: "Generic unit is not supported by legacy consumers; use normalize API", line: ast.loc.line, column: ast.loc.column, filename });
  }
  if (ast.type === "PrimeDeclaration" || ast.type === "AtomDeclaration") return { ast, errors: result.errors };
  throw new Error("Unreachable syntax AST variant");
}

// Re-export sub-modules for advanced usage
export { tokenize, type Token, TokenType } from "./lexer.ts";
export { Parser } from "./parser.ts";
export { ParseError } from "./errors.ts";
