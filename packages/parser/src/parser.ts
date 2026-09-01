/**
 * @module parser
 * Recursive descent parser for .prime source files.
 *
 * Converts a token stream (from the lexer) into a PrimeAST or AtomDeclaration.
 * Implements error recovery: on syntax errors, skips to the next
 * top-level field and continues parsing, collecting all errors.
 */

import type {
  PrimeAST,
  AtomDeclaration,
  AtomKind,
  DecoratorNode,
  FieldNode,
  ValueNode,
  ObjectNode,
  ArrayNode,
  StringNode,
  NumberNode,
  BooleanNode,
  IdentNode,
  ArrowNode,
  StepNode,
  ReferenceNode,
  EnumValueNode,
  LinkShorthandNode,
  ThresholdNode,
  ParameterShorthandNode,
  OverrideNode,
  AppendNode,
  ExtendNode,
  SourceLocation,
  UnitDeclaration,
  SyntaxAST,
} from "@aoe/types";

import { type Token, TokenType } from "./lexer.ts";
import { ParseError } from "./errors.ts";

// ─── Parser Class ───────────────────────────────────────────────────────────
//
// Link shorthand is marked by an explicit arrow — `verb -> "target"` — and never
// by the verb's spelling.  The grammar therefore needs no verb vocabulary: the
// shape `IDENT ARROW STRING` is a relation and the shape `IDENT STRING` is a
// category shorthand, for every identifier alike.  Whether a verb names a real
// relation is a Model Resolver question (plan §6.4), not a grammar question, so
// keeping a verb list here would have made the parser decide it (plan §15.4).

export class Parser {
  private tokens: Token[];
  private pos: number = 0;
  private errors: ParseError[] = [];
  private filename?: string;
  /** Original source text — used to slice raw expression text for
   *  lightweight grammar fallbacks (function signatures, type expressions). */
  private source: string;

  constructor(tokens: Token[], filename?: string, source: string = "") {
    this.tokens = tokens;
    this.filename = filename;
    this.source = source;
  }

  // ── Token navigation ──────────────────────────────────────────────────

  private current(): Token {
    return this.tokens[this.pos] ?? this.eofToken();
  }

  private peek(offset: number = 0): Token {
    return this.tokens[this.pos + offset] ?? this.eofToken();
  }

  /**
   * Look ahead past any newline/comment tokens.
   */
  private peekSignificant(offset: number = 0): Token {
    const idx = this.peekSignificantIndex(offset);
    return idx >= 0 ? this.tokens[idx] : this.eofToken();
  }

  /**
   * Same as peekSignificant but returns the index in the token array
   * (or -1 if not found).  Useful when callers need the token's line
   * and column to compare with the current line.
   */
  private peekSignificantIndex(offset: number = 0): number {
    let idx = this.pos;
    let skipped = 0;
    while (idx < this.tokens.length) {
      const tok = this.tokens[idx];
      if (tok.type !== TokenType.NEWLINE && tok.type !== TokenType.COMMENT) {
        if (skipped === offset) return idx;
        skipped++;
      }
      idx++;
    }
    return -1;
  }

  private eofToken(): Token {
    return { type: TokenType.EOF, value: "", line: 0, column: 0, offset: 0 };
  }

  private advance(): Token {
    const tok = this.current();
    if (this.pos < this.tokens.length) {
      this.pos++;
    }
    return tok;
  }

  private expect(type: TokenType, message?: string): Token {
    const tok = this.current();
    if (tok.type !== type) {
      this.addError(
        message ?? `Expected ${type}, got ${tok.type} ("${tok.value}")`,
        tok,
        `Add a ${type} here`
      );
      // Return a synthetic token so parsing can continue
      return { type, value: "", line: tok.line, column: tok.column, offset: tok.offset };
    }
    return this.advance();
  }

