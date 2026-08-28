import { expect, test } from "bun:test";
import { check, finding, formatReport, report, skipped } from "../src/diagnostics.ts";

test("a check fails only on error findings", () => {
  expect(check("A", "a", []).status).toBe("pass");
  expect(check("A", "a", [finding("W", "w", "warning")]).status).toBe("pass");
  expect(check("A", "a", [finding("E", "e")]).status).toBe("fail");
  expect(check("A", "a", [finding("I", "i", "info")]).status).toBe("pass");
});

test("a skip carries its reason and never counts as a pass", () => {
  const s = skipped("B", "b", "no capability");
  expect(s.status).toBe("skip");
  expect(s.skipReason).toBe("no capability");
  expect(report("suite", "subject", [s]).counts).toEqual({ pass: 0, fail: 0, skip: 1 });
  expect(report("suite", "subject", [s]).status).toBe("skip");
});

test("a report aggregates severities and fails if any check fails", () => {
  const r = report("suite", "subject", [
    check("A", "a", [finding("W", "w", "warning")]),
    check("B", "b", [finding("E", "e"), finding("E2", "e2")]),
    skipped("C", "c", "why"),
  ]);
  expect(r.status).toBe("fail");
  expect(r.counts).toEqual({ pass: 1, fail: 1, skip: 1 });
  expect(r.errorCount).toBe(2);
  expect(r.warningCount).toBe(1);
});

test("formatting is deterministic and shows subject, path and skip reason", () => {
  const r = report("suite", "subject", [
    check("A", "a", [finding("E", "boom", "error", { subject: "type:X", path: "p.yaml" })]),
    skipped("C", "c", "why"),
  ]);
  const text = formatReport(r);
  expect(text).toBe(formatReport(r));
  expect(text).toContain("error/E [type:X @ p.yaml]: boom");
  expect(text).toContain("(skip: why)");
});
