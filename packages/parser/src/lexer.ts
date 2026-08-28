/**
 * @module lexer
 * Tokenizer/Lexer for .prime source files.
 *
 * Converts raw .prime source text into a stream of tokens
 * that the parser can consume.
 */

// ─── Token Types ────────────────────────────────────────────────────────────

export enum TokenType {
  // Keywords
  PRIME = "PRIME",
  EXTENDS = "EXTENDS",
  OVERRIDE = "OVERRIDE",
  APPEND = "APPEND",
  EXTEND = "EXTEND",
  AS = "AS",
  UNIT = "UNIT",

  // 28 atom-kind keywords (§4 of PRIME.md)
  // Data / Value layer (8)
  FACT = "FACT",
  TERM = "TERM",
  VALUE = "VALUE",
  CATEGORY = "CATEGORY",
  EXAMPLE = "EXAMPLE",
  COUNTER_EXAMPLE = "COUNTER_EXAMPLE",   // source: "counter-example"
  SOURCE = "SOURCE",
  METRIC = "METRIC",
  // Behaviour / Callable layer (4)
  STEP = "STEP",
  CHECK = "CHECK",
  TRANSFORM = "TRANSFORM",
  TOOL = "TOOL",
  // Composition / Structure layer (6)
  METHOD = "METHOD",
  RULE = "RULE",
  TAXONOMY = "TAXONOMY",
  PATTERN = "PATTERN",
  ANTI_PATTERN = "ANTI_PATTERN",         // source: "anti-pattern"
  TYPE = "TYPE",
  // Style / Parameter layer (5)
  PERSONA = "PERSONA",
  VOICE = "VOICE",
  CONSTRAINT = "CONSTRAINT",
  TEMPLATE = "TEMPLATE",
  PROVOCATION = "PROVOCATION",
  // Meta / Binding layer (5)
  COLLECTION = "COLLECTION",
  SCOPE = "SCOPE",
  TRADEOFF = "TRADEOFF",
  PRINCIPLE = "PRINCIPLE",
  FEEDBACK = "FEEDBACK",

  // Delimiters
  LBRACE = "LBRACE",       // {
  RBRACE = "RBRACE",       // }
  LBRACKET = "LBRACKET",   // [
  RBRACKET = "RBRACKET",   // ]
  LPAREN = "LPAREN",       // (
  RPAREN = "RPAREN",       // )
  COLON = "COLON",         // :
  COMMA = "COMMA",         // ,
  DOT = "DOT",             // .

  // Operators
  ARROW = "ARROW",         // → or ->

  // Comparison operators (for threshold shorthand)
  LT = "LT",              // <
  GT = "GT",               // >
  LTE = "LTE",            // <=
  GTE = "GTE",            // >=

  // Literals
  STRING = "STRING",       // "..."
  NUMBER = "NUMBER",       // 42, 3.14
  BOOLEAN = "BOOLEAN",     // true, false
  PERCENT = "PERCENT",     // 80% (number followed by %)

  // Identifiers & decorators
  IDENT = "IDENT",         // foo, FooBar, foo-bar, foo_bar
  AT_DECORATOR = "AT_DECORATOR", // @sealed, @abstract, @decidable, etc.

  // Structural
  COMMENT = "COMMENT",     // // ... or /* ... */
  NEWLINE = "NEWLINE",
  EOF = "EOF",
}

/**
 * Keywords that are reserved in the .prime language.
 *
 * Includes both the legacy `prime` keyword and all 28 atom-kind keywords.
 * Hyphenated keywords (counter-example, anti-pattern) work because the lexer
 * already reads hyphens as part of identifiers.
 */
const KEYWORDS: Record<string, TokenType> = {
  // Legacy keyword
  prime: TokenType.PRIME,
  unit: TokenType.UNIT,
  // Structural keywords
  extends: TokenType.EXTENDS,
  override: TokenType.OVERRIDE,
  append: TokenType.APPEND,
  extend: TokenType.EXTEND,
  as: TokenType.AS,
  // Boolean literals
  true: TokenType.BOOLEAN,
  false: TokenType.BOOLEAN,
  // 28 atom-kind keywords
  fact: TokenType.FACT,
  term: TokenType.TERM,
  value: TokenType.VALUE,
  category: TokenType.CATEGORY,
  example: TokenType.EXAMPLE,
  "counter-example": TokenType.COUNTER_EXAMPLE,
  source: TokenType.SOURCE,
  metric: TokenType.METRIC,
  step: TokenType.STEP,
  check: TokenType.CHECK,
  transform: TokenType.TRANSFORM,
  tool: TokenType.TOOL,
  method: TokenType.METHOD,
  rule: TokenType.RULE,
  taxonomy: TokenType.TAXONOMY,
  pattern: TokenType.PATTERN,
  "anti-pattern": TokenType.ANTI_PATTERN,
  type: TokenType.TYPE,
  persona: TokenType.PERSONA,
  voice: TokenType.VOICE,
  constraint: TokenType.CONSTRAINT,
  template: TokenType.TEMPLATE,
  provocation: TokenType.PROVOCATION,
  collection: TokenType.COLLECTION,
  scope: TokenType.SCOPE,
  tradeoff: TokenType.TRADEOFF,
  principle: TokenType.PRINCIPLE,
  feedback: TokenType.FEEDBACK,
};

