import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("a shape-only exemption is unjudgeable on a scoped run but stale on a complete one", () => {
  // `http-request-method` carries no path anchor, and treating "no anchor" as
  // "nothing to rot" meant it could outlive both its sites while still looking
  // like coverage. A complete scan is exactly the evidence that it matched nowhere.
  const shapeOnly = [{ name: "http-verb", term: "method", reason: "HTTP verb", paths: [], linePattern: 'method:\\s*"POST"' }];
  const root = mkdtempSync(join(tmpdir(), "prime-scan-"));
  try {
    writeFileSync(join(root, "probe.ts"), "const x = 1;\n", "utf8");
    const scoped = scanDomainSemantics({ roots: [root], vocabulary: vocab(["method"], shapeOnly), reportRoot: root });
    expect(scoped.staleExemptions).toEqual([]);
    const complete = scanDomainSemantics({ roots: [root], vocabulary: vocab(["method"], shapeOnly), reportRoot: root, completeScan: true });
    expect(complete.staleExemptions).toEqual(["http-verb"]);
  } finally { removeTree(root); }
});

/**
 * The ruler has to be usable as a completion criterion, which means it must reach
 * zero on a repo that legitimately still contains fixtures naming `Control` and
 * `Threat`, and must not count its own diagnostic messages as violations.
 */

test("a model name that is only a word inside a sentence is prose, not a closed-set literal", () => {
  // Measured: `"Every type is covered by a projection rule"` in the testkit's own
  // model-conformance messages produced 12 reported violations, and
  // `"scope=related requires \`id\`."` produced 3 more in mcp-server-core. Both are
  // English in which two v1 type names happen to co-occur.
  const v = relationVocab(["requires", "related"], ["requires", "related"]);
  const scan = scanSource('const e = "scope=related requires `id`.";\n', v);
  expect(scan.closedSetHits).toHaveLength(0);
});

test("a distinctive model name inside a message is reported as prose, so the signal is not lost", () => {
  const scan = scanSource('const hint = "add at least one contradicts link";\n', relationVocab(["contradicts"]));
  expect(scan.closedSetHits).toHaveLength(0);
  expect(scan.proseHits.map(h => h.term)).toEqual(["contradicts"]);
  const prose = closedSetCheck(scan).findings.filter(f => f.code === "MODEL_NAME_IN_PROSE");
  expect(prose).toHaveLength(1);
  expect(prose[0]?.severity).toBe("warning");
  // A message to reword must not gate a refactor that reads the model.
  expect(closedSetCheck(scan).status).toBe("pass");
});

test("two ambiguous names are an enumeration only when nothing but delimiters separates them", () => {
  const v = relationVocab(["requires", "extends"], ["requires", "extends"]);
  const adjacent = scanSource('const verbs = ["requires", "extends"];\n', v);
  expect(adjacent.closedSetHits).toHaveLength(2);

  // Measured on `model-schema/src/index.ts:50`, a 1159-char one-liner where the
  // two names sat 880 columns apart in unrelated statements.
  const farApart = scanSource('if (a === "requires") { doWork(); log(x); } if (b === "extends") { other(); }\n', v);
  expect(farApart.closedSetHits).toHaveLength(0);
});

test("an interpolated template fragment is never an exact name", () => {
  const scan = scanSource('const id = `${owner}/requires`;\n', relationVocab(["requires"], ["requires"]));
  expect(scan.closedSetHits).toHaveLength(0);
});

/** Writes a package whose entry is `src/index.ts`, importing only what it lists. */
function scanPackage(files: Readonly<Record<string, string>>, vocabulary: Vocabulary): DomainScanReport {
  const repo = mkdtempSync(join(tmpdir(), "prime-pkg-"));
  const packageDir = join(repo, "packages", "probe");
  try {
    mkdirSync(join(packageDir, "src"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "probe", main: "src/index.ts" }), "utf8");
    for (const [name, body] of Object.entries(files)) writeFileSync(join(packageDir, name), body, "utf8");
    return scanDomainSemantics({ roots: [join(packageDir, "src")], vocabulary, reportRoot: repo, skipDirectories: ["node_modules"] });
  } finally { removeTree(repo); }
}

