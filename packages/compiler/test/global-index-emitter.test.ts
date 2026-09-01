/**
 * `buildGlobalIndexXml` — the corpus index builder.
 *
 * These assertions moved here from `atom-dir-emitter.test.ts` when W7-A deleted
 * the legacy atom-dir emitter and the `emitGlobalIndex` file writer. The builder
 * outlived both because `@aoe/bundle` calls it from
 * `finalizeCorpusBundle`, so the properties it is asserted on — domain
 * clustering, determinism regardless of input order, and the index token budget
 * — are still load-bearing for every compiled corpus.
 */

import { describe, expect, test } from "bun:test";
import { buildGlobalIndexXml, type AtomMeta } from "../src/global-index-emitter";

const meta = (overrides: Partial<AtomMeta> & Pick<AtomMeta, "id">): AtomMeta => ({
  kind: "fact",
  version: "1.0.0",
  description: "A description",
  domain: "frontend-design",
  tags: [],
  tokens: { summary: 10, core: 50, full: 100 },
  quality: "4.0",
  ...overrides,
});

describe("buildGlobalIndexXml — _index.xml", () => {
  test("is well-formed XML listing every atom", () => {
    const xml = buildGlobalIndexXml([
      meta({ id: "@community/fact-wcag-focus-contrast", description: "Focus ring contrast must be >= 3:1 against adjacent colors", tags: ["a11y", "wcag"], tokens: { summary: 28, core: 142, full: 384 }, quality: "4.7" }),
      meta({ id: "@community/method-design-critique", kind: "method", description: "4-phase design review method", tags: ["design", "critique"], tokens: { summary: 30, core: 180, full: 420 }, quality: "4.6" }),
    ]);

    expect(xml).toContain("<?xml version");
    expect(xml).toContain("<prime_index");
    expect(xml).toContain("</prime_index>");
    expect(xml).toContain("<cluster");
    expect(xml).toContain("</cluster>");
    expect(xml).toContain("<atom");
    expect(xml).toContain("</atom>");
    expect(xml).toContain("@community/fact-wcag-focus-contrast");
    expect(xml).toContain("@community/method-design-critique");
  });

  test("groups atoms by domain", () => {
    const xml = buildGlobalIndexXml([
      meta({ id: "@community/fact-a", domain: "typography", tags: ["font"] }),
      meta({ id: "@community/fact-b", domain: "frontend-design", tags: ["a11y"] }),
    ]);
    expect(xml).toContain('name="typography"');
    expect(xml).toContain('name="frontend-design"');
  });

  test("is deterministic regardless of input order", () => {
    const metas = [meta({ id: "@b/atom", domain: "d" }), meta({ id: "@a/atom", domain: "d" })];
    expect(buildGlobalIndexXml(metas)).toBe(buildGlobalIndexXml([...metas].reverse()));
  });

  test("fits the 500-token index budget for 10 atoms", () => {
    const metas = Array.from({ length: 10 }, (_, index) => meta({
      id: `@community/atom-${index}`,
      description: `This is atom number ${index} with a reasonable description`,
      tags: ["tag1", "tag2"],
      tokens: { summary: 25, core: 100, full: 300 },
    }));
    expect(Math.ceil(buildGlobalIndexXml(metas).length / 4)).toBeLessThan(500);
  });
});