// ─── Token ──────────────────────────────────────────────────────────────────

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
  offset: number;
}

// ─── Lexer ──────────────────────────────────────────────────────────────────

/**
 * Tokenize a .prime source string into a sequence of tokens.
 *
 * The lexer produces tokens for all meaningful syntax elements while
 * skipping whitespace (except newlines) and collecting comments.
 *
 * @param source - The raw .prime source text
 * @param filename - Optional filename for error messages
 * @returns Array of tokens
 */
export function tokenize(source: string, filename?: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 1;
  const len = source.length;

  function makeToken(type: TokenType, value: string, startLine: number, startCol: number, startOffset: number): Token {
    return { type, value, line: startLine, column: startCol, offset: startOffset };
  }

  function peek(): string {
    return pos < len ? source[pos] : "\0";
  }

  function peekAt(offset: number): string {
    const idx = pos + offset;
    return idx < len ? source[idx] : "\0";
  }

  function advance(): string {
    const ch = source[pos];
    pos++;
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return ch;
  }

  function skipWhitespaceExceptNewline(): void {
    while (pos < len) {
      const ch = source[pos];
      if (ch === " " || ch === "\t" || ch === "\r") {
        advance();
      } else {
        break;
      }
    }
  }

  function readString(): Token {
    const startLine = line;
    const startCol = column;
    const startOffset = pos;

    // Triple-quoted string: """ ... """ (multi-line, no escape processing)
    // Used for embedded code blocks and long-form descriptions.
    if (peekAt(1) === '"' && peekAt(2) === '"') {
      advance(); advance(); advance(); // skip opening """
      let value = "";
      while (pos < len) {
        if (source[pos] === '"' && peekAt(1) === '"' && peekAt(2) === '"') {
          advance(); advance(); advance(); // skip closing """
          break;
        }
        value += advance();
      }
      // Trim a single leading newline (for readability of `body: """\n...\n"""`)
      if (value.startsWith("\n")) value = value.slice(1);
      return makeToken(TokenType.STRING, value, startLine, startCol, startOffset);
    }

    advance(); // skip opening "
    let value = "";
    while (pos < len && source[pos] !== '"') {
      if (source[pos] === "\\") {
        advance(); // skip backslash
        const escaped = advance();
        switch (escaped) {
          case "n": value += "\n"; break;
          case "t": value += "\t"; break;
          case "\\": value += "\\"; break;
          case '"': value += '"'; break;
          default: value += "\\" + escaped; break;
        }
      } else {
        value += advance();
      }
    }
    if (pos < len) {
      advance(); // skip closing "
    }
    return makeToken(TokenType.STRING, value, startLine, startCol, startOffset);
  }

  /**
   * Read a YAML-style block scalar started by `|`.
   * Captures all subsequent lines that are indented deeper than the column
   * of the `|` marker.  The common indent is stripped from each line.
   *
   * Pattern:
   *   field: |
   *     line one
   *     line two
   *   nextField: ...
   *
   * The `|` itself is consumed; the resulting STRING token carries the
   * de-indented body.  Token line/column point at the `|`.
   */
  function readBlockScalar(): Token {
    const startLine = line;
    const startCol = column;
    const startOffset = pos;
    // Compute the indent of the line that contains the `|` marker by scanning
    // backward from the current position to the previous newline.
    let parentIndent = 0;
    {
      let i = pos - 1;
      while (i >= 0 && source[i] !== "\n") i--;
      // i points to the newline (or -1).  Whitespace between i+1 and the
      // first non-whitespace char is the line indent.
      let j = i + 1;
      while (j < pos && (source[j] === " " || source[j] === "\t")) {
        parentIndent++;
        j++;
      }
    }
    advance(); // consume '|'

    // Skip rest of current line (any inline content after |, up to newline)
    while (pos < len && source[pos] !== "\n") advance();
    if (pos < len) advance(); // consume the newline (also bumps line/col)

    // Read indented content lines.  A line is part of the block if its
    // first non-whitespace character is at a column STRICTLY GREATER
    // than the column of the `|` marker.
    const lines: string[] = [];
    let blockIndent = -1; // common indent established by first content line

    // Snapshot for "rewind" when we hit a less-indented line
    while (pos < len) {
      const savedPos = pos;
      const savedLine = line;
      const savedColumn = column;

      // Measure indent of this line
      let indent = 0;
      while (pos < len && (source[pos] === " " || source[pos] === "\t")) {
        advance();
        indent++;
      }

      // Blank line: include as empty, continue
      if (pos < len && source[pos] === "\n") {
        advance();
        if (blockIndent !== -1) lines.push("");
        continue;
      }
      if (pos >= len) break;

      // Determine whether this line is still inside the block
      if (blockIndent === -1) {
        // First content line establishes blockIndent.  Must be more indented
        // than the parent (line containing the `|`).
        if (indent <= parentIndent) {
          // Not deeper than parent → block ends before this line
          pos = savedPos;
          line = savedLine;
          column = savedColumn;
          break;
        }
        blockIndent = indent;
      } else if (indent < blockIndent) {
        // Dedent → end of block; rewind so caller can re-tokenize this line
        pos = savedPos;
        line = savedLine;
        column = savedColumn;
        break;
      }

      // Read rest of line content
      let lineContent = "";
      while (pos < len && source[pos] !== "\n") {
        lineContent += advance();
      }
      lines.push(lineContent);
      if (pos < len) advance(); // consume newline
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    return makeToken(TokenType.STRING, lines.join("\n"), startLine, startCol, startOffset);
  }

  function readNumber(): Token {
    const startLine = line;
    const startCol = column;
    const startOffset = pos;
    let value = "";
    while (pos < len && isDigit(source[pos])) {
      value += advance();
    }
    if (pos < len && source[pos] === "." && pos + 1 < len && isDigit(source[pos + 1])) {
      value += advance(); // the '.'
      while (pos < len && isDigit(source[pos])) {
        value += advance();
      }
    }
    // Check for percent suffix
    if (pos < len && source[pos] === "%") {
      advance(); // skip %
      return makeToken(TokenType.PERCENT, value, startLine, startCol, startOffset);
    }
    return makeToken(TokenType.NUMBER, value, startLine, startCol, startOffset);
  }

  function readIdentOrKeyword(): Token {
    const startLine = line;
    const startCol = column;
    const startOffset = pos;
    let value = "";
    // First character: [a-zA-Z_]
    value += advance();
    // Subsequent: [a-zA-Z0-9_-]
    while (pos < len && isIdentContinue(source[pos])) {
      value += advance();
    }
    // Check if it's a keyword
    const kwType = KEYWORDS[value];
    if (kwType !== undefined) {
      return makeToken(kwType, value, startLine, startCol, startOffset);
    }
    return makeToken(TokenType.IDENT, value, startLine, startCol, startOffset);
  }

  function readDecorator(): Token {
    const startLine = line;
    const startCol = column;
    const startOffset = pos;
    let value = "";
    value += advance(); // @
    while (pos < len && isIdentContinue(source[pos])) {
      value += advance();
    }
    // Scoped atom reference: `@scope/atom-id` is emitted as a single STRING
    // token so it round-trips with the existing `"@scope/atom-id"` quoted form
    // and is picked up by the compiler's relation extraction.
    if (pos < len && source[pos] === "/" && pos + 1 < len && isIdentStart(source[pos + 1])) {
      value += advance(); // consume '/'
      while (pos < len && isIdentContinue(source[pos])) {
        value += advance();
      }
      return makeToken(TokenType.STRING, value, startLine, startCol, startOffset);
    }
    return makeToken(TokenType.AT_DECORATOR, value, startLine, startCol, startOffset);
  }

  function readLineComment(): Token {
    const startLine = line;
    const startCol = column;
    const startOffset = pos;
    let value = "";
    advance(); // /
    advance(); // /
    while (pos < len && source[pos] !== "\n") {
      value += advance();
    }
    return makeToken(TokenType.COMMENT, value.trim(), startLine, startCol, startOffset);
  }

  function readBlockComment(): Token {
    const startLine = line;
    const startCol = column;
    const startOffset = pos;
    let value = "";
    advance(); // /
    advance(); // *
    while (pos < len) {
      if (source[pos] === "*" && pos + 1 < len && source[pos + 1] === "/") {
        advance(); // *
        advance(); // /
        break;
      }
      value += advance();
    }
    return makeToken(TokenType.COMMENT, value.trim(), startLine, startCol, startOffset);
  }

  // Main tokenization loop
  while (pos < len) {
    skipWhitespaceExceptNewline();

    if (pos >= len) break;

    const startLine = line;
    const startCol = column;
    const startOffset = pos;
    const ch = source[pos];

    // Newline
    if (ch === "\n") {
      advance();
      tokens.push(makeToken(TokenType.NEWLINE, "\n", startLine, startCol, startOffset));
      continue;
    }

    // Comments
    if (ch === "/" && peekAt(1) === "/") {
      const tok = readLineComment();
      tokens.push(tok);
      continue;
    }
    if (ch === "/" && peekAt(1) === "*") {
      const tok = readBlockComment();
      tokens.push(tok);
      continue;
    }

    // String literals
    if (ch === '"') {
      tokens.push(readString());
      continue;
    }

    // Numbers
    if (isDigit(ch)) {
      tokens.push(readNumber());
      continue;
    }

    // Decorators (@something)
    if (ch === "@" && pos + 1 < len && isIdentStart(source[pos + 1])) {
      tokens.push(readDecorator());
      continue;
    }

    // YAML-style block scalar: `|` followed (optionally) by whitespace + newline.
    // Only treated as a block-scalar marker when it appears in value position,
    // i.e. the previous significant token is a COLON.  Otherwise treat `|`
    // as an unknown char and skip (preserves type-union meaning if ever used
    // bare, though we read those as part of typed strings inside line).
    if (ch === "|") {
      const prev = lastSignificantToken(tokens);
      if (prev && prev.type === TokenType.COLON) {
        tokens.push(readBlockScalar());
        continue;
      }
      // Otherwise treat as a raw pipe used inside a type expression (type
      // union).  Emit a synthetic IDENT containing "|" so type-union token
      // streams remain intact for higher-level handlers.
      advance();
      tokens.push(makeToken(TokenType.IDENT, "|", startLine, startCol, startOffset));
      continue;
    }

    // Identifiers and keywords
    if (isIdentStart(ch)) {
      tokens.push(readIdentOrKeyword());
      continue;
    }

    // Arrow: → (Unicode) or -> (ASCII fallback)
    if (ch === "\u2192") {
      advance();
      tokens.push(makeToken(TokenType.ARROW, "\u2192", startLine, startCol, startOffset));
      continue;
    }
    if (ch === "-" && peekAt(1) === ">") {
      advance();
      advance();
      tokens.push(makeToken(TokenType.ARROW, "->", startLine, startCol, startOffset));
      continue;
    }

    // Comparison operators (for threshold shorthand)
    if (ch === "<" && peekAt(1) === "=") {
      advance(); advance();
      tokens.push(makeToken(TokenType.LTE, "<=", startLine, startCol, startOffset));
      continue;
    }
    if (ch === ">" && peekAt(1) === "=") {
      advance(); advance();
      tokens.push(makeToken(TokenType.GTE, ">=", startLine, startCol, startOffset));
      continue;
    }
    if (ch === "<") {
      advance();
      tokens.push(makeToken(TokenType.LT, "<", startLine, startCol, startOffset));
      continue;
    }
    if (ch === ">") {
      advance();
      tokens.push(makeToken(TokenType.GT, ">", startLine, startCol, startOffset));
      continue;
    }

    // Single-character tokens
    switch (ch) {
      case "{":
        advance();
        tokens.push(makeToken(TokenType.LBRACE, "{", startLine, startCol, startOffset));
        continue;
      case "}":
        advance();
        tokens.push(makeToken(TokenType.RBRACE, "}", startLine, startCol, startOffset));
        continue;
      case "[":
        advance();
        tokens.push(makeToken(TokenType.LBRACKET, "[", startLine, startCol, startOffset));
        continue;
      case "]":
        advance();
        tokens.push(makeToken(TokenType.RBRACKET, "]", startLine, startCol, startOffset));
        continue;
      case "(":
        advance();
        tokens.push(makeToken(TokenType.LPAREN, "(", startLine, startCol, startOffset));
        continue;
      case ")":
        advance();
        tokens.push(makeToken(TokenType.RPAREN, ")", startLine, startCol, startOffset));
        continue;
      case ":":
        advance();
        tokens.push(makeToken(TokenType.COLON, ":", startLine, startCol, startOffset));
        continue;
      case ",":
        advance();
        tokens.push(makeToken(TokenType.COMMA, ",", startLine, startCol, startOffset));
        continue;
      case ".":
        advance();
        tokens.push(makeToken(TokenType.DOT, ".", startLine, startCol, startOffset));
        continue;
      default:
        // Unknown character - skip it
        advance();
        continue;
    }
  }

  // Add EOF token
  tokens.push(makeToken(TokenType.EOF, "", line, column, pos));

  return tokens;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return the last token that is not a NEWLINE/COMMENT, or undefined.
 * Used by the lexer to decide context-sensitive rules
 * (e.g. `|` is a block-scalar marker only after `:`).
 */
function lastSignificantToken(tokens: Token[]): Token | undefined {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type !== TokenType.NEWLINE && t.type !== TokenType.COMMENT) {
      return t;
    }
  }
  return undefined;
}

// ─── Character Classification Helpers ───────────────────────────────────────

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentContinue(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch) || ch === "-";
}
