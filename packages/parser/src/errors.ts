/**
 * @module errors
 * Parse error types for the Prime parser.
 */

/**
 * A parse error with source location and optional suggestion for fixing.
 */
export class ParseError extends Error {
  /** Line number (1-based) where the error occurred */
  readonly line: number;
  /** Column number (1-based) where the error occurred */
  readonly column: number;
  /** Optional suggestion for how to fix the error */
  readonly suggestion?: string;
  /** Source filename, if available */
  readonly filename?: string;

  constructor(options: {
    message: string;
    line: number;
    column: number;
    suggestion?: string;
    filename?: string;
  }) {
    const loc = options.filename
      ? `${options.filename}:${options.line}:${options.column}`
      : `${options.line}:${options.column}`;
    super(`${loc}: ${options.message}`);
    this.name = "ParseError";
    this.line = options.line;
    this.column = options.column;
    this.suggestion = options.suggestion;
    this.filename = options.filename;
  }

  /**
   * Format the error for display.
   */
  format(): string {
    let msg = this.message;
    if (this.suggestion) {
      msg += `\n  Suggestion: ${this.suggestion}`;
    }
    return msg;
  }
}
