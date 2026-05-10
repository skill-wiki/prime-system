/**
 * Tests for the L3 cross-atom checker (C1–C4).
 */

import { describe, test, expect } from "bun:test";
import { parse } from "../../parser/src/index";
import { checkL3Cross } from "../src/checker-l3-cross";

function parseAll(sources: string[]) {
  return sources.map((s, i) => {
    const { ast, errors } = parse(s, `f${i}.prime`);
    expect(errors).toHaveLength(0);
    return ast;
  });
}

describe("L3 cross-atom", () => {
  test("C1 flags duplicate names across files", () => {
    const asts = parseAll([
      `prime A extends Knowledge {
  name: "same-name"
  version: "1.0.0"
  description: "x"
  tags: ["a", "b"]
  facts: [{ statement: "long enough fact claim", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "same-name"
  version: "1.0.1"
  description: "y"
  tags: ["c", "d"]
  facts: [{ statement: "another long enough claim", confidence: "consensus" }]
}`,
    ]);

    const findings = checkL3Cross(asts);
    const c1 = findings.filter((f) => f.code === "C1");
    expect(c1).toHaveLength(1);
    expect(c1[0].level).toBe("error");
    expect(c1[0].atom).toBe("same-name");
  });

  test("C2 is not emitted when no link references are present", () => {
    const asts = parseAll([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  description: "desc"
  tags: ["a", "b"]
  facts: [{ statement: "long enough fact claim", confidence: "consensus" }]
}`,
    ]);
    const findings = checkL3Cross(asts);
    expect(findings.filter((f) => f.code === "C2")).toHaveLength(0);
  });

  test("C3 flags tag-Jaccard near-duplicate pairs", () => {
    const asts = parseAll([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  tags: ["focus", "modal", "dialog", "keyboard"]
  facts: [{ statement: "long enough fact claim", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "beta"
  version: "1.0.0"
  tags: ["focus", "modal", "dialog", "keyboard"]
  facts: [{ statement: "another long enough claim", confidence: "consensus" }]
}`,
      `prime C extends Knowledge {
  name: "gamma"
  version: "1.0.0"
  tags: ["performance", "cache", "network"]
  facts: [{ statement: "third long enough fact claim", confidence: "consensus" }]
}`,
    ]);

    const findings = checkL3Cross(asts);
    const c3 = findings.filter((f) => f.code === "C3");
    expect(c3.length).toBeGreaterThanOrEqual(1);
    const firstPair = c3[0];
    expect(firstPair.score).toBeGreaterThanOrEqual(0.85);
    expect(new Set([firstPair.atom, firstPair.peer ?? ""]))
      .toEqual(new Set(["alpha", "beta"]));
  });

  test("C4 flags isolated atoms when corpus is linked", () => {
    // When at least one atom has outgoing links, the C4 gate opens and
    // truly isolated atoms get flagged.
    const asts = parseAll([
      `prime Lonely extends Knowledge {
  name: "lonely"
  version: "1.0.0"
  tags: ["a", "b"]
  facts: [{ statement: "isolated long enough fact claim", confidence: "consensus" }]
}`,
    ]);
    const findings = checkL3Cross(asts, { c4MinLinkDensity: 0 });
    const c4 = findings.filter((f) => f.code === "C4");
    expect(c4).toHaveLength(1);
    expect(c4[0].level).toBe("suggestion");
  });

  test("C4 skips atoms tagged as legitimate root nodes", () => {
    const asts = parseAll([
      `prime Hub extends Knowledge {
  name: "hub"
  version: "1.0.0"
  tags: ["x", "y"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`,
      `prime Catalog extends Knowledge {
  name: "scout-catalog-vercel"
  version: "1.0.0"
  tags: ["scout-catalog", "nextjs"]
  facts: [{ statement: "a long enough catalog entry", confidence: "consensus" }]
}`,
      // something to push link density above 5%
      `prime Anchor extends Knowledge {
  name: "anchor-a"
  version: "1.0.0"
  enhances: "hub"
  tags: ["q"]
  facts: [{ statement: "long enough fact", confidence: "consensus" }]
}`,
    ]);
    const findings = checkL3Cross(asts, { c4MinLinkDensity: 0 });
    const c4 = findings.filter((f) => f.code === "C4");
    // "hub" is isolated → flagged; "scout-catalog-vercel" is a root → skipped
    const flaggedAtoms = new Set(c4.map((f) => f.atom));
    expect(flaggedAtoms.has("scout-catalog-vercel")).toBe(false);
  });

  test("rootNodeTags option customizes the skip list", () => {
    const asts = parseAll([
      // x: truly isolated (no in/out edges)
      `prime X extends Knowledge {
  name: "x"
  version: "1.0.0"
  tags: ["my-custom-root"]
  facts: [{ statement: "long enough fact here", confidence: "consensus" }]
}`,
      // y and z link to each other but not to x — pushes link density
      // above the 5% gate so C4 fires.
      `prime Y extends Knowledge {
  name: "y"
  version: "1.0.0"
  enhances: "z"
  tags: ["q"]
  facts: [{ statement: "long enough fact here", confidence: "consensus" }]
}`,
      `prime Z extends Knowledge {
  name: "z"
  version: "1.0.0"
  tags: ["q"]
  facts: [{ statement: "long enough fact here", confidence: "consensus" }]
}`,
    ]);
    // With default rootNodeTags, x has no root-tag, so it gets flagged.
    const defaultFindings = checkL3Cross(asts, { c4MinLinkDensity: 0 });
    expect(defaultFindings.some((f) => f.code === "C4" && f.atom === "x")).toBe(true);
    // With custom list including "my-custom-root", x is skipped.
    const customFindings = checkL3Cross(asts, {
      c4MinLinkDensity: 0,
      rootNodeTags: ["my-custom-root"],
    });
    expect(customFindings.some((f) => f.code === "C4" && f.atom === "x")).toBe(false);
  });

  test("C4 suppresses every atom when corpus has no links at all", () => {
    const asts = parseAll([
      `prime A extends Knowledge {
  name: "a"
  version: "1.0.0"
  tags: ["x", "y"]
  facts: [{ statement: "long enough fact", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "b"
  version: "1.0.0"
  tags: ["z", "w"]
  facts: [{ statement: "another long enough fact", confidence: "consensus" }]
}`,
    ]);
    const findings = checkL3Cross(asts); // default density gate
    expect(findings.filter((f) => f.code === "C4")).toHaveLength(0);
  });

  test("C3 suppresses pairs that share a common specializes parent", () => {
    // Two siblings with the same parent — a legitimate known-sibling
    // relationship, not an accidental near-duplicate.
    const asts = parseAll([
      `prime Parent extends Knowledge {
  name: "parent-concept"
  version: "1.0.0"
  tags: ["focus", "modal", "dialog", "keyboard"]
  facts: [{ statement: "parent concept statement", confidence: "consensus" }]
}`,
      `prime ChildA extends Knowledge {
  name: "child-a"
  version: "1.0.0"
  tags: ["focus", "modal", "dialog", "keyboard"]
  specializes: "parent-concept"
  facts: [{ statement: "one aspect of the parent concept", confidence: "consensus" }]
}`,
      `prime ChildB extends Knowledge {
  name: "child-b"
  version: "1.0.0"
  tags: ["focus", "modal", "dialog", "keyboard"]
  specializes: "parent-concept"
  facts: [{ statement: "another aspect of the parent concept", confidence: "consensus" }]
}`,
    ]);
    const findings = checkL3Cross(asts);
    const c3Between = findings.filter(
      (f) =>
        f.code === "C3" &&
        ((f.atom === "child-a" && f.peer === "child-b") ||
         (f.atom === "child-b" && f.peer === "child-a"))
    );
    expect(c3Between).toHaveLength(0);
  });

  test("C3 still flags similar atoms that do NOT share a parent", () => {
    const asts = parseAll([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  tags: ["focus", "modal", "dialog", "keyboard"]
  facts: [{ statement: "similar statement here", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "beta"
  version: "1.0.0"
  tags: ["focus", "modal", "dialog", "keyboard"]
  facts: [{ statement: "similar statement here", confidence: "consensus" }]
}`,
    ]);
    const findings = checkL3Cross(asts);
    const c3 = findings.filter((f) => f.code === "C3");
    expect(c3.length).toBeGreaterThanOrEqual(1);
  });

  test("jaccardThreshold option filters out weaker pairs", () => {
    const asts = parseAll([
      `prime A extends Knowledge {
  name: "alpha"
  version: "1.0.0"
  tags: ["x", "y", "z"]
  facts: [{ statement: "long enough fact claim", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "beta"
  version: "1.0.0"
  tags: ["x", "y", "w"]
  facts: [{ statement: "another long enough claim", confidence: "consensus" }]
}`,
    ]);
    // x,y overlap, z,w distinct → J = 2/4 = 0.5
    const highThreshold = checkL3Cross(asts, { jaccardThreshold: 0.9 });
    expect(highThreshold.filter((f) => f.code === "C3")).toHaveLength(0);
    const lowThreshold = checkL3Cross(asts, { jaccardThreshold: 0.4 });
    expect(lowThreshold.filter((f) => f.code === "C3").length).toBeGreaterThanOrEqual(1);
  });
});
