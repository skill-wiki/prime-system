/**
 * @module document-store
 * §14.2 `DocumentStore` — open documents, their versions, and their parse results.
 *
 * "Incremental" here is precise about what it is: edits arrive as ranges and are
 * applied without the client resending the file, and the parse result is
 * memoised per version so N diagnostics/completion requests on one keystroke
 * parse once. The parser exposes no subtree-reuse API
 * (`packages/parser/src/index.ts` has a single `parse(source, filename)`), so a
 * changed version is a whole-document re-parse. It is not a reuse parser and
 * this module does not pretend to be one.
 */

import { basename } from "node:path";
import { parse } from "@skill-wiki/parser";
import type { ParseError } from "@skill-wiki/parser";
import type { SyntaxAST } from "@skill-wiki/types";
import { TextDocument, type ContentChange } from "./text-document";

export interface ParsedDocument {
  readonly document: TextDocument;
  readonly ast: SyntaxAST;
  readonly errors: readonly ParseError[];
}

export class UnknownDocumentError extends Error {
  constructor(readonly uri: string) {
    super(`Document is not open: ${uri}`);
  }
}

export class StaleVersionError extends Error {
  constructor(readonly uri: string, readonly current: number, readonly received: number) {
    super(`Version ${received} for ${uri} is not newer than the open version ${current}`);
  }
}

/**
 * Convert a document URI to the filename the parser should report.
 *
 * `compileSource` passes `basename(options.file)` to the parser
 * (`packages/compiler/src/index.ts`, the `parseLegacy(source, basename(...))`
 * call), and `ParseError.message` embeds that filename. Diagnostic parity with
 * the CLI therefore depends on this being a basename too, not the full URI.
 */
export function documentFilename(uri: string): string {
  const withoutScheme = uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
  return basename(withoutScheme);
}

/** The filesystem path of a `file://` URI, or the URI itself when it is already a path. */
export function documentPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

export class DocumentStore {
  private readonly documents = new Map<string, TextDocument>();
  /** Keyed by URI; discarded when the stored version no longer matches. */
  private readonly parseCache = new Map<string, ParsedDocument>();
  private parseCount = 0;

  /** Number of `parse()` calls made. Observable so tests can pin memoisation. */
  get parses(): number {
    return this.parseCount;
  }

  get size(): number {
    return this.documents.size;
  }

  uris(): readonly string[] {
    return [...this.documents.keys()];
  }

  has(uri: string): boolean {
    return this.documents.has(uri);
  }

  open(uri: string, text: string, version = 1): TextDocument {
    const document = new TextDocument(uri, text, version);
    this.documents.set(uri, document);
    this.parseCache.delete(uri);
    return document;
  }

  close(uri: string): void {
    if (!this.documents.delete(uri)) throw new UnknownDocumentError(uri);
    this.parseCache.delete(uri);
  }

  get(uri: string): TextDocument {
    const document = this.documents.get(uri);
    if (!document) throw new UnknownDocumentError(uri);
    return document;
  }

  /**
   * Apply incremental `didChange` edits.
   *
   * A version that is not newer is rejected rather than applied: LSP clients may
   * deliver notifications out of order, and applying a stale edit would corrupt
   * the buffer in a way no later edit can repair.
   */
  update(uri: string, changes: readonly ContentChange[], version: number): TextDocument {
    const current = this.get(uri);
    if (version <= current.version) throw new StaleVersionError(uri, current.version, version);
    const next = current.withChanges(changes, version);
    this.documents.set(uri, next);
    return next;
  }

  /** Parse result for the current version, parsing at most once per version. */
  parsed(uri: string): ParsedDocument {
    const document = this.get(uri);
    const cached = this.parseCache.get(uri);
    if (cached && cached.document.version === document.version && cached.document.text === document.text) return cached;
    this.parseCount += 1;
    const { ast, errors } = parse(document.text, documentFilename(uri));
    const result: ParsedDocument = { document, ast, errors };
    this.parseCache.set(uri, result);
    return result;
  }
}
