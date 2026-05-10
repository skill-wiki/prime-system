/**
 * Tests for CorpusIndex — text + graph search.
 */

import { describe, test, expect } from "bun:test";
import { parse } from "../../parser/src/index";
import { CorpusGraph } from "../src/corpus-graph";
import { CorpusIndex } from "../src/corpus-index";

function buildIndex(sources: string[]) {
  const asts = sources.map((s, i) => {
    const { ast, errors } = parse(s, `f${i}.prime`);
    expect(errors).toHaveLength(0);
    return ast;
  });
  return new CorpusIndex(new CorpusGraph(asts));
}

describe("CorpusIndex", () => {
  test("returns hits matching query tokens", () => {
    const idx = buildIndex([
      `prime A extends Knowledge {
  name: "modal-focus"
  version: "1.0.0"
  description: "When a modal opens, move focus inside the dialog"
  tags: ["modal", "focus", "a11y"]
  facts: [{ statement: "Focus must move programmatically to the dialog container", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "toast-duration"
  version: "1.0.0"
  description: "Non-critical toast notifications dismiss after 5 seconds"
  tags: ["toast", "timing"]
  facts: [{ statement: "Auto-dismiss at 5 seconds unless critical", confidence: "consensus" }]
}`,
    ]);

    const hits = idx.search("modal focus");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe("modal-focus");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].reason).toContain("modal");
  });

  test("name and phrase matches score higher than scattered tokens", () => {
    const idx = buildIndex([
      `prime A extends Knowledge {
  name: "keyboard-shortcuts"
  version: "1.0.0"
  description: "Common keyboard shortcut conventions"
  tags: ["keyboard", "shortcuts"]
  facts: [{ statement: "Use Cmd/Ctrl + Z for undo", confidence: "consensus" }]
}`,
      `prime B extends Knowledge {
  name: "random-atom"
  version: "1.0.0"
  description: "Something about keyboard and something else about shortcuts separately"
  tags: ["unrelated"]
  facts: [{ statement: "Keyboard input handling is complex; shortcuts are hard", confidence: "consensus" }]
}`,
    ]);

    const hits = idx.search("keyboard shortcuts");
    expect(hits[0].name).toBe("keyboard-shortcuts");
  });

  test("enriches hits with requires closure", () => {
    const idx = buildIndex([
      `prime A extends Knowledge { name: "layer-top" version: "1.0.0" requires: "layer-mid" tags: ["layer"] facts: [{ statement: "top of stack", confidence: "consensus" }] }`,
      `prime B extends Knowledge { name: "layer-mid" version: "1.0.0" requires: "layer-bottom" tags: ["layer"] facts: [{ statement: "middle of stack", confidence: "consensus" }] }`,
      `prime C extends Knowledge { name: "layer-bottom" version: "1.0.0" tags: ["layer"] facts: [{ statement: "bottom of stack", confidence: "consensus" }] }`,
    ]);

    const hits = idx.search("layer top");
    expect(hits[0].name).toBe("layer-top");
    expect(hits[0].requires.sort()).toEqual(["layer-bottom", "layer-mid"]);
  });

  test("flags contradicts inside the top-N selection", () => {
    const idx = buildIndex([
      `prime A extends Rule { name: "rule-a" version: "1.0.0" contradicts: "rule-b" tags: ["x"] checks: [{ description: "alpha version check", pass_condition: "x" }] }`,
      `prime B extends Rule { name: "rule-b" version: "1.0.0" tags: ["x"] checks: [{ description: "beta version check", pass_condition: "x" }] }`,
    ]);

    const hits = idx.search("version check");
    const a = hits.find((h) => h.name === "rule-a");
    expect(a).toBeDefined();
    expect(a?.contradictsInSelection).toContain("rule-b");
  });

  test("IDF weighting makes rare tokens dominate common ones", () => {
    // Corpus where "focus" appears in many atoms but "brainstem" appears in one.
    const sources: string[] = [];
    for (let i = 0; i < 10; i++) {
      sources.push(
        `prime P${i} extends Knowledge { name: "p${i}" version: "1.0.0" tags: ["focus"] facts: [{ statement: "about focus things", confidence: "consensus" }] }`
      );
    }
    sources.push(
      `prime Rare extends Knowledge { name: "rare" version: "1.0.0" tags: ["brainstem", "focus"] facts: [{ statement: "brainstem research about focus systems", confidence: "consensus" }] }`
    );
    const idx = buildIndex(sources);
    // Query containing the rare token should put "rare" first — it's the
    // only atom with "brainstem" so that token carries the ranking.
    const hits = idx.search("focus brainstem");
    expect(hits[0].name).toBe("rare");
  });

  test("synonym expansion brings in related atoms via query", () => {
    const idx = buildIndex([
      // Atom has "animation" tag but no "motion" token anywhere
      `prime Anim extends Knowledge {
  name: "anim-guide"
  version: "1.0.0"
  tags: ["animation"]
  facts: [{ statement: "use transform and opacity for kinetic effects", confidence: "consensus" }]
}`,
      `prime Other extends Knowledge {
  name: "other"
  version: "1.0.0"
  tags: ["unrelated"]
  facts: [{ statement: "completely different topic about food", confidence: "consensus" }]
}`,
    ]);
    // Without synonyms, "motion" matches nothing — neither atom contains the token.
    const without = idx.search("motion");
    expect(without.find((h) => h.name === "anim-guide")).toBeUndefined();
    // With a "motion → animation" synonym map, the expansion hits the tag.
    const withSyn = idx.search("motion", { synonyms: { motion: ["animation"] } });
    expect(withSyn[0]?.name).toBe("anim-guide");
  });

  test("metadata boost: priority-1 + severity=block atom outranks peer", () => {
    const idx = buildIndex([
      `prime High extends Rule {
  name: "high-rule"
  version: "1.0.0"
  tags: ["alpha"]
  priority: 1
  severity: "block"
  checks: [{ description: "alpha-related check", pass_condition: "measure" }]
}`,
      `prime Low extends Rule {
  name: "low-rule"
  version: "1.0.0"
  tags: ["alpha"]
  priority: 3
  severity: "warn"
  checks: [{ description: "alpha-related check", pass_condition: "measure" }]
}`,
    ]);
    const hits = idx.search("alpha check");
    expect(hits[0].name).toBe("high-rule");
    expect(hits[1].name).toBe("low-rule");
  });

  test("disableMetadataBoosts flattens priority/severity bias", () => {
    // Same corpus as the metadata-boost test; when boosts are off the ranking
    // should be driven purely by field/IDF/phrase matching.
    const sources = [
      `prime A extends Rule {
  name: "a-rule"
  version: "1.0.0"
  tags: ["x"]
  priority: 1
  checks: [{ description: "x check", pass_condition: "m" }]
}`,
      `prime B extends Rule {
  name: "b-rule"
  version: "1.0.0"
  tags: ["x"]
  priority: 3
  checks: [{ description: "x check", pass_condition: "m" }]
}`,
    ];
    const asts = sources.map((s) => parse(s).ast);
    const graph = new CorpusGraph(asts);
    const idxOff = new CorpusIndex(graph, { disableMetadataBoosts: true });
    const hitsOff = idxOff.search("x check");
    // Both atoms have identical scoring surface; either may be first — but
    // their scores must be equal when boosts are disabled.
    expect(hitsOff[0].score).toBeCloseTo(hitsOff[1].score, 5);
  });

  test("does not crash on query tokens containing regex metachars", () => {
    const idx = buildIndex([
      `prime A extends Knowledge {
  name: "ios-14-feature"
  version: "1.0.0"
  description: "iOS 14 introduced App Clips and widgets"
  tags: ["ios", "mobile"]
  facts: [{ statement: "App Clips are lightweight partial apps", confidence: "consensus" }]
}`,
    ]);
    // Each of these would have crashed `new RegExp(\b${tok}\b)` pre-fix.
    for (const q of ["c++", "x.y", "(abc)", "a|b", "[x]", "*star", "node.js"]) {
      expect(() => idx.search(q)).not.toThrow();
    }
    // Functional regression: ios tokens still match ios-prefixed atoms.
    expect(idx.search("ios").length).toBeGreaterThanOrEqual(1);
  });

  test("empty query returns empty result", () => {
    const idx = buildIndex([
      `prime A extends Knowledge { name: "x" version: "1.0.0" tags: ["a"] facts: [{ statement: "long enough statement here", confidence: "consensus" }] }`,
    ]);
    expect(idx.search("")).toHaveLength(0);
    expect(idx.search("   ")).toHaveLength(0);
  });
});
