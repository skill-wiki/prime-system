/**
 * §14.1 fourth capability: type/field completion.
 *
 * The lists asserted below are exactly the fixture model's declarations. A
 * built-in name would show up here as an item the fixture never declared.
 */

import { describe, test, expect } from "bun:test";
import { createLanguageServer } from "../src/index";
import { completionContext, prefixAt } from "../src/completion";
import { TextDocument } from "../src/text-document";
import { writeModelFixture } from "./model-fixture";

const model = writeModelFixture();
const URI = "file:///tmp/doc.prime";

function serve(source: string, modelRoot: string = model.root) {
  const server = createLanguageServer({ modelRoot });
  server.openDocument(URI, source);
  return server;
}

/** No `modelRoot` at all — distinct from passing `undefined` into a defaulted parameter. */
function serveWithoutModel(source: string) {
  const server = createLanguageServer();
  server.openDocument(URI, source);
  return server;
}

const doc = (text: string) => new TextDocument(URI, text, 1);

describe("completion context", () => {
  test("outside any declaration is a type position", () => {
    expect(completionContext(doc("cont"), { line: 0, character: 4 })).toEqual({ kind: "type-position" });
  });

  test("inside a kind-form body is a field position naming that kind", () => {
    const source = `container Thing {\n  \n}\n`;
    expect(completionContext(doc(source), { line: 1, character: 2 })).toEqual({ kind: "field-position", typeReference: "container" });
  });

  test("inside a unit-form body is a field position naming the qualified type", () => {
    const source = `unit Thing : @fixture-model/container {\n  \n}\n`;
    expect(completionContext(doc(source), { line: 1, character: 2 })).toEqual({ kind: "field-position", typeReference: "@fixture-model/container" });
  });

  test("after a field colon is a value position", () => {
    const source = `container Thing {\n  label: \n}\n`;
    expect(completionContext(doc(source), { line: 1, character: 9 })).toEqual({ kind: "value-position" });
  });

  test("inside a nested object is unsupported rather than wrong", () => {
    const source = `container Thing {\n  note: {\n    \n  }\n}\n`;
    expect(completionContext(doc(source), { line: 2, character: 4 })).toEqual({ kind: "unsupported", reason: "nested-object" });
  });

  test("inside a legacy prime body is unsupported, since extends names a base", () => {
    const source = `prime Thing extends Container {\n  \n}\n`;
    expect(completionContext(doc(source), { line: 1, character: 2 })).toEqual({ kind: "unsupported", reason: "unknown-declaration" });
  });

  test("a cursor inside an unclosed string is a value position, not a field name", () => {
    // The lexer is total (no `throw` anywhere in it) and hands back one STRING
    // token running to end of input, so the closing quote is checked in raw text.
    const source = `container Thing {\n  label: "unclosed\n`;
    expect(completionContext(doc(source), { line: 1, character: 12 })).toEqual({ kind: "value-position" });
  });

  test("a cursor after a closed string is a field position again", () => {
    const source = `container Thing {\n  label: "done"\n  \n}\n`;
    expect(completionContext(doc(source), { line: 2, character: 2 })).toEqual({ kind: "field-position", typeReference: "container" });
  });

  test("reads the partial word before the cursor as the filter prefix", () => {
    expect(prefixAt(doc("cont"), { line: 0, character: 4 })).toBe("cont");
    expect(prefixAt(doc("container Thing {\n  la"), { line: 1, character: 4 })).toBe("la");
    expect(prefixAt(doc("container Thing {\n  "), { line: 1, character: 2 })).toBe("");
  });
});

describe("type completion", () => {
  test("offers every declared type, with its model, version and field summary", () => {
    const items = serve("").completion(URI, { line: 0, character: 0 }).items;
    expect(items.map(item => item.label)).toEqual(["capsule", "container"]);
    expect(items.every(item => item.kind === "type")).toBe(true);
    const container = items.find(item => item.label === "container")!;
    expect(container.detail).toBe("fixture-model v1.0.0");
    expect(container.documentation).toBe("2 declared field(s), 1 required, additional fields: reject");
  });

  test("filters by the prefix already typed", () => {
    const items = serve("cap").completion(URI, { line: 0, character: 3 }).items;
    expect(items.map(item => item.label)).toEqual(["capsule"]);
  });

  test("offers nothing when no model is configured, rather than built-in names", () => {
    const result = serveWithoutModel("").completion(URI, { line: 0, character: 0 });
    expect(result.items).toEqual([]);
    expect(result.context).toEqual({ kind: "type-position" });
  });
});

describe("field completion", () => {
  test("offers the type's declared fields, marking required ones", () => {
    const items = serve(`container Thing {\n  \n}\n`).completion(URI, { line: 1, character: 2 }).items;
    expect(items.map(item => item.label)).toEqual(["label", "note"]);
    expect(items.find(item => item.label === "label")!.detail).toBe("string (required)");
    expect(items.find(item => item.label === "note")!.detail).toBe("string");
    expect(items.find(item => item.label === "label")!.insertText).toBe("label: ");
    expect(items.find(item => item.label === "label")!.documentation).toBe("The container label");
  });

  test("does not re-offer a field the document already declares", () => {
    const items = serve(`container Thing {\n  label: "a"\n  \n}\n`).completion(URI, { line: 2, character: 2 }).items;
    expect(items.map(item => item.label)).toEqual(["note"]);
  });

  test("filters fields by prefix", () => {
    const items = serve(`container Thing {\n  no\n}\n`).completion(URI, { line: 1, character: 4 }).items;
    expect(items.map(item => item.label)).toEqual(["note"]);
  });

  test("offers nothing for a type the model does not declare", () => {
    const items = serve(`absent Thing {\n  \n}\n`).completion(URI, { line: 1, character: 2 }).items;
    expect(items).toEqual([]);
  });

  test("offers nothing in a value position", () => {
    const items = serve(`container Thing {\n  label: \n}\n`).completion(URI, { line: 1, character: 9 }).items;
    expect(items).toEqual([]);
  });

  test("resolves fields through a qualified unit type reference", () => {
    const items = serve(`unit Thing : @fixture-model/container {\n  \n}\n`).completion(URI, { line: 1, character: 2 }).items;
    expect(items.map(item => item.label)).toEqual(["label", "note"]);
  });
});
