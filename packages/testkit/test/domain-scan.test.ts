import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closedSetCheck, domainScanCheck, loadVocabulary, mergeVocabularies, scanDomainSemantics,
  type DomainScanReport, type Vocabulary,
} from "../src/domain-scan.ts";
import { removeTree } from "./helpers.ts";

/**
 * W3-2: the previous classifier was line-local, and every one of its three blind
 * spots produced a false `code` hit that a lane would have chased as a real §3.1
 * violation. These tests pin the shapes, not the counts.
 */

function scanSource(source: string, vocabulary: Vocabulary, fileName = "probe.ts"): DomainScanReport {
  const root = mkdtempSync(join(tmpdir(), "prime-scan-"));
  try {
    writeFileSync(join(root, fileName), source, "utf8");
    return scanDomainSemantics({ roots: [root], vocabulary, reportRoot: root });
  } finally { removeTree(root); }
}

function vocab(terms: readonly string[], exemptions: Vocabulary["exemptions"] = [], modelRoles: ReadonlyMap<string, "relation" | "type"> = new Map()): Vocabulary {
  return { name: "probe", terms, ambiguous: new Set<string>(), exemptions, modelRoles };
}

function relationVocab(terms: readonly string[], ambiguous: readonly string[] = []): Vocabulary {
  return {
    name: "probe-model", terms, ambiguous: new Set(ambiguous), exemptions: [],
    modelRoles: new Map(terms.map(t => [t.toLowerCase(), "relation" as const])),
  };
}

function contextsOf(scan: DomainScanReport, term: string): readonly string[] {
  return scan.hits.filter(h => h.term === term).map(h => h.context);
}

test("a trailing // comment is a comment, not code", () => {
  const scan = scanSource('const tail = id.slice(1); // persona-brutalist\n', vocab(["persona"]));
  expect(contextsOf(scan, "persona")).toEqual(["comment"]);
});

test("a block comment spanning lines stays a comment on every line", () => {
  const scan = scanSource('/*\n  persona lives here\n*/\nconst x = 1;\n', vocab(["persona"]));
  expect(contextsOf(scan, "persona")).toEqual(["comment"]);
});

test("the body of a multi-line template literal is a string, not code", () => {
  const scan = scanSource('const prompt = `line one\nAnalyze this persona AST\n`;\n', vocab(["persona"]));
  expect(contextsOf(scan, "persona")).toEqual(["string"]);
});

test("an apostrophe inside a comment does not open a string on later lines", () => {
  // The old classifier's quote pairing was line-local, so this was harmless
  // there; a stateful one must not let `compiler's` swallow the next line.
  const scan = scanSource("// the compiler's job\nconst persona = 1;\n", vocab(["persona"]));
  expect(contextsOf(scan, "persona")).toEqual(["code"]);
});

test("a ${} interpolation inside a template literal is code again", () => {
  const scan = scanSource('const s = `<c persona="${persona}">`;\n', vocab(["persona"]));
  // The attribute name is string content; the interpolated identifier is code.
  expect(contextsOf(scan, "persona")).toEqual(["string", "code"]);
});

test("a single-quoted literal is a string", () => {
  const scan = scanSource("const axis = 'persona';\n", vocab(["persona"]));
  expect(contextsOf(scan, "persona")).toEqual(["string"]);
});

const DENSITY_EXEMPTION = [{
  name: "generic-metric",
  term: "density",
  reason: "cluster ratio, not the frontend axis",
  paths: ["metrics.ts"],
  linePattern: "\\batoms\\b",
}] as const;

test("an exemption clears a code hit only when path and line shape both match", () => {
  const exempt = scanSource("const density = max / atoms.length;\n", vocab(["density"], DENSITY_EXEMPTION), "metrics.ts");
  expect(exempt.hits.map(h => h.exemption)).toEqual(["generic-metric"]);
  expect(exempt.distinctiveByPackage).toEqual({});
  expect(exempt.exemptedByName).toEqual({ "generic-metric": 1 });

  // Same line, wrong file: still gates.
  const wrongPath = scanSource("const density = max / atoms.length;\n", vocab(["density"], DENSITY_EXEMPTION), "axes.ts");
  expect(wrongPath.hits[0]?.exemption).toBeUndefined();

  // Right file, but the code drifted away from the justified shape: fail closed.
  const drifted = scanSource("const density = weights.density;\n", vocab(["density"], DENSITY_EXEMPTION), "metrics.ts");
  expect(drifted.hits.every(h => h.exemption === undefined)).toBe(true);
  expect(Object.values(drifted.distinctiveByPackage).reduce((a, b) => a + b, 0)).toBe(2);
});

test("an exemption never clears a comment or string hit", () => {
  const scan = scanSource("// density over atoms\n", vocab(["density"], DENSITY_EXEMPTION), "metrics.ts");
  expect(scan.hits[0]?.context).toBe("comment");
  expect(scan.hits[0]?.exemption).toBeUndefined();
  expect(scan.staleExemptions).toEqual(["generic-metric"]);
});

test("a shape-only exemption needs no path anchor", () => {
  const http = [{ name: "http-verb", term: "method", reason: "HTTP verb", paths: [], linePattern: "method:\\s*\"POST\"" }];
  const scan = scanSource('const init = { method: "POST" };\n', vocab(["method"], http));
  expect(scan.hits.map(h => h.exemption)).toEqual(["http-verb"]);
});

test("an exemption that matches nothing is reported stale, so a rotted anchor cannot pose as coverage", () => {
  const scan = scanSource("const x = 1;\n", vocab(["density"], DENSITY_EXEMPTION), "metrics.ts");
  expect(scan.staleExemptions).toEqual(["generic-metric"]);
  const stale = domainScanCheck(scan).findings.filter(f => f.code === "DOMAIN_TERM_EXEMPTION_STALE");
  expect(stale).toHaveLength(1);
  expect(stale[0]?.severity).toBe("warning");
});

