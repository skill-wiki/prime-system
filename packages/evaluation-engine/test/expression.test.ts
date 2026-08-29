import { describe, expect, test } from "bun:test";
import { ExpressionError, evaluateExpression } from "../src/index.ts";

const ok = (source: string, scope: Record<string, unknown> = {}) => evaluateExpression(source, scope);

describe("deterministic expressions", () => {
  test("comparisons, booleans and grouping", () => {
    expect(ok("true")).toBe(true);
    expect(ok("!true")).toBe(false);
    expect(ok("1 < 2")).toBe(true);
    expect(ok("2 <= 2 && 3 > 4")).toBe(false);
    expect(ok("2 <= 2 || 3 > 4")).toBe(true);
    expect(ok("!(1 == 2)")).toBe(true);
    expect(ok("'a' < 'b'")).toBe(true);
    expect(ok('"a" == "a"')).toBe(true);
    expect(ok("(1 != 2) === true")).toBe(true);
    expect(ok("null == null")).toBe(true);
  });

  test("comparisons do not chain: a second comparison operator is a syntax error rather than a silent regrouping", () => {
    expect(() => ok("1 < 2 < 3")).toThrow(ExpressionError);
    expect(() => ok("1 != 2 === true")).toThrow(ExpressionError);
  });

  test("paths, indices and length — §5.4's own example expression", () => {
    expect(ok("subject.rules.length > 0", { subject: { rules: [1, 2] } })).toBe(true);
    expect(ok("subject.rules.length > 0", { subject: { rules: [] } })).toBe(false);
    expect(ok("subject.a.b == 'x'", { subject: { a: { b: "x" } } })).toBe(true);
    expect(ok("subject.items[1] == 'b'", { subject: { items: ["a", "b"] } })).toBe(true);
    expect(ok("subject.name.length == 3", { subject: { name: "abc" } })).toBe(true);
    expect(ok("'b' in subject.items", { subject: { items: ["a", "b"] } })).toBe(true);
    expect(ok("'z' in subject.items", { subject: { items: ["a", "b"] } })).toBe(false);
    expect(ok("'ell' in subject.name", { subject: { name: "hello" } })).toBe(true);
    expect(ok("subject.missing == null", { subject: {} })).toBe(false);
  });

  test("there is no call syntax at all, so no expression can reach a host function", () => {
    expect(() => ok("subject.f()", { subject: { f: () => true } })).toThrow(ExpressionError);
    expect(() => ok("length(subject)", { subject: [] })).toThrow(ExpressionError);
  });

  test("prototype members are unreachable: property reads are own-property only", () => {
    expect(() => ok("subject.constructor.name == 'Object'", { subject: {} })).toThrow(ExpressionError);
    expect(() => ok("subject.__proto__.x == 1", { subject: {} })).toThrow(ExpressionError);
  });

  test("length is answered by the evaluator, so data cannot shadow it and objects do not have one", () => {
    expect(() => ok("subject.length == 5", { subject: { length: 5 } })).toThrow(ExpressionError);
    expect(ok("subject.length == 5", { subject: [1, 2, 3, 4, 5] })).toBe(true);
  });

  test("nothing outside the supplied scope is nameable", () => {
    expect(() => ok("globalThis == null")).toThrow(ExpressionError);
    expect(() => ok("process == null")).toThrow(ExpressionError);
    expect(() => ok("input.x == 1", { subject: {} })).toThrow(ExpressionError);
  });

  test("a non-boolean result is refused rather than coerced, because a coerced verdict is one nobody wrote", () => {
    expect(() => ok("subject.n", { subject: { n: 1 } })).toThrow(ExpressionError);
    expect(() => ok("subject.s", { subject: { s: "" } })).toThrow(ExpressionError);
    expect(() => ok("subject.items", { subject: { items: [] } })).toThrow(ExpressionError);
  });

  test("ordering across mixed types is refused, not silently ordered", () => {
    expect(() => ok("1 < 'a'")).toThrow(ExpressionError);
    expect(() => ok("subject.a < subject.b", { subject: { a: 1, b: null } })).toThrow(ExpressionError);
  });

  test("malformed sources are refused with a reason", () => {
    for (const source of ["", "   ", "1 <", "(1 == 1", "1 == 1)", "'unterminated", "1 @ 2", "subject.", "subject[a]", "subject[-1]", "1 == 1 1"]) {
      expect(() => ok(source, { subject: {} })).toThrow(ExpressionError);
    }
  });

  test("reading through a missing value reports where it stopped instead of returning undefined", () => {
    expect(() => ok("subject.a.b == 1", { subject: {} })).toThrow(/Cannot read b of undefined/);
    expect(() => ok("subject.a[0] == 1", { subject: { a: {} } })).toThrow(/Index access requires an array/);
  });

  test("the same expression over the same value answers the same every time", () => {
    const scope = { subject: { items: ["a"], n: 2 } };
    const answers = new Set(Array.from({ length: 5 }, () => ok("subject.items.length == 1 && subject.n > 1", scope)));
    expect([...answers]).toEqual([true]);
  });
});
