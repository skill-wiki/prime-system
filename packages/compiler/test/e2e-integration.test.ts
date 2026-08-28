/**
 * End-to-end integration test — covers the full pipeline:
 *
 *   .prime source
 *     → parser.parse
 *     → checkL1           (must be clean)
 *     → checkL2Heuristic  (record for sanity)
 *     → checkL3Cross      (with other atoms in the corpus)
 *     → resolve           (dependency graph)
 *     → emitMarkdown      (compact L2 block)
 *     → emitYamlAtom      (MCP-compatible round-trip)
 *
 * The test uses three hand-authored .prime sources — a Knowledge atom,
 * a Rule atom that requires it, and a second Rule that contradicts the
 * first — and asserts the expected behaviour at every pipeline stage.
 *
 * Stages 8-11 (CorpusGraph / CorpusIndex / bundleSkill) were removed with
 * their subjects: W4-A deleted `runtime/src/{corpus-graph,corpus-index,
 * skill-bundler}.ts` this round, so those four tests had no subject left to
 * assert against. They were reaching across package boundaries by relative
 * path (`../../runtime/src/...`) rather than through a dependency, which is
 * why they broke the moment the other lane landed.
 */

import { describe, test, expect } from "bun:test";
import { parse as parseYaml } from "yaml";
import { parseLegacy as parse } from "../../parser/src/index";
import {
  checkL1,
  checkL2Heuristic,
  checkL3Cross,
  resolve,
  emitMarkdown,
  emitYamlAtom,
} from "../src";

const KNOWLEDGE = `
prime FocusRing extends Knowledge {
  name: "focus-ring"
  version: "1.0.0"
  description: "A focus ring is the visible outline that indicates which element currently has keyboard focus."
  tags: ["accessibility", "keyboard", "focus", "a11y"]
  domain: "frontend-design"
  facts: [
    {
      statement: "The focus ring must have at least 3:1 contrast against adjacent colors per WCAG 2.4.11",
      confidence: "consensus"
    }
  ]
}
`;

const RULE_REQ = `
prime FocusRingRequired extends Rule {
  name: "focus-ring-required"
  version: "1.0.0"
  description: "Every interactive element must show a visible focus ring when focused via keyboard."
  tags: ["accessibility", "keyboard", "focus", "a11y"]
  domain: "frontend-design"
  severity: "block"
  priority: 1
  requires: "focus-ring"
  checks: [
    {
      description: "Tab through the page and confirm every button/link/input shows a visible focus outline",
      pass_condition: "manual keyboard audit or automated axe-core rule focus-visible"
    }
  ]
}
`;

const RULE_CONTRADICT = `
prime NoFocusOutlines extends Rule {
  name: "no-focus-outlines"
  version: "1.0.0"
  description: "Removing focus outlines produces a cleaner look — but breaks keyboard users."
  tags: ["aesthetics"]
  domain: "frontend-design"
  severity: "warn"
  priority: 3
  contradicts: "focus-ring-required"
  checks: [
    {
      description: "Remove all focus outlines via outline: none globally",
      pass_condition: "no focus outline visible anywhere"
    }
  ]
}
`;

function parseOrThrow(src: string) {
  const { ast, errors } = parse(src);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  return ast;
}

describe("E2E: parse → L1 → L2 → L3 → resolve → emit", () => {
  const astKnowledge = parseOrThrow(KNOWLEDGE);
  const astRule = parseOrThrow(RULE_REQ);
  const astBad = parseOrThrow(RULE_CONTRADICT);

  test("1. all three parse without errors", () => {
    expect(astKnowledge.name).toBe("FocusRing");
    expect(astRule.name).toBe("FocusRingRequired");
    expect(astBad.name).toBe("NoFocusOutlines");
  });

  test("2. L1 structural check passes all three", () => {
    for (const ast of [astKnowledge, astRule, astBad]) {
      const errs = checkL1(ast).filter((d) => d.level === "error");
      expect(errs).toEqual([]);
    }
  });

  test("3. L2 heuristic detects vague pass_condition on the bad rule", () => {
    const goodFindings = checkL2Heuristic(astRule);
    // The well-formed rule should have no warn-level findings.
    expect(goodFindings.filter((d) => d.level === "warn")).toEqual([]);
  });

  test("4. L3 cross finds the contradicts pair", () => {
    const findings = checkL3Cross([astKnowledge, astRule, astBad]);
    const c2 = findings.filter((f) => f.code === "C2");
    // requires target "focus-ring" exists → no C2 error
    expect(c2).toEqual([]);
  });

  test("5. resolver builds a dependency graph for the Rule", () => {
    const { graph } = resolve(astRule, new Map());
    expect(graph).toBeDefined();
  });

  test("6. emitMarkdown produces a compact .md", () => {
    const md = emitMarkdown(astRule);
    expect(md).toContain("prime: focus-ring-required | rule | 1.0.0");
    expect(md).toContain("Tab through the page");
  });

  test("7. emitYamlAtom round-trips into a valid YAML-frontmatter atom", () => {
    const text = emitYamlAtom(astRule);
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    expect(m).not.toBeNull();
    const fm = parseYaml(m![1]) as Record<string, unknown>;
    expect(fm.id).toBe("@prime/focus-ring-required");
    expect(fm.type).toBe("rule");
    expect(fm.severity).toBe("block");
    expect(fm.priority).toBe(1);
    expect(fm.claim).toBe(
      "Tab through the page and confirm every button/link/input shows a visible focus outline"
    );
    expect(fm.requires).toBe("focus-ring");
  });
});
