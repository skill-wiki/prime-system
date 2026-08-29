/**
 * `DocumentStore` — the §14.1 "incremental document store" capability.
 *
 * The memoisation assertions are the ones that make "incremental" mean something
 * measurable: they count real `parse()` calls rather than trusting a comment.
 */

import { describe, test, expect } from "bun:test";
import { DocumentStore, StaleVersionError, UnknownDocumentError, documentFilename, documentPath } from "../src/document-store";

const URI = "file:///tmp/example.prime";
const SOURCE = `prime Example extends Container {\n  name: "example"\n  version: "1.0.0"\n}\n`;

describe("DocumentStore lifecycle", () => {
  test("opens, reports and closes a document", () => {
    const store = new DocumentStore();
    store.open(URI, SOURCE);
    expect(store.size).toBe(1);
    expect(store.has(URI)).toBe(true);
    expect(store.uris()).toEqual([URI]);
    store.close(URI);
    expect(store.has(URI)).toBe(false);
  });

  test("throws on reading a document that is not open", () => {
    expect(() => new DocumentStore().get(URI)).toThrow(UnknownDocumentError);
  });

  test("throws on closing a document that is not open", () => {
    expect(() => new DocumentStore().close(URI)).toThrow(UnknownDocumentError);
  });

  test("throws on changing a document that is not open", () => {
    expect(() => new DocumentStore().update(URI, [{ text: "x" }], 2)).toThrow(UnknownDocumentError);
  });
});

describe("DocumentStore versions", () => {
  test("applies an incremental edit at the new version", () => {
    const store = new DocumentStore();
    store.open(URI, SOURCE);
    const updated = store.update(URI, [{ range: { start: { line: 1, character: 8 }, end: { line: 1, character: 17 } }, text: `"renamed"` }], 2);
    expect(updated.version).toBe(2);
    expect(store.get(URI).text).toContain(`name: "renamed"`);
  });

  test("rejects a version that is not newer, leaving the buffer intact", () => {
    const store = new DocumentStore();
    store.open(URI, SOURCE, 5);
    expect(() => store.update(URI, [{ text: "clobbered" }], 5)).toThrow(StaleVersionError);
    expect(() => store.update(URI, [{ text: "clobbered" }], 4)).toThrow(StaleVersionError);
    expect(store.get(URI).text).toBe(SOURCE);
  });
});

describe("DocumentStore parse memoisation", () => {
  test("parses once for repeated requests at one version", () => {
    const store = new DocumentStore();
    store.open(URI, SOURCE);
    const first = store.parsed(URI);
    const second = store.parsed(URI);
    expect(store.parses).toBe(1);
    expect(second).toBe(first);
  });

  test("re-parses after an edit and not before", () => {
    const store = new DocumentStore();
    store.open(URI, SOURCE);
    store.parsed(URI);
    store.update(URI, [{ range: { start: { line: 3, character: 1 }, end: { line: 3, character: 1 } }, text: "\n" }], 2);
    expect(store.parses).toBe(1);
    store.parsed(URI);
    store.parsed(URI);
    expect(store.parses).toBe(2);
  });

  test("discards the cache when a document is reopened", () => {
    const store = new DocumentStore();
    store.open(URI, SOURCE);
    store.parsed(URI);
    store.open(URI, `prime Other extends Container {\n  name: "other"\n}\n`);
    const reparsed = store.parsed(URI);
    expect(store.parses).toBe(2);
    expect(reparsed.ast.name).toBe("Other");
  });

  test("surfaces syntax errors instead of throwing", () => {
    const store = new DocumentStore();
    store.open(URI, `prime Broken extends Container {\n  name: "broken"\n`);
    expect(store.parsed(URI).errors.length).toBeGreaterThan(0);
  });

  test("parses a generic unit declaration, which the legacy CLI entry rejects", () => {
    const store = new DocumentStore();
    store.open(URI, `unit Thing : @some-model/container {\n  label: "thing"\n}\n`);
    const parsed = store.parsed(URI);
    expect(parsed.errors).toEqual([]);
    expect(parsed.ast.type).toBe("UnitDeclaration");
  });
});

describe("URI helpers", () => {
  test("reduces a file URI to the basename the parser and compiler report", () => {
    expect(documentFilename("file:///a/b/c.prime")).toBe("c.prime");
    expect(documentFilename("/a/b/c.prime")).toBe("c.prime");
    expect(documentFilename("file:///a/b%20c/d.prime")).toBe("d.prime");
  });

  test("recovers the filesystem path from a file URI", () => {
    expect(documentPath("file:///a/b/c.prime")).toBe("/a/b/c.prime");
    expect(documentPath("/a/b/c.prime")).toBe("/a/b/c.prime");
  });
});
