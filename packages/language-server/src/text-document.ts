/**
 * @module text-document
 * An immutable `.prime` text document with LSP-style position arithmetic.
 *
 * Positions are 0-based line/character pairs because that is what the LSP wire
 * protocol uses, while every AST `SourceLocation` and every compiler
 * `Diagnostic` in this repo is 1-based. Keeping the two conventions in one
 * place is the point of this module: a conversion done ad hoc at each call site
 * is where off-by-one diagnostics come from, and the diagnostic set has to match
 * `compileSource` exactly (plan §16 Phase 5).
 */

/** 0-based, LSP convention. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/**
 * One edit from a `textDocument/didChange` notification.
 *
 * `range` absent means "replace the whole document" — the LSP full-sync form.
 */
export interface ContentChange {
  readonly range?: Range;
  readonly text: string;
}

export class PositionError extends Error {}

/**
 * A document version, addressed by URI.
 *
 * Values are immutable: an edit produces a new `TextDocument`. The parse cache in
 * `DocumentStore` keys on the version, so a mutated-in-place document would let a
 * stale AST answer for new text.
 */
export class TextDocument {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
  /** Offset of the first character of each line. Computed once per version. */
  private readonly lineStarts: readonly number[];

  constructor(uri: string, text: string, version: number) {
    this.uri = uri;
    this.text = text;
    this.version = version;
    this.lineStarts = computeLineStarts(text);
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** The text of one 0-based line, without its terminator. */
  lineText(line: number): string {
    if (line < 0 || line >= this.lineStarts.length) throw new PositionError(`Line ${line} is out of range (0..${this.lineStarts.length - 1})`);
    const start = this.lineStarts[line]!;
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1]! : this.text.length;
    return this.text.slice(start, end).replace(/\r?\n$/, "");
  }

  offsetAt(position: Position): number {
    if (position.line < 0) throw new PositionError(`Negative line ${position.line}`);
    if (position.line >= this.lineStarts.length) return this.text.length;
    const start = this.lineStarts[position.line]!;
    const lineLength = this.lineText(position.line).length;
    return start + Math.max(0, Math.min(position.character, lineLength));
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    // Binary search rather than a scan: `positionAt` is called once per
    // diagnostic and per completion request on documents that can be long.
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.lineStarts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: clamped - this.lineStarts[low]! };
  }

  /** Apply `didChange` edits in order, producing the next version. */
  withChanges(changes: readonly ContentChange[], version: number): TextDocument {
    let current: TextDocument = this;
    for (const change of changes) {
      if (change.range === undefined) {
        current = new TextDocument(this.uri, change.text, version);
        continue;
      }
      const start = current.offsetAt(change.range.start);
      const end = current.offsetAt(change.range.end);
      if (end < start) throw new PositionError("Change range end precedes its start");
      current = new TextDocument(this.uri, `${current.text.slice(0, start)}${change.text}${current.text.slice(end)}`, version);
    }
    return current.version === version ? current : new TextDocument(this.uri, current.text, version);
  }

  /**
   * The range covering a 1-based source line, as reported by the parser and the
   * compiler diagnostics. Line 0 (used by the compiler when it has no location)
   * maps to the document start so a client always gets a valid range.
   */
  rangeOfSourceLine(line1Based: number): Range {
    if (line1Based <= 0) return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const line = Math.min(line1Based - 1, this.lineStarts.length - 1);
    return { start: { line, character: 0 }, end: { line, character: this.lineText(line).length } };
  }
}

function computeLineStarts(text: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 /* \n */) starts.push(index + 1);
  }
  return starts;
}
