import { expect, test } from "bun:test";
import { join } from "node:path";
import { runModelConformance } from "../src/model-conformance.ts";
import { DEFAULT_RENDERER_SECTIONS_PATH, defaultRendererSections, loadRendererSections } from "../src/renderer-sections.ts";
import { minimalModelFiles, removeTree, writeModel } from "./helpers.ts";

/**
 * D-6: a projection `include` list mixes three namespaces. Splitting them must
 * not blind the checker — a genuinely undeclared field selector still errors.
 */

const RENDERER_SECTION = "sources";        // an `appendSection` case (chunker.ts:349)
const IDENTITY_ATTRIBUTE = "kind";         // on UnitIR.typeRef, never a type field
const REAL_TYPO = "stateemnt";             // neither: a real mistake

function findingsOf(definitions: string, checkId: string): readonly { code: string; severity: string; message: string }[] {
  const root = writeModel(minimalModelFiles(definitions));
  try {
    const r = runModelConformance(root);
    return (r.checks.find(c => c.id === checkId)?.findings ?? []).map(f => ({ code: f.code, severity: f.severity, message: f.message }));
  } finally { removeTree(root); }
}

const MODEL = (selectors: string) =>
  '  - {kind: type, name: A, version: 1.0.0, fields: [{name: statement, typeRef: string, required: true}]}\n'
  + `  - {kind: projection, name: p, version: 1.0.0, targetTokens: 40, rules: [{typeRef: A, include: [statement, ${selectors}]}]}\n`;

test("the bundled renderer vocabulary is real data read off the compiler", () => {
  const sections = loadRendererSections();
  expect(sections.name).toBe("chunker-v1");
  // Every case of appendSection()'s switch, plus the one-liner renderer.
  for (const name of ["facts", "definitions", "categories", "checks", "steps", "signature", "predicate", "effect",
    "includes", "severity_combination", "constraint-values", "sources", "examples", "relations", "notes",
    "rationale", "provenance", "full-categories", "unprocessed-fields", "kind-specific-one-liner"])
    expect(sections.names.has(name)).toBe(true);
  // appendSources() accepts both spellings (chunker.ts:754-755).
  expect(sections.names.has("source")).toBe(true);
  expect(DEFAULT_RENDERER_SECTIONS_PATH.endsWith(join("renderer-sections", "chunker-v1.yaml"))).toBe(true);
});

test("a renderer section name is a warning on its own check, not a schema error", () => {
  expect(findingsOf(MODEL(RENDERER_SECTION), "MC-PROJ-SELECTORS")).toEqual([]);
  const sections = findingsOf(MODEL(RENDERER_SECTION), "MC-PROJ-RENDERER-SECTIONS");
  expect(sections.map(f => `${f.severity}/${f.code}`)).toEqual(["warning/PROJECTION_SELECTOR_IS_RENDERER_SECTION"]);
  expect(sections[0]?.message).toContain("no-ops when the field is absent");
  expect(sections[0]?.message).toContain("cannot currently distinguish");
});

test("a unit identity attribute is info, never a failure", () => {
  const findings = findingsOf(MODEL(IDENTITY_ATTRIBUTE), "MC-PROJ-SELECTORS");
  expect(findings.map(f => `${f.severity}/${f.code}`)).toEqual(["info/PROJECTION_SELECTOR_IS_IDENTITY_ATTRIBUTE"]);
});

test("a genuinely undeclared field selector still errors — the split did not blind the checker", () => {
  const findings = findingsOf(MODEL(REAL_TYPO), "MC-PROJ-SELECTORS");
  expect(findings.map(f => `${f.severity}/${f.code}`)).toEqual(["error/PROJECTION_SELECTOR_UNRESOLVED"]);
  expect(findings[0]?.message).toContain(REAL_TYPO);
});

test("all three namespaces in one rule are reported separately and graded independently", () => {
  const definitions = MODEL(`${RENDERER_SECTION}, ${IDENTITY_ATTRIBUTE}, ${REAL_TYPO}`);
  expect(findingsOf(definitions, "MC-PROJ-SELECTORS").map(f => `${f.severity}/${f.code}`).sort())
    .toEqual(["error/PROJECTION_SELECTOR_UNRESOLVED", "info/PROJECTION_SELECTOR_IS_IDENTITY_ATTRIBUTE"]);
  expect(findingsOf(definitions, "MC-PROJ-RENDERER-SECTIONS").map(f => f.severity)).toEqual(["warning"]);
});

test("without the renderer vocabulary every unresolved selector reverts to a schema error", () => {
  const root = writeModel(minimalModelFiles(MODEL(RENDERER_SECTION)));
  try {
    const r = runModelConformance(root, { rendererSections: { name: "none", names: new Set<string>() } });
    expect((r.checks.find(c => c.id === "MC-PROJ-SELECTORS")?.findings ?? []).map(f => f.code)).toEqual(["PROJECTION_SELECTOR_UNRESOLVED"]);
    expect(r.checks.find(c => c.id === "MC-PROJ-RENDERER-SECTIONS")?.status).toBe("pass");
  } finally { removeTree(root); }
});

test("the default vocabulary is used when no override is passed", () => {
  expect(defaultRendererSections().names.size).toBeGreaterThan(19);
});