test("engine source is what the package entry reaches, so a fixture moved into src/ does not become engine source", () => {
  // The path criterion (`test/`, `fixtures/`) is bypassed by exactly this move.
  // Reachability is not: putting the file in src/ does not make anything load it.
  const v = relationVocab(["contradicts"]);
  const scan = scanPackage({
    "src/index.ts": 'export const VERSION = "1";\n',
    "src/security-fixture.ts": 'export const RELATIONS = ["contradicts"];\nimport { test } from "bun:test";\n',
  }, v);
  const hit = scan.closedSetHits.find(h => h.path.endsWith("security-fixture.ts"));
  expect(hit?.tier).toBe("test");
  expect(scan.closedSetByPackage).toEqual({});
  expect(closedSetCheck(scan).status).toBe("pass");
  const info = closedSetCheck(scan).findings.filter(f => f.code === "MODEL_NAME_IN_TEST_FIXTURE");
  expect(info[0]?.severity).toBe("info");
});

test("importing that same fixture from the entry makes it engine source and it gates again", () => {
  const scan = scanPackage({
    "src/index.ts": 'export { RELATIONS } from "./security-fixture.ts";\n',
    "src/security-fixture.ts": 'export const RELATIONS = ["contradicts"];\n',
  }, relationVocab(["contradicts"]));
  expect(scan.closedSetHits[0]?.tier).toBe("engine");
  expect(closedSetCheck(scan).status).toBe("fail");
});

test("an unreachable module that is not test-shaped is a warning, never silence", () => {
  // Fail closed: import resolution can under-approximate (dynamic import, an
  // orphaned module), and a silent tier would convert that into a hidden violation.
  // Measured on `compiler/src/chunked-emitter.ts` and `compiler/src/graph-builder.ts`,
  // which have zero importers anywhere in the repo.
  const scan = scanPackage({
    "src/index.ts": 'export const VERSION = "1";\n',
    "src/orphan.ts": 'export const verbs = ["contradicts"];\n',
  }, relationVocab(["contradicts"]));
  expect(scan.closedSetHits[0]?.tier).toBe("unreachable");
  const outcome = closedSetCheck(scan);
  expect(outcome.status).toBe("pass");
  const warn = outcome.findings.filter(f => f.code === "MODEL_CLOSED_SET_IN_UNREACHABLE");
  expect(warn).toHaveLength(1);
  expect(warn[0]?.severity).toBe("warning");
});

test("a file with no resolvable package entry stays engine tier, because a failed lookup may not weaken the gate", () => {
  const scan = scanSource('const verbs = ["contradicts"];\n', relationVocab(["contradicts"]));
  expect(scan.closedSetHits[0]?.tier).toBe("engine");
  expect(closedSetCheck(scan).status).toBe("fail");
});

test("a module specifier is not prose coupling, because it names a file not a model concept", () => {
  const scan = scanSource('export * from "./contradicts";\n', relationVocab(["contradicts"]));
  expect(scan.proseHits).toHaveLength(0);
  expect(scan.closedSetHits).toHaveLength(0);
});

test("the first-generation count is deduped per site, so an alias pair is not counted twice", () => {
  // `validates-with` and `validates_with` are two vocabulary terms whose variants
  // match the same characters; undeduped, `validates_with: "VALIDATES"` counted 2.
  const scan = scanSource("const map = { validates_with: 1 };\n", vocab(["validates-with", "validates_with"]));
  expect(Object.values(scan.distinctiveByPackage).reduce((a, b) => a + b, 0)).toBe(1);
});

test("a declaration wrapped in doc comments is still a code hit, and the comments are counted apart", () => {
  // W5-D: the `types` first-generation contradiction, pinned so it cannot be
  // reopened by a grep impression. This is the literal shape of
  // packages/types/src/knowledge.ts:31-34 and :157-159 — every gating code hit
  // in that package sits immediately below or above a doc-comment line that
  // repeats the same term, so `grep -n <term>` reads as "all in comments" while
  // the classifier reports only the declarations. Both are right; they count
  // different sets, under different diagnostic codes, and only `code` gates.
  const source = [
    "/**",
    " * Used to organize knowledge into hierarchical taxonomies.",
    " */",
    "export interface Persona {",
    "  /** Persona name */",
    "  name: string;",
    "}",
    "export interface Holder {",
    "  /** Classification taxonomies */",
    "  personas?: Persona[];",
    "}",
  ].join("\n") + "\n";
  const scan = scanSource(source, vocab(["persona"]));
  // The exported declaration and the field's type reference gate; the
  // `/** Persona name */` between them does not.
  expect(scan.hits.map(h => [h.line, h.context])).toEqual([[4, "code"], [5, "comment"], [10, "code"]]);
});
