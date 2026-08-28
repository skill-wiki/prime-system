/**
 * Redaction (plan §12.3). The label vocabulary is supplied by the test, not by
 * the module — that is the point: the engine holds no list of sensitive fields.
 */

import { describe, expect, test } from "bun:test";
import { REDACTION_MARKER, redactText, redactUnitFields, type RedactionPolicy } from "../src/redact.ts";
import { obj, str, unit } from "./fixtures.ts";

const policy: RedactionPolicy = {
  rules: [
    { label: "lbl-restricted", fields: ["fSecret", "nested.fInner"] },
    { label: "lbl-sealed", fields: ["*"], replacement: "[sealed]" },
  ],
};

const carrier = unit({
  policyLabels: ["lbl-restricted"],
  fields: {
    fPublic: str("visible-value"),
    fSecret: str("SUPER-TOKEN-123"),
    nested: obj({ fInner: str("INNER-TOKEN-456"), fOuter: str("also-visible") }),
  },
});

describe("redactUnitFields", () => {
  test("a unit holding no matching label is untouched", () => {
    const plain = unit({ policyLabels: [], fields: { fSecret: str("SUPER-TOKEN-123") } });
    const outcome = redactUnitFields(plain, policy);
    expect(outcome.redactedPaths).toEqual([]);
    expect(outcome.appliedLabels).toEqual([]);
    expect(outcome.value).toBe(plain.fields);
  });

  test("removes the labelled field and leaves the rest", () => {
    const outcome = redactUnitFields(carrier, policy);
    const value = outcome.value["fSecret"];
    expect(value?.kind === "string" && value.value).toBe(REDACTION_MARKER);
    const kept = outcome.value["fPublic"];
    expect(kept?.kind === "string" && kept.value).toBe("visible-value");
  });

  test("reaches a nested field path", () => {
    const outcome = redactUnitFields(carrier, policy);
    const nested = outcome.value["nested"];
    expect(nested?.kind).toBe("object");
    if (nested?.kind === "object") {
      const inner = nested.fields["fInner"];
      expect(inner?.kind === "string" && inner.value).toBe(REDACTION_MARKER);
      const outer = nested.fields["fOuter"];
      expect(outer?.kind === "string" && outer.value).toBe("also-visible");
    }
  });

  test("reports the paths and labels it applied, as audit evidence", () => {
    const outcome = redactUnitFields(carrier, policy);
    expect(outcome.redactedPaths).toEqual(["fSecret", "nested.fInner"]);
    expect(outcome.appliedLabels).toEqual(["lbl-restricted"]);
  });

  test("a wildcard rule redacts the whole body with its own marker", () => {
    const sealed = unit({ policyLabels: ["lbl-sealed"], fields: { fA: str("a"), fB: str("b") } });
    const outcome = redactUnitFields(sealed, policy);
    expect(outcome.redactedPaths).toEqual(["fA", "fB"]);
    for (const value of Object.values(outcome.value)) {
      expect(value.kind === "string" && value.value).toBe("[sealed]");
    }
  });

  test("redacting a parent also removes its children", () => {
    const parentRule: RedactionPolicy = { rules: [{ label: "lbl-x", fields: ["nested"] }] };
    const target = unit({
      policyLabels: ["lbl-x"],
      fields: { nested: obj({ fInner: str("INNER-TOKEN-456") }) },
    });
    const outcome = redactUnitFields(target, parentRule);
    const nested = outcome.value["nested"];
    // The whole subtree collapses to the marker, so no child can survive.
    expect(nested?.kind).toBe("string");
    expect(nested?.kind === "string" && nested.value).toBe(REDACTION_MARKER);
  });
});

describe("redactText", () => {
  const rendered = [
    "fPublic: visible-value",
    "fSecret: SUPER-TOKEN-123",
    "nested.fInner: INNER-TOKEN-456",
    "trailing mention of SUPER-TOKEN-123 again",
  ].join("\n");

  test("scrubs every occurrence of a redacted literal from the rendered body", () => {
    const outcome = redactText(rendered, carrier, policy);
    expect(outcome.value).not.toContain("SUPER-TOKEN-123");
    expect(outcome.value).not.toContain("INNER-TOKEN-456");
    expect(outcome.value.split(REDACTION_MARKER).length - 1).toBe(3);
  });

  test("leaves unredacted content intact", () => {
    const outcome = redactText(rendered, carrier, policy);
    expect(outcome.value).toContain("visible-value");
  });

  test("a unit with no matching label leaves the text byte-identical", () => {
    const plain = unit({ policyLabels: [], fields: { fSecret: str("SUPER-TOKEN-123") } });
    expect(redactText(rendered, plain, policy).value).toBe(rendered);
  });

  test("scrubs literals nested inside arrays and objects", () => {
    const target = unit({
      policyLabels: ["lbl-x"],
      fields: {
        bag: {
          kind: "array",
          items: [str("ARR-TOKEN-1"), obj({ deep: str("ARR-TOKEN-2") })],
          source: { loc: { line: 1, column: 1, offset: 0 } },
        },
      },
    });
    const arrayPolicy: RedactionPolicy = { rules: [{ label: "lbl-x", fields: ["bag"] }] };
    const outcome = redactText("has ARR-TOKEN-1 and ARR-TOKEN-2", target, arrayPolicy);
    expect(outcome.value).not.toContain("ARR-TOKEN-1");
    expect(outcome.value).not.toContain("ARR-TOKEN-2");
  });

  test("reports the same paths as the field pass, so the two cannot drift", () => {
    expect(redactText(rendered, carrier, policy).redactedPaths).toEqual(
      redactUnitFields(carrier, policy).redactedPaths,
    );
  });
});