test("§17.5 — a fired exemption is recorded as an info finding, not silently dropped", () => {
  const scan = scanSource("const density = max / atoms.length;\n", vocab(["density"], DENSITY_EXEMPTION), "metrics.ts");
  const outcome = domainScanCheck(scan);
  expect(outcome.status).toBe("pass");
  const info = outcome.findings.filter(f => f.code === "DOMAIN_TERM_EXEMPTED");
  expect(info).toHaveLength(1);
  expect(info[0]?.subject).toBe("exemption:generic-metric");
  expect(info[0]?.severity).toBe("info");
});

test("exemptions are data: the vocabulary file parses them and rejects unknown keys", () => {
  const root = mkdtempSync(join(tmpdir(), "prime-vocab-"));
  try {
    const good = join(root, "good.yaml");
    writeFileSync(good, [
      "kind: domain-vocabulary", "name: probe", "terms: [density]",
      "exemptions:",
      "  - name: generic-metric",
      "    term: density",
      "    reason: cluster ratio",
      "    paths: [metrics.ts]",
      '    linePattern: "atoms"',
    ].join("\n"), "utf8");
    const loaded = loadVocabulary(good);
    expect(loaded.exemptions).toHaveLength(1);
    expect(loaded.exemptions[0]?.linePattern).toBe("atoms");

    const bad = join(root, "bad.yaml");
    writeFileSync(bad, "kind: domain-vocabulary\nname: probe\nexemptions:\n  - {name: n, term: t, resaon: typo}\n", "utf8");
    expect(() => loadVocabulary(bad)).toThrow();
  } finally { removeTree(root); }
});

test("merging vocabularies unions exemptions and keeps the first of a duplicated name", () => {
  const a = vocab(["density"], [{ name: "dup", term: "density", reason: "first", paths: [] }]);
  const b = vocab(["motion"], [{ name: "dup", term: "motion", reason: "second", paths: [] }, { name: "other", term: "motion", reason: "kept", paths: [] }]);
  const merged = mergeVocabularies(a, b);
  expect(merged.exemptions.map(e => e.name)).toEqual(["dup", "other"]);
  expect(merged.exemptions[0]?.reason).toBe("first");
});

/**
 * Second generation. The first-generation gate structurally cannot see these:
 * it counts `code` context only and skips `ambiguous` words, while a hardcoded
 * closed set is by nature a *quoted* enumeration, and half its members
 * (`requires`, `extends`, `conflicts`) are on the ambiguous list as English.
 */

test("a quoted non-ambiguous relation name is a closed-set literal", () => {
  const scan = scanSource('for (const e of this.outgoing(a, "contradicts")) return true;\n', relationVocab(["contradicts"]));
  expect(scan.closedSetHits.map(h => `${h.line}:${h.term}`)).toEqual(["1:contradicts"]);
  expect(scan.distinctiveByPackage).toEqual({});   // invisible to the first-generation gate
  expect(closedSetCheck(scan).status).toBe("fail");
});

test("a single quoted ambiguous name is not enough, but two on one line are an enumeration", () => {
  const v = relationVocab(["requires", "extends"], ["requires", "extends"]);
  const lone = scanSource('const x = this.outgoing(a, "requires");\n', v);
  expect(lone.closedSetHits).toHaveLength(0);

  const enumerated = scanSource('const verbs = ["requires", "extends"];\n', v);
  expect(enumerated.closedSetHits.map(h => h.term).sort()).toEqual(["extends", "requires"]);
});

test("a string-literal union of relation names is caught", () => {
  const scan = scanSource('export type LinkVerb = "requires" | "contradicts" | "specializes";\n', relationVocab(["requires", "contradicts", "specializes"], ["requires"]));
  expect(scan.closedSetHits).toHaveLength(3);
});

test("one site counts once even when a name and its alias both match", () => {
  const v = relationVocab(["see-also", "see_also"]);
  const scan = scanSource('const map = { "see-also": "see-also" };\n', v);
  expect(scan.closedSetHits).toHaveLength(1);
});

test("a term the model never declared is not a closed-set literal, however it is quoted", () => {
  const scan = scanSource('const axis = "typography";\n', vocab(["typography"]));
  expect(scan.closedSetHits).toHaveLength(0);
  expect(closedSetCheck(scan).status).toBe("pass");
});

test("a relation name in a comment is not a closed-set literal", () => {
  const scan = scanSource('// contradicts blocks composition\n', relationVocab(["contradicts"]));
  expect(scan.closedSetHits).toHaveLength(0);
});

test("an exemption can clear a string hit, so the closed-set check has an escape hatch", () => {
  const v: Vocabulary = {
    ...relationVocab(["contradicts"]),
    exemptions: [{ name: "prompt-text", term: "contradicts", reason: "LLM prompt prose", paths: ["prompt.ts"] }],
  };
  const scan = scanSource('const p = "contradicts";\n', v, "prompt.ts");
  expect(scan.closedSetHits).toHaveLength(0);
  expect(scan.exemptedByName).toEqual({ "prompt-text": 1 });
});

test("a path-anchored exemption whose file is outside the scan roots is out of scope, not stale", () => {
  // Regression: a scoped run (`--roots=packages/runtime/src`) used to report every
  // exemption anchored elsewhere as stale, training the reader to ignore the warning.
  const scan = scanSource("const x = 1;\n", vocab(["density"], [{
    name: "elsewhere", term: "density", reason: "anchored to another package", paths: ["packages/other/src/a.ts"],
  }]), "probe.ts");
  expect(scan.staleExemptions).toEqual([]);
});