  private match(type: TokenType): boolean {
    if (this.current().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  private isAtEnd(): boolean {
    return this.current().type === TokenType.EOF;
  }

  /**
   * Skip newline and comment tokens.
   */
  private skipTrivia(): void {
    while (
      this.current().type === TokenType.NEWLINE ||
      this.current().type === TokenType.COMMENT
    ) {
      this.advance();
    }
  }

  private loc(token: Token): SourceLocation {
    return { line: token.line, column: token.column, offset: token.offset };
  }

  /**
   * Check if the current position looks like the start of a field (IDENT COLON)
   * or an inheritance keyword (override/append/extend).
   * Used for error recovery to detect missing values.
   */
  private isFieldStart(): boolean {
    const tok = this.current();
    if (tok.type === TokenType.OVERRIDE || tok.type === TokenType.APPEND || tok.type === TokenType.EXTEND) {
      return true;
    }
    // Anything that can be a field name followed by a colon
    if (this.isFieldNameToken(tok)) {
      const next = this.peekSignificant(1);
      if (next.type === TokenType.COLON) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if the given token can appear as a field name (key) inside
   * a body or object literal.  Includes plain IDENTs and the structural
   * keywords.  Kind names (`fact`, `rule`, `type`, …) need no special case —
   * they are ordinary IDENTs.
   */
  private isFieldNameToken(tok: Token): boolean {
    return (
      tok.type === TokenType.IDENT ||
      tok.type === TokenType.PRIME ||
      tok.type === TokenType.UNIT ||
      tok.type === TokenType.EXTENDS ||
      tok.type === TokenType.AS
    );
  }

  // ── Error handling ────────────────────────────────────────────────────

  private addError(message: string, token: Token, suggestion?: string): void {
    // Hard cap to prevent runaway error storms (and the OOM that can follow
    // when a malformed file collides with an unimplemented grammar branch).
    // 256 errors is far more than any well-formed source would ever produce;
    // beyond that the cause is structural and further messages add no signal.
    if (this.errors.length >= 256) {
      if (this.errors.length === 256) {
        this.errors.push(
          new ParseError({
            message: "Too many parse errors — aborting (file is structurally malformed or uses unsupported grammar)",
            line: token.line,
            column: token.column,
            filename: this.filename,
          })
        );
      }
      return;
    }
    this.errors.push(
      new ParseError({
        message,
        line: token.line,
        column: token.column,
        suggestion,
        filename: this.filename,
      })
    );
  }

  /**
   * Error recovery: skip tokens until we find something that looks like
   * a top-level field start (IDENT COLON, RBRACE, override/append/extend, or EOF).
   */
  private recoverToNextField(): void {
    while (!this.isAtEnd()) {
      const tok = this.current();

      // Found a closing brace - stop here (let caller handle it)
      if (tok.type === TokenType.RBRACE || tok.type === TokenType.RBRACKET) {
        return;
      }

      // Found what looks like a field start: IDENT followed by COLON
      if (tok.type === TokenType.IDENT) {
        const next = this.peekSignificant(1);
        if (next.type === TokenType.COLON || next.type === TokenType.LBRACE) {
          return;
        }
      }

      // Found an inheritance keyword
      if (
        tok.type === TokenType.OVERRIDE ||
        tok.type === TokenType.APPEND ||
        tok.type === TokenType.EXTEND
      ) {
        return;
      }

      this.advance();
    }
  }

  // ── Top-level parsing ─────────────────────────────────────────────────

  /**
   * Parse the entire .prime file.
   *
   * Supports three top-level forms:
   *   1. Legacy:    `prime Name extends Base { ... }`   → PrimeAST
   *   2. Kind form: `<ident> Name { ... }`              → AtomDeclaration
   *   3. Generic:   `unit Name : TypeRef { ... }`       → UnitDeclaration
   *
   * Form 2 is recognised purely structurally — `IDENT IDENT '{'` — so the
   * parser never holds a list of legal kinds. Whether `fact` names a real type
   * is a Model Resolver question, not a grammar question (plan §6.4).
   *
   * Returns a discriminated union so callers can narrow by `.type`.
   */
  parse(): { ast: SyntaxAST; errors: ParseError[] } {
    this.skipTrivia();

    // Parse decorators before the keyword
    const decorators = this.parseDecorators();

    this.skipTrivia();

    const keywordTok = this.current();
    if (keywordTok.type === TokenType.UNIT) return this.parseUnitDeclaration(decorators, keywordTok);

    // ── Kind form: `<ident> Name { … }` ───────────────────────────────
    if (this.looksLikeKindDeclaration()) {
      return this.parseAtomDeclaration(decorators, keywordTok, keywordTok.value);
    }

    // ── Legacy: `prime Name extends Base { ... }` ────────────────────
    this.expect(TokenType.PRIME, "Expected 'prime', a type name, or 'unit' at top level");
    this.skipTrivia();

    const nameTok = this.expect(TokenType.IDENT, "Expected prime name (PascalCase identifier)");
    this.skipTrivia();

    // Optional extends clause
    let extendsName: string | undefined;
    if (this.check(TokenType.EXTENDS)) {
      this.advance();
      this.skipTrivia();
      const extTok = this.expect(TokenType.IDENT, "Expected base class name after 'extends'");
      extendsName = extTok.value;
      this.skipTrivia();
    }

    // Opening brace
    this.expect(TokenType.LBRACE, "Expected '{' to open prime body");
    this.skipTrivia();

    // Parse body fields
    const body = this.parseBody();

    // Closing brace
    this.skipTrivia();
    this.expect(TokenType.RBRACE, "Expected '}' to close prime body");

    const ast: PrimeAST = {
      type: "PrimeDeclaration",
      name: nameTok.value,
      decorators,
      body,
      loc: this.loc(keywordTok),
    };

    if (extendsName) {
      ast.extends = extendsName;
    }
    if (this.filename) {
      ast.filename = this.filename;
    }

    return { ast, errors: this.errors };
  }

  /**
   * Structural lookahead for the kind declaration form `<ident> Name { … }`.
   *
   * Two IDENTs followed by `{` is unambiguous against every other top-level
   * form: the legacy form starts with the `prime` keyword and the generic form
   * with `unit`, and neither of those lexes as IDENT. Deciding this without a
   * kind table is what lets a new domain type parse with no Core edit.
   */
  private looksLikeKindDeclaration(): boolean {
    if (this.current().type !== TokenType.IDENT) return false;
    if (this.peekSignificant(1).type !== TokenType.IDENT) return false;
    return this.peekSignificant(2).type === TokenType.LBRACE;
  }

  private parseUnitDeclaration(decorators: DecoratorNode[], keywordTok: Token): { ast: UnitDeclaration; errors: ParseError[] } {
    this.advance(); this.skipTrivia();
    const nameTok = this.expect(TokenType.IDENT, "Expected unit name after 'unit'"); this.skipTrivia();
    this.expect(TokenType.COLON, "Expected ':' after unit name"); this.skipTrivia();
    const typeTok = this.current();
    // A type reference is either a bare identifier (`Ticket`) or a
    // model-qualified reference (`@widget-shop/Widget`, plan §6.2). The lexer
    // already reads `@scope/path` as one STRING token — that is the language's
    // existing cross-reference spelling, so qualified refs need no new token
    // type. A quoted string that is NOT a reference stays an error: `: "Ticket"`
    // is a literal, and silently accepting it would make typos compile.
    const isQualifiedRef = typeTok.type === TokenType.STRING && typeTok.value.startsWith("@");
    if (typeTok.type !== TokenType.IDENT && !isQualifiedRef) {
      this.addError("Expected type reference after ':'", typeTok, "Use a type name such as Ticket or @model/Type");
      if (!this.isAtEnd() && !this.check(TokenType.LBRACE)) this.advance();
    } else this.advance();
    this.skipTrivia(); this.expect(TokenType.LBRACE, "Expected '{' to open unit body"); this.skipTrivia();
    const body = this.parseBody(); this.skipTrivia(); this.expect(TokenType.RBRACE, "Expected '}' to close unit body");
    const ast: UnitDeclaration = { type: "UnitDeclaration", name: nameTok.value, typeRef: { type: "TypeRef", name: typeTok.value, loc: this.loc(typeTok) }, decorators, body, loc: this.loc(keywordTok) };
    if (this.filename) ast.filename = this.filename;
    return { ast, errors: this.errors };
  }

  /**
   * Parse a new-style atom declaration: `<kind> Name { field* }`.
   * Called after the leading keyword token has been identified.
   */
  private parseAtomDeclaration(
    decorators: DecoratorNode[],
    keywordTok: Token,
    kind: AtomKind,
  ): { ast: AtomDeclaration; errors: ParseError[] } {
    this.advance(); // consume the kind keyword
    this.skipTrivia();

    const nameTok = this.expect(TokenType.IDENT, `Expected atom name (PascalCase identifier) after '${kind}'`);
    this.skipTrivia();

    // Opening brace
    this.expect(TokenType.LBRACE, `Expected '{' to open ${kind} body`);
    this.skipTrivia();

    const body = this.parseBody();

    this.skipTrivia();
    this.expect(TokenType.RBRACE, `Expected '}' to close ${kind} body`);

    const ast: AtomDeclaration = {
      type: "AtomDeclaration",
      kind,
      name: nameTok.value,
      decorators,
      body,
      loc: this.loc(keywordTok),
    };

    if (this.filename) {
      ast.filename = this.filename;
    }

    return { ast, errors: this.errors };
  }

  // ── Decorators ────────────────────────────────────────────────────────

  private parseDecorators(): DecoratorNode[] {
    const decorators: DecoratorNode[] = [];
    while (this.current().type === TokenType.AT_DECORATOR) {
      const tok = this.advance();
      decorators.push({
        type: "Decorator",
        name: tok.value,
        loc: this.loc(tok),
      });
      this.skipTrivia();
    }
    return decorators;
  }

  // ── Body parsing ──────────────────────────────────────────────────────

  /**
   * Parse the body of a prime declaration or object literal.
   * Returns an array of FieldNode (and possibly OverrideNode/AppendNode/ExtendNode
   * cast to FieldNode for unified representation).
   */
  private parseBody(): FieldNode[] {
    const fields: FieldNode[] = [];

    while (!this.isAtEnd() && !this.check(TokenType.RBRACE)) {
      this.skipTrivia();

      if (this.isAtEnd() || this.check(TokenType.RBRACE)) break;

      const beforePos = this.pos;
      try {
        const tok = this.current();

        // Handle override/append/extend as special field entries
        if (tok.type === TokenType.OVERRIDE) {
          const node = this.parseOverride();
          // Wrap as a pseudo-field for uniform body representation
          fields.push({
            type: "Field",
            key: `override:${node.path.join(".")}`,
            value: { type: "Object", fields: node.body, loc: node.loc } as ObjectNode,
            loc: node.loc,
          });
          continue;
        }

        if (tok.type === TokenType.APPEND) {
          const node = this.parseAppend();
          fields.push({
            type: "Field",
            key: `append:${node.target}`,
            value: node.value,
            loc: node.loc,
          });
          continue;
        }

        if (tok.type === TokenType.EXTEND) {
          const node = this.parseExtend();
          fields.push({
            type: "Field",
            key: `extend:${node.target}`,
            value: node.value,
            loc: node.loc,
          });
          continue;
        }

        // Normal field: IDENT COLON value
        // In body context, keywords like "prime", "extends", "as", and all 28
        // atom-kind keywords can also appear as field names.
        if (this.isFieldNameToken(tok)) {
          const field = this.parseField();
          if (field) {
            fields.push(field);
          }
          continue;
        }

        // Something unexpected
        this.addError(
          `Unexpected token ${tok.type} ("${tok.value}")`,
          tok,
          "Expected a field name, 'override', 'append', or 'extend'"
        );
        this.recoverToNextField();
      } catch (e) {
        // Catch any unexpected errors and recover
        if (e instanceof ParseError) {
          this.errors.push(e);
        }
        this.recoverToNextField();
      }

      // Loop-progress guarantee: avoid livelock if neither parseField nor
      // recoverToNextField advanced the cursor.
      if (this.pos === beforePos) {
        this.advance();
      }
    }

    return fields;
  }

  // ── Field parsing ─────────────────────────────────────────────────────

  /**
   * Parse a single field: `key: value` or `key: { ... }` or `key: [ ... ]`.
   *
   * The key may be an IDENT, an atom-kind keyword used as an identifier, a
   * STRING literal (for string-keyed maps like `"@id": value`) or a NUMBER
   * (for numeric scales like `0: "label"`).  The latter two only make sense
   * in object-body contexts; the caller decides which positions to allow.
   */
  private parseField(): FieldNode | null {
    const keyTok = this.advance(); // IDENT / STRING / NUMBER / keyword
    this.skipTrivia();

    // key: value
    if (this.check(TokenType.COLON)) {
      this.advance(); // consume ':'
      this.skipTrivia();

      // Error recovery: check if value is missing (next token looks like another field)
      if (this.isFieldStart() || this.check(TokenType.RBRACE) || this.check(TokenType.RBRACKET)) {
        this.addError(
          `Expected value after '${keyTok.value}:', got ${this.current().type}`,
          this.current(),
          `Add a value after '${keyTok.value}:'`
        );
        return {
          type: "Field",
          key: keyTok.value,
          value: { type: "Ident", value: "", loc: this.loc(keyTok) } as IdentNode,
          loc: this.loc(keyTok),
        };
      }

      const value = this.parseValue();
      return {
        type: "Field",
        key: keyTok.value,
        value,
        loc: this.loc(keyTok),
      };
    }

    // Step shorthand: IDENT { ... } (no colon)
    if (this.check(TokenType.LBRACE)) {
      const step = this.parseStepBody(keyTok);
      return {
        type: "Field",
        key: keyTok.value,
        value: step,
        loc: this.loc(keyTok),
      };
    }

    // IDENT -> "target" — link shorthand as a bare body statement.  Supported
    // here too so the relation form is identical in all three positions
    // (field value, array item, body statement) rather than position-dependent.
    if (this.check(TokenType.ARROW)) {
      const link = this.parseLinkShorthand(keyTok);
      return {
        type: "Field",
        key: keyTok.value,
        value: link,
        loc: this.loc(keyTok),
      };
    }

    // IDENT followed by IDENT STRING — parameter shorthand: task(string) "desc"
    // But without parens, this is: IDENT STRING — category shorthand
    if (this.check(TokenType.STRING)) {
      const descTok = this.advance();
      // This is a "Name Description" shorthand for list items
      // We return it as a ParameterShorthandNode without a type
      const node: ParameterShorthandNode = {
        type: "ParameterShorthand",
        name: keyTok.value,
        paramType: "",
        description: descTok.value,
        loc: this.loc(keyTok),
      };
      return {
        type: "Field",
        key: keyTok.value,
        value: node,
        loc: this.loc(keyTok),
      };
    }

    // IDENT ( TYPE ) STRING — parameter shorthand with type
    if (this.check(TokenType.LPAREN)) {
      const paramNode = this.parseParameterShorthand(keyTok);
      return {
        type: "Field",
        key: keyTok.value,
        value: paramNode,
        loc: this.loc(keyTok),
      };
    }

    // Unexpected - just the ident with no value
    this.addError(
      `Expected ':' after field name '${keyTok.value}'`,
      this.current(),
      `Add ': <value>' after '${keyTok.value}'`
    );
    return null;
  }

  /**
   * Capture a raw expression as a String node by collecting tokens until the
   * end of the current logical line (newline at depth 0) or a top-level
   * delimiter (comma, closing bracket/brace).  Brackets / parens / braces are
   * tracked so that a multi-line `(...)` expression is captured correctly.
   *
   * Returns the slice of original source between the start token's offset
   * and the end of the captured range, with surrounding whitespace trimmed.
   *
   * Used as a fallback for grammars we don't fully model:
   *   - function signatures `(arg: Type) -> Bool`
   *   - type unions `string | number | object`
   *   - typed array `string[]`
   *   - range `0..1`
   */
  private parseRawExpression(): StringNode {
    const startTok = this.current();
    const startOffset = startTok.offset;
    let depth = 0;
    let endOffset = startOffset + startTok.value.length;

    while (!this.isAtEnd()) {
      const tok = this.current();

      if (depth === 0) {
        // Stop conditions at the top level
        if (
          tok.type === TokenType.NEWLINE ||
          tok.type === TokenType.RBRACE ||
          tok.type === TokenType.RBRACKET ||
          tok.type === TokenType.COMMA ||
          tok.type === TokenType.EOF
        ) {
          break;
        }
      }

      if (
        tok.type === TokenType.LPAREN ||
        tok.type === TokenType.LBRACE ||
        tok.type === TokenType.LBRACKET
      ) {
        depth++;
      } else if (
        tok.type === TokenType.RPAREN ||
        tok.type === TokenType.RBRACE ||
        tok.type === TokenType.RBRACKET
      ) {
        if (depth === 0) break; // shouldn't happen because of guard above
        depth--;
      }

      // Update endOffset to one past this token
      endOffset = tok.offset + (tok.value?.length ?? 1);
      this.advance();

      // After advancing, peek for early termination at depth 0
      if (depth === 0) {
        const nxt = this.current();
        if (
          nxt.type === TokenType.NEWLINE ||
          nxt.type === TokenType.RBRACE ||
          nxt.type === TokenType.RBRACKET ||
          nxt.type === TokenType.COMMA ||
          nxt.type === TokenType.EOF
        ) {
          break;
        }
      }
    }

    let raw = this.source.slice(startOffset, endOffset).trim();
    // Collapse internal whitespace runs to single spaces for readability;
    // the raw form preserves operator/identifier order which is what we need.
    raw = raw.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();

    return {
      type: "String",
      value: raw,
      loc: this.loc(startTok),
    };
  }

  // ── Value parsing ─────────────────────────────────────────────────────

  /**
   * Parse a value expression.
   */
  private parseValue(): ValueNode {
    this.skipTrivia();
    const tok = this.current();

    switch (tok.type) {
      case TokenType.STRING: {
        const strTok = this.advance();
        this.skipTrivia();
        // Check for arrow expression: "left" → "right"
        if (this.check(TokenType.ARROW)) {
          return this.parseArrow(strTok);
        }
        // Type-union or trailing type expression: "color" | "dimension" | ...
        // Captured as a single string for downstream tools.
        if (this.check(TokenType.IDENT) && this.current().value === "|") {
          // Re-position to start of the original string token and capture raw.
          this.pos--;
          return this.parseRawExpression();
        }
        return {
          type: "String",
          value: strTok.value,
          loc: this.loc(strTok),
        } as StringNode;
      }

      case TokenType.NUMBER: {
        const numTok = this.advance();
        // Range expression: 0..255, 0..1, 0..0.4
        if (this.check(TokenType.DOT) && this.peek(1).type === TokenType.DOT) {
          this.pos--; // back up
          return this.parseRawExpression();
        }
        // Numeric union: 0..4 | 5..9 (rare) — captured raw if pipe follows.
        return {
          type: "Number",
          value: parseFloat(numTok.value),
          loc: this.loc(numTok),
        } as NumberNode;
      }

      case TokenType.PERCENT: {
        const pctTok = this.advance();
        return {
          type: "Number",
          value: parseFloat(pctTok.value),
          loc: this.loc(pctTok),
        } as NumberNode;
      }

      case TokenType.BOOLEAN: {
        const boolTok = this.advance();
        return {
          type: "Boolean",
          value: boolTok.value === "true",
          loc: this.loc(boolTok),
        } as BooleanNode;
      }

      case TokenType.LBRACE:
        return this.parseObjectLiteral();

      case TokenType.LBRACKET:
        return this.parseArrayLiteral();

      case TokenType.LPAREN: {
        // Function signature or parenthesised type expression.
        // Captured as a String — preserves the original syntax for tools and
        // downstream emitters without committing to a full type AST.
        return this.parseRawExpression();
      }

      case TokenType.AT_DECORATOR: {
        const decTok = this.advance();
        return {
          type: "EnumValue",
          value: decTok.value,
          loc: this.loc(decTok),
        } as EnumValueNode;
      }

      case TokenType.IDENT: {
        return this.parseIdentValue();
      }
      case TokenType.UNIT: {
        this.advance();
        return { type: "Ident", value: tok.value, loc: this.loc(tok) } as IdentNode;
      }

      default: {
        this.addError(
          `Unexpected token ${tok.type} ("${tok.value}"), expected a value`,
          tok
        );
        this.advance();
        return {
          type: "Ident",
          value: "",
          loc: this.loc(tok),
        } as IdentNode;
      }
    }
  }

  /**
   * Parse a value that starts with an identifier.
   * Could be: simple ident, dotted reference, reference with alias,
   * link shorthand, or `until` / `max` loop syntax.
   */
  private parseIdentValue(): ValueNode {
    // Type-union expression starting with an ident (e.g. `URL | null`,
    // `string | number | object`, `string[]`).  Captured as a raw string
    // for downstream tools.  We detect by peeking forward past whitespace.
    {
      const next = this.peekSignificant(1);
      if (
        (next.type === TokenType.IDENT && next.value === "|") ||
        next.type === TokenType.LBRACKET
      ) {
        // For `IDENT[]` (typed array shorthand), only fall back if the
        // bracket is immediately followed by a closing one — i.e. the form
        // `IDENT[]`, not `IDENT[expr]`.
        if (next.type === TokenType.LBRACKET) {
          // Look two ahead
          const nextNext = this.peekSignificant(2);
          if (nextNext.type === TokenType.RBRACKET) {
            return this.parseRawExpression();
          }
        } else {
          return this.parseRawExpression();
        }
      }
    }

    // Read the identifier
    const identTok = this.advance();
    this.skipTrivia();

    // Link shorthand: IDENT -> "target" [( modifiers )]
    if (this.check(TokenType.ARROW)) {
      return this.parseLinkShorthand(identTok);
    }

    // Check for dotted path: IDENT.IDENT.IDENT
    if (this.check(TokenType.DOT)) {
      return this.parseDottedPath(identTok);
    }

    // Check for alias: IDENT as ALIAS
    if (this.check(TokenType.AS)) {
      this.advance(); // consume 'as'
      this.skipTrivia();
      const aliasTok = this.expect(TokenType.IDENT, "Expected alias name after 'as'");
      return {
        type: "Reference",
        path: [identTok.value],
        alias: aliasTok.value,
        loc: this.loc(identTok),
      } as ReferenceNode;
    }

    // Check for parameter shorthand: ident(type) "description"
    // OR a predicate / function-call expression: ident(args) >= value
    if (this.check(TokenType.LPAREN)) {
      // Look ahead: if the parens enclose `IDENT)` (single token), treat as
      // parameter shorthand.  Anything more complex falls back to raw
      // expression capture so predicates like
      // `wcag-contrast-ratio(fg, bg) >= 4.5` survive intact.
      const inner1 = this.peek(1);
      const inner2 = this.peek(2);
      const isSimpleParam =
        inner1.type === TokenType.IDENT && inner2.type === TokenType.RPAREN;
      if (isSimpleParam) {
        return this.parseParameterShorthand(identTok);
      }
      // Otherwise capture the whole expression as raw, starting from the
      // IDENT we already consumed.
      this.pos--; // back up to the IDENT
      // Skip back past any inserted trivia (NEWLINE/COMMENT) so we land on
      // the IDENT itself.
      while (
        this.pos > 0 &&
        (this.tokens[this.pos].type === TokenType.NEWLINE ||
          this.tokens[this.pos].type === TokenType.COMMENT)
      ) {
        this.pos--;
      }
      return this.parseRawExpression();
    }

    // Check for step shorthand: IDENT { ... } (when in array context)
    if (this.check(TokenType.LBRACE)) {
      return this.parseStepBody(identTok);
    }

    // Check if ident is followed by a string (category shorthand: Name "Description")
    if (this.check(TokenType.STRING)) {
      const descTok = this.advance();
      return {
        type: "ParameterShorthand",
        name: identTok.value,
        paramType: "",
        description: descTok.value,
        loc: this.loc(identTok),
      } as ParameterShorthandNode;
    }

    // Check for threshold shorthand: metric block: < 60% warn: < 80% pass: >= 80%
    if (this.isThresholdStart()) {
      return this.parseThresholdShorthand(identTok);
    }

    // Plain identifier
    return {
      type: "Ident",
      value: identTok.value,
      loc: this.loc(identTok),
    } as IdentNode;
  }

  /**
   * Check if the current position looks like a threshold level start.
   */
  private isThresholdStart(): boolean {
    // Look for pattern: IDENT(block/warn/pass) COLON LT/GT/LTE/GTE NUMBER
    const tok = this.current();
    if (tok.type !== TokenType.IDENT) return false;
    const val = tok.value;
    return val === "block" || val === "warn" || val === "pass";
  }

  /**
   * Parse a threshold shorthand: `metric block: < 60% warn: < 80% pass: >= 80%`
   */
  private parseThresholdShorthand(metricTok: Token): ThresholdNode {
    const levels: { level: string; operator: string; value: number; unit?: string }[] = [];

    while (
      !this.isAtEnd() &&
      this.current().type === TokenType.IDENT &&
      (this.current().value === "block" ||
        this.current().value === "warn" ||
        this.current().value === "pass")
    ) {
      const levelTok = this.advance();
      this.skipTrivia();
      this.expect(TokenType.COLON, "Expected ':' after threshold level");
      this.skipTrivia();

      // Parse operator
      let operator = "";
      const opTok = this.current();
      if (opTok.type === TokenType.LT) { operator = "<"; this.advance(); }
      else if (opTok.type === TokenType.GT) { operator = ">"; this.advance(); }
      else if (opTok.type === TokenType.LTE) { operator = "<="; this.advance(); }
      else if (opTok.type === TokenType.GTE) { operator = ">="; this.advance(); }
      else {
        this.addError("Expected comparison operator (<, >, <=, >=)", opTok);
        operator = "<";
      }
      this.skipTrivia();

      // Parse number (possibly with %)
      let value = 0;
      let unit: string | undefined;
      if (this.check(TokenType.NUMBER)) {
        const numTok = this.advance();
        value = parseFloat(numTok.value);
        // Check for trailing %
        if (this.check(TokenType.IDENT) && this.current().value === "%") {
          unit = "%";
          this.advance();
        }
      } else if (this.check(TokenType.PERCENT)) {
        const pctTok = this.advance();
        value = parseFloat(pctTok.value);
        unit = "%";
      } else {
        this.addError("Expected a number for threshold value", this.current());
      }
      this.skipTrivia();

      levels.push({ level: levelTok.value, operator, value, unit });
    }

    return {
      type: "Threshold",
      metric: metricTok.value,
      levels,
      loc: this.loc(metricTok),
    };
  }

  /**
   * Parse a dotted path reference: `A.B.C` optionally with `as alias`.
   */
  private parseDottedPath(firstTok: Token): ReferenceNode {
    const path = [firstTok.value];
    while (this.check(TokenType.DOT)) {
      this.advance(); // consume '.'
      this.skipTrivia();
      const segTok = this.expect(TokenType.IDENT, "Expected identifier after '.'");
      path.push(segTok.value);
      this.skipTrivia();
    }

    let alias: string | undefined;
    if (this.check(TokenType.AS)) {
      this.advance();
      this.skipTrivia();
      const aliasTok = this.expect(TokenType.IDENT, "Expected alias name after 'as'");
      alias = aliasTok.value;
    }

    return {
      type: "Reference",
      path,
      alias,
      loc: this.loc(firstTok),
    };
  }

  /**
   * Parse parameter shorthand: `name(type) "description"`.
   */
  private parseParameterShorthand(nameTok: Token): ParameterShorthandNode {
    this.expect(TokenType.LPAREN, "Expected '(' for parameter type");
    this.skipTrivia();
    const typeTok = this.expect(TokenType.IDENT, "Expected type name");
    this.skipTrivia();
    this.expect(TokenType.RPAREN, "Expected ')' after parameter type");
    this.skipTrivia();

    let description: string | undefined;
    if (this.check(TokenType.STRING)) {
      description = this.advance().value;
    }

    return {
      type: "ParameterShorthand",
      name: nameTok.value,
      paramType: typeTok.value,
      description,
      loc: this.loc(nameTok),
    };
  }

  /**
   * Parse a link shorthand: `requires -> "target-name"`.
   * The verb identifier has already been consumed; the cursor is on the arrow.
   */
  private parseLinkShorthand(verbTok: Token): LinkShorthandNode {
    this.advance(); // consume '->'
    this.skipTrivia();
    const targetTok = this.expect(TokenType.STRING, "Expected string target after '->'");

    let modifiers: ObjectNode | undefined;
    this.skipTrivia();
    if (this.check(TokenType.LPAREN)) {
      this.advance(); // (
      this.skipTrivia();
      const fields = this.parseBodyUntil(TokenType.RPAREN);
      this.expect(TokenType.RPAREN, "Expected ')' after link modifiers");
      modifiers = {
        type: "Object",
        fields,
        loc: this.loc(verbTok),
      };
    }

    return {
      type: "LinkShorthand",
      verb: verbTok.value,
      target: targetTok.value,
      modifiers,
      loc: this.loc(verbTok),
    };
  }

  /**
   * Parse an arrow expression: `"left" → "right"`.
   * Called after left string has been consumed and ARROW detected.
   */
  private parseArrow(leftTok: Token): ArrowNode {
    this.advance(); // consume →
    this.skipTrivia();
    const rightTok = this.expect(TokenType.STRING, 'Expected string after "→"');

    return {
      type: "Arrow",
      left: {
        type: "String",
        value: leftTok.value,
        loc: this.loc(leftTok),
      },
      right: {
        type: "String",
        value: rightTok.value,
        loc: this.loc(rightTok),
      },
      loc: this.loc(leftTok),
    };
  }

  // ── Object & Array literals ───────────────────────────────────────────

  /**
   * Parse an object literal: `{ field* }`.
   */
  private parseObjectLiteral(): ObjectNode {
    const openTok = this.advance(); // consume '{'
    this.skipTrivia();

    const fields = this.parseBodyUntil(TokenType.RBRACE);

    this.skipTrivia();
    this.expect(TokenType.RBRACE, "Expected '}' to close object literal");

    return {
      type: "Object",
      fields,
      loc: this.loc(openTok),
    };
  }

  /**
   * Parse body fields until a specific closing token.
   * Accepts STRING and NUMBER as field keys in addition to identifiers and
   * atom-kind keywords — useful for string-keyed config maps and numeric
   * scales (`0: "label"`).
   */
  private parseBodyUntil(closingType: TokenType): FieldNode[] {
    const fields: FieldNode[] = [];

    while (!this.isAtEnd() && !this.check(closingType)) {
      this.skipTrivia();
      // Skip commas between fields (common in object literals)
      while (this.check(TokenType.COMMA)) {
        this.advance();
        this.skipTrivia();
      }
      if (this.isAtEnd() || this.check(closingType)) break;

      const beforePos = this.pos;
      try {
        const tok = this.current();
        // In nested objects, structural keywords can be field names too
        // (e.g. `{ unit: "x" }`); kind names are plain IDENTs and need no case.
        if (this.isFieldNameToken(tok)) {
          const field = this.parseField();
          if (field) fields.push(field);
        } else if (
          (tok.type === TokenType.STRING || tok.type === TokenType.NUMBER) &&
          this.peekSignificant(1).type === TokenType.COLON
        ) {
          // String- or number-keyed entry: `"@id": 0.95` or `0: "label"`.
          const field = this.parseField();
          if (field) fields.push(field);
        } else if (tok.type === TokenType.AT_DECORATOR) {
          // Handle decorator enum values as field starts (shouldn't normally happen)
          this.addError(`Unexpected token ${tok.type} in object body`, tok);
          this.advance();
        } else {
          this.addError(`Unexpected token ${tok.type} in object body`, tok);
          this.advance();
        }
      } catch {
        this.recoverToNextField();
      }

      // Loop-progress guarantee
      if (this.pos === beforePos) {
        this.advance();
      }
    }

    return fields;
  }

  /**
   * Parse an array literal: `[ items ]`.
   *
   * Array items can be:
   * - Simple values (string, number, boolean)
   * - Object literals { ... }
   * - Arrow expressions "x" → "y"
   * - Step shorthands: NAME { ... }
   * - Category shorthands: Name "description"
   * - Parameter shorthands: name(type) "description"
   * - Link shorthands: requires "target"
   * - Threshold shorthands: metric block: ... warn: ... pass: ...
   * - References: A.B.C or X as alias
   */
  private parseArrayLiteral(): ArrayNode {
    const openTok = this.advance(); // consume '['
    this.skipTrivia();

    const items: ValueNode[] = [];

    while (!this.isAtEnd() && !this.check(TokenType.RBRACKET)) {
      this.skipTrivia();
      if (this.isAtEnd() || this.check(TokenType.RBRACKET)) break;

      const beforePos = this.pos;
      try {
        const item = this.parseArrayItem();
        items.push(item);
      } catch {
        // Recovery: skip to next item or closing bracket
        while (
          !this.isAtEnd() &&
          !this.check(TokenType.RBRACKET) &&
          !this.check(TokenType.COMMA)
        ) {
          if (
            this.check(TokenType.LBRACE) ||
            this.check(TokenType.STRING) ||
            this.check(TokenType.IDENT) ||
            this.check(TokenType.AT_DECORATOR)
          ) {
            break;
          }
          this.advance();
        }
      }

      // Optional comma between items
      this.skipTrivia();
      this.match(TokenType.COMMA);
      this.skipTrivia();

      // Loop-progress guarantee: if neither parseArrayItem nor recovery
      // advanced the cursor (e.g., a token type that triggers exceptions
      // *and* satisfies the recovery break-list), force one step to avoid
      // an O(N) heap-burning livelock.
      if (this.pos === beforePos) {
        this.advance();
      }
    }

    this.expect(TokenType.RBRACKET, "Expected ']' to close array");

    return {
      type: "Array",
      items,
      loc: this.loc(openTok),
    };
  }

  /**
   * Parse a single array item. More flexible than parseValue() because
   * array context allows additional shorthands.
   */
  private parseArrayItem(): ValueNode {
    this.skipTrivia();
    const tok = this.current();

    // Object literal
    if (tok.type === TokenType.LBRACE) {
      return this.parseObjectLiteral();
    }

    // String - might be arrow expr, require+error pair, or standalone.
    // A STRING followed by LPAREN is a function-call expression — common
    // inside method bodies (`@community/step-foo(arg) -> result`) — and is
    // captured as a raw line.
    if (tok.type === TokenType.STRING) {
      // Look ahead: STRING followed by LPAREN means function-call style;
      // capture the entire logical line as a raw string.
      if (this.peekSignificant(1).type === TokenType.LPAREN) {
        return this.parseRawExpression();
      }
      const strTok = this.advance();
      this.skipTrivia();

      // Arrow expression: "x" → "y"
      if (this.check(TokenType.ARROW)) {
        return this.parseArrow(strTok);
      }

      // Require pattern: "condition" error: "message" (or with IDENT "error" followed by COLON)
      if (this.check(TokenType.IDENT) && this.current().value === 'error' && this.peekSignificant(1).type === TokenType.COLON) {
        this.advance(); // consume 'error'
        this.skipTrivia();
        this.advance(); // consume ':'
        this.skipTrivia();
        const errorMsg = this.check(TokenType.STRING) ? this.advance().value : '';
        // Return as object with condition + error
        return {
          type: "Object",
          fields: [
            { type: "Field", key: "condition", value: { type: "String", value: strTok.value, loc: this.loc(strTok) } as StringNode, loc: this.loc(strTok) },
            { type: "Field", key: "error", value: { type: "String", value: errorMsg, loc: this.loc(strTok) } as StringNode, loc: this.loc(strTok) },
          ],
          loc: this.loc(strTok),
        } as ObjectNode;
      }

      // Standalone string
      return {
        type: "String",
        value: strTok.value,
        loc: this.loc(strTok),
      } as StringNode;
    }

    // Identifier - many possible interpretations
    if (tok.type === TokenType.IDENT) {
      return this.parseArrayIdentItem();
    }

    // `unit` is a declaration keyword only in declaration position. Corpus
    // data may legitimately use the word as a tag (`tags: [testing, unit]`).
    // parseValue already accepts it outside arrays; array parsing must agree.
    if (tok.type === TokenType.UNIT) {
      this.advance();
      return { type: "Ident", value: tok.value, loc: this.loc(tok) } as IdentNode;
    }

    // Number
    if (tok.type === TokenType.NUMBER || tok.type === TokenType.PERCENT) {
      return this.parseValue();
    }

    // Boolean
    if (tok.type === TokenType.BOOLEAN) {
      return this.parseValue();
    }

    // Decorator enum value
    if (tok.type === TokenType.AT_DECORATOR) {
      return this.parseValue();
    }

    this.addError(`Unexpected token ${tok.type} in array`, tok);
    this.advance();
    return { type: "Ident", value: "", loc: this.loc(tok) } as IdentNode;
  }

  /**
   * Parse an array item that starts with an identifier.
   * Handles all the shorthand forms.  Falls back to capturing the entire
   * logical line as a raw string for free-form pseudocode lines (control
   * flow, narrative steps) that don't fit any shorthand.
   */
  private parseArrayIdentItem(): ValueNode {
    const tok = this.current();

    // Pseudocode-line heuristic: if this IDENT is followed *on the same
    // line* by another IDENT or a comparison/numeric operator, treat the
    // whole line as a raw expression.  This covers free-form lines inside
    // method bodies like:
    //   `RANK by impact: critical > serious > moderate > minor`
    //   `if depth == "deep":`
    //   `score = lh-results.categories.X * 100`
    // We deliberately exclude the threshold-shorthand keywords
    // (block / warn / pass) since those have their own specialised parser,
    // and we restrict to same-line lookahead so multi-line use-reference
    // arrays (`Foo\nBar.baz`) keep their shorthand semantics.
    {
      const nextIdx = this.peekSignificantIndex(1);
      const next = nextIdx >= 0 ? this.tokens[nextIdx] : this.eofToken();
      const sameLine = next.line === tok.line;
      const isThresholdLevel =
        next.type === TokenType.IDENT &&
        (next.value === "block" || next.value === "warn" || next.value === "pass");
      const isPseudocodeFollow =
        sameLine &&
        !isThresholdLevel &&
        (next.type === TokenType.IDENT ||
          next.type === TokenType.GT ||
          next.type === TokenType.LT ||
          next.type === TokenType.GTE ||
          next.type === TokenType.LTE ||
          next.type === TokenType.PERCENT ||
          next.type === TokenType.NUMBER ||
          // mid-line `:` not followed by a LBRACE (which would be a step
          // shorthand object) — a pseudocode label like `for each x:`.
          (next.type === TokenType.COLON &&
            this.peekSignificant(2).type !== TokenType.LBRACE));
      if (isPseudocodeFollow) {
        return this.parseRawExpression();
      }
    }

    const identTok = this.advance();
    this.skipTrivia();

    // Link shorthand: NAME -> "target" [( modifiers )]
    if (this.check(TokenType.ARROW)) {
      return this.parseLinkShorthand(identTok);
    }

    // Step shorthand: NAME { ... }
    if (this.check(TokenType.LBRACE)) {
      return this.parseStepBody(identTok);
    }

    // Parameter shorthand: name(type) "description"
    if (this.check(TokenType.LPAREN)) {
      return this.parseParameterShorthand(identTok);
    }

    // Category shorthand: Name "description"
    if (this.check(TokenType.STRING)) {
      const descTok = this.advance();
      this.skipTrivia();

      // Check for trailing fields (like `error: "msg"`)
      // This handles: "description" \n error: "msg"
      // We collect it as part of a step-like structure
      if (this.check(TokenType.IDENT) && this.peekSignificant(1).type === TokenType.COLON) {
        // This looks like a require item with trailing field
        // e.g. "language is recognized" error: "not supported"
        // Back up - return the ident+string as ParameterShorthand
      }

      return {
        type: "ParameterShorthand",
        name: identTok.value,
        paramType: "",
        description: descTok.value,
        loc: this.loc(identTok),
      } as ParameterShorthandNode;
    }

    // Dotted path: A.B.C
    if (this.check(TokenType.DOT)) {
      return this.parseDottedPath(identTok);
    }

    // Alias: X as Y
    if (this.check(TokenType.AS)) {
      this.advance();
      this.skipTrivia();
      const aliasTok = this.expect(TokenType.IDENT, "Expected alias name");
      return {
        type: "Reference",
        path: [identTok.value],
        alias: aliasTok.value,
        loc: this.loc(identTok),
      } as ReferenceNode;
    }

    // Threshold shorthand: metric block: ... warn: ... pass: ...
    if (this.isThresholdStart()) {
      return this.parseThresholdShorthand(identTok);
    }

    // Plain identifier
    return {
      type: "Ident",
      value: identTok.value,
      loc: this.loc(identTok),
    } as IdentNode;
  }

  // ── Step parsing ──────────────────────────────────────────────────────

  /**
   * Parse a step body: `NAME { "description" expect: value error: value ... }`.
   * Called after the step name has been consumed and '{' detected.
   */
  private parseStepBody(nameTok: Token): StepNode {
    this.advance(); // consume '{'
    this.skipTrivia();

    const body: (FieldNode | StringNode)[] = [];

    while (!this.isAtEnd() && !this.check(TokenType.RBRACE)) {
      this.skipTrivia();
      if (this.isAtEnd() || this.check(TokenType.RBRACE)) break;

      const tok = this.current();

      // String description lines
      if (tok.type === TokenType.STRING) {
        const strTok = this.advance();
        this.skipTrivia();

        // Check for arrow: "x" → "y" inside step
        if (this.check(TokenType.ARROW)) {
          const arrow = this.parseArrow(strTok);
          body.push({
            type: "Field",
            key: "__arrow__",
            value: arrow,
            loc: this.loc(strTok),
          } as FieldNode);
        } else {
          body.push({
            type: "String",
            value: strTok.value,
            loc: this.loc(strTok),
          } as StringNode);
        }
        continue;
      }

      // Field: key: value (IDENT or any keyword that can be a field name)
      if (this.isFieldNameToken(tok)) {
        this.skipTrivia();
        const field = this.parseField();
        if (field) body.push(field);
        continue;
      }

      // Unexpected - skip
      this.addError(`Unexpected token in step body: ${tok.type}`, tok);
      this.advance();
    }

    this.expect(TokenType.RBRACE, "Expected '}' to close step body");

    return {
      type: "Step",
      name: nameTok.value,
      body,
      loc: this.loc(nameTok),
    };
  }

  // ── Inheritance operations ────────────────────────────────────────────

  /**
   * Parse override: `override dotpath { fields }`.
   */
  private parseOverride(): OverrideNode {
    const startTok = this.advance(); // consume 'override'
    this.skipTrivia();

    // Parse dotted path
    const path: string[] = [];
    const firstTok = this.expect(TokenType.IDENT, "Expected field name after 'override'");
    path.push(firstTok.value);
    while (this.check(TokenType.DOT)) {
      this.advance();
      const segTok = this.expect(TokenType.IDENT, "Expected identifier after '.'");
      path.push(segTok.value);
    }
    this.skipTrivia();

    // Parse body
    this.expect(TokenType.LBRACE, "Expected '{' after override path");
    this.skipTrivia();
    const body = this.parseStepLikeBody();
    this.skipTrivia();
    this.expect(TokenType.RBRACE, "Expected '}' to close override block");

    return {
      type: "Override",
      path,
      body,
      loc: this.loc(startTok),
    };
  }

  /**
   * Parse body that can contain both strings and fields (like step bodies).
   */
  private parseStepLikeBody(): FieldNode[] {
    const fields: FieldNode[] = [];

    while (!this.isAtEnd() && !this.check(TokenType.RBRACE)) {
      this.skipTrivia();
      if (this.isAtEnd() || this.check(TokenType.RBRACE)) break;

      const tok = this.current();

      // String description lines become pseudo-fields
      if (tok.type === TokenType.STRING) {
        const strTok = this.advance();
        this.skipTrivia();
        if (this.check(TokenType.ARROW)) {
          const arrow = this.parseArrow(strTok);
          fields.push({
            type: "Field",
            key: "__arrow__",
            value: arrow,
            loc: this.loc(strTok),
          });
        } else {
          fields.push({
            type: "Field",
            key: "__description__",
            value: { type: "String", value: strTok.value, loc: this.loc(strTok) } as StringNode,
            loc: this.loc(strTok),
          });
        }
        continue;
      }

      if (this.isFieldNameToken(tok)) {
        const field = this.parseField();
        if (field) fields.push(field);
        continue;
      }

      this.addError(`Unexpected token in block body: ${tok.type}`, tok);
      this.advance();
    }

    return fields;
  }

  /**
   * Parse append: `append target { fields }` or `append target [ items ]`.
   */
  private parseAppend(): AppendNode {
    const startTok = this.advance(); // consume 'append'
    this.skipTrivia();

    const targetTok = this.expect(TokenType.IDENT, "Expected target name after 'append'");
    this.skipTrivia();

    let value: ObjectNode | ArrayNode;

    if (this.check(TokenType.LBRACE)) {
      // Object body
      const obj = this.parseObjectLiteral();
      value = obj;
    } else if (this.check(TokenType.LBRACKET)) {
      // Array body
      const arr = this.parseArrayLiteral();
      value = arr;
    } else {
      this.addError("Expected '{' or '[' after append target", this.current());
      value = { type: "Object", fields: [], loc: this.loc(startTok) };
    }

    return {
      type: "Append",
      target: targetTok.value,
      value,
      loc: this.loc(startTok),
    };
  }

  /**
   * Parse extend: `extend target [ items ]`.
   */
  private parseExtend(): ExtendNode {
    const startTok = this.advance(); // consume 'extend'
    this.skipTrivia();

    const targetTok = this.expect(TokenType.IDENT, "Expected target name after 'extend'");
    this.skipTrivia();

    let value: ArrayNode;

    if (this.check(TokenType.LBRACKET)) {
      value = this.parseArrayLiteral();
    } else {
      this.addError("Expected '[' after extend target", this.current());
      value = { type: "Array", items: [], loc: this.loc(startTok) };
    }

    return {
      type: "Extend",
      target: targetTok.value,
      value,
      loc: this.loc(startTok),
    };
  }

  // ── Utility ───────────────────────────────────────────────────────────

  getErrors(): ParseError[] {
    return this.errors;
  }
}
