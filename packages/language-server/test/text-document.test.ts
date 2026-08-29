/**
 * `TextDocument` position arithmetic and incremental edit application.
 *
 * The conversions here are the reason diagnostics can line up with the CLI's
 * 1-based lines, so they are tested on their own rather than only through the
 * diagnostic paths.
 */

import { describe, test, expect } from "bun:test";
import { PositionError, TextDocument } from "../src/text-document";

const doc = (text: string) => new TextDocument("file:///t.prime", text, 1);

describe("TextDocument positions", () => {
  test("indexes lines and reports their text without terminators", () => {
    const document = doc("one\ntwo\nthree");
    expect(document.lineCount).toBe(3);
    expect(document.lineText(0)).toBe("one");
    expect(document.lineText(2)).toBe("three");
  });

  test("handles CRLF terminators", () => {
    const document = doc("one\r\ntwo\r\n");
    expect(document.lineCount).toBe(3);
    expect(document.lineText(0)).toBe("one");
    expect(document.lineText(1)).toBe("two");
  });

  test("round-trips offset and position", () => {
    const document = doc("abc\ndefg\nhi");
    for (let offset = 0; offset <= document.text.length; offset += 1) {
      expect(document.offsetAt(document.positionAt(offset))).toBe(offset);
    }
  });

  test("clamps a character past the end of its line", () => {
    const document = doc("ab\ncd");
    expect(document.offsetAt({ line: 0, character: 99 })).toBe(2);
  });

  test("clamps a line past the end of the document to the document end", () => {
    const document = doc("ab\ncd");
    expect(document.offsetAt({ line: 42, character: 0 })).toBe(5);
  });

  test("rejects a negative line", () => {
    expect(() => doc("ab").offsetAt({ line: -1, character: 0 })).toThrow(PositionError);
  });

  test("rejects an out-of-range line for lineText", () => {
    expect(() => doc("ab").lineText(7)).toThrow(PositionError);
  });

  test("maps a 1-based source line to the range covering it", () => {
    const document = doc("abc\ndefg");
    expect(document.rangeOfSourceLine(2)).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 4 } });
  });

  test("maps the compiler's line 0 (no location) to the document start", () => {
    expect(doc("abc").rangeOfSourceLine(0)).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  });
});

describe("TextDocument incremental edits", () => {
  test("applies a range edit and bumps the version", () => {
    const next = doc("hello world").withChanges([{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, text: "there" }], 2);
    expect(next.text).toBe("hello there");
    expect(next.version).toBe(2);
  });

  test("applies several edits in order, later offsets seeing earlier text", () => {
    const next = doc("aaa\nbbb").withChanges(
      [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: "x" },
        { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: "y" },
      ],
      2
    );
    expect(next.text).toBe("xy\nbbb");
  });

  test("treats a change without a range as full replacement", () => {
    expect(doc("old").withChanges([{ text: "brand new" }], 3).text).toBe("brand new");
  });

  test("re-indexes lines after an edit that adds one", () => {
    const next = doc("ab").withChanges([{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: "\n" }], 2);
    expect(next.lineCount).toBe(2);
    expect(next.lineText(1)).toBe("b");
  });

  test("leaves the source document untouched", () => {
    const original = doc("keep me");
    original.withChanges([{ text: "gone" }], 2);
    expect(original.text).toBe("keep me");
    expect(original.version).toBe(1);
  });

  test("rejects an inverted range", () => {
    expect(() =>
      doc("abcdef").withChanges([{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 1 } }, text: "" }], 2)
    ).toThrow(PositionError);
  });
});
