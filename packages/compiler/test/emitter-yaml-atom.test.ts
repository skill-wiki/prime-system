/**
 * Tests for emitYamlAtom — MCP-compatible YAML-frontmatter emitter.
 */

import { describe, test, expect } from "bun:test";
import { parse as parseYaml } from "yaml";
import { parse } from "../../parser/src/index";
import { emitYamlAtom } from "../src/emitter-yaml-atom";

function emitFrom(source: string): { text: string; frontmatter: Record<string, unknown> } {
  const { ast, errors } = parse(source);
  expect(errors).toHaveLength(0);
  const text = emitYamlAtom(ast);
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter found");
  return { text, frontmatter: parseYaml(m[1]) as Record<string, unknown> };
}

describe("emitYamlAtom — header shape", () => {
  test("emits id/version/type/name/description/tags frontmatter", () => {
    const { frontmatter } = emitFrom(`
prime Foo extends Rule {
  name: "foo-bar"
  version: "1.0.0"
  description: "A rule about foo"
  tags: ["alpha", "beta"]
  checks: [{ description: "do the thing", pass_condition: "measure it" }]
}`);
    expect(frontmatter.id).toBe("@prime/foo-bar");
    expect(frontmatter.version).toBe("1.0.0");
    expect(frontmatter.type).toBe("rule");
    expect(frontmatter.name).toBe("foo-bar");
    expect(frontmatter.description).toBe("A rule about foo");
    expect(frontmatter.tags).toEqual(["alpha", "beta"]);
  });

  test("uses module prefix from slug for id when present", () => {
    const { frontmatter } = emitFrom(`
prime M04Sidebar extends Knowledge {
  name: "m04-sidebar"
  version: "1.0.0"
  description: "Sidebar layout primitive"
  tags: ["layout"]
  facts: [{ statement: "long enough statement here", confidence: "consensus" }]
}`);
    expect(frontmatter.id).toBe("@M04/sidebar");
  });

  test("prefers explicit module field over slug prefix", () => {
    const { frontmatter } = emitFrom(`
prime X extends Knowledge {
  name: "something"
  version: "1.0.0"
  description: "desc"
  module: "M07"
  tags: ["x"]
  facts: [{ statement: "long enough statement here", confidence: "consensus" }]
}`);
    expect(frontmatter.id).toBe("@M07/something");
  });
});

describe("emitYamlAtom — claim and verify_by derivation", () => {
  test("extracts claim from first fact.statement for Knowledge", () => {
    const { frontmatter } = emitFrom(`
prime K extends Knowledge {
  name: "k"
  version: "1.0.0"
  description: "desc"
  tags: ["x"]
  facts: [{ statement: "the actual claim statement", confidence: "consensus" }]
}`);
    expect(frontmatter.claim).toBe("the actual claim statement");
  });

  test("extracts claim from first check.description for Rule", () => {
    const { frontmatter } = emitFrom(`
prime R extends Rule {
  name: "r"
  version: "1.0.0"
  description: "desc"
  tags: ["x"]
  checks: [{ description: "the actual rule description", pass_condition: "how to measure" }]
}`);
    expect(frontmatter.claim).toBe("the actual rule description");
    expect(frontmatter.verify_by).toBe("how to measure");
  });

  test("explicit claim field takes precedence over derived", () => {
    const { frontmatter } = emitFrom(`
prime R extends Rule {
  name: "r"
  version: "1.0.0"
  description: "desc"
  tags: ["x"]
  claim: "explicit claim from YAML"
  checks: [{ description: "derived", pass_condition: "x" }]
}`);
    expect(frontmatter.claim).toBe("explicit claim from YAML");
  });
});

describe("emitYamlAtom — preserves all metadata", () => {
  test("emits subtype/severity/priority/activation/status/domain/rationale", () => {
    const { frontmatter } = emitFrom(`
prime R extends Rule {
  name: "r"
  version: "1.0.0"
  description: "desc"
  tags: ["x"]
  subtype: "mandate"
  severity: "block"
  priority: 1
  activation: "reference"
  status: "validated"
  domain: "frontend-design"
  rationale: "because it matters"
  checks: [{ description: "x", pass_condition: "y" }]
}`);
    expect(frontmatter.subtype).toBe("mandate");
    expect(frontmatter.severity).toBe("block");
    expect(frontmatter.priority).toBe(1);
    expect(frontmatter.activation).toBe("reference");
    expect(frontmatter.status).toBe("validated");
    expect(frontmatter.domain).toBe("frontend-design");
    expect(frontmatter.rationale).toBe("because it matters");
  });

  test("emits nested objects (source, provenance, quality)", () => {
    const { frontmatter } = emitFrom(`
prime K extends Knowledge {
  name: "k"
  version: "1.0.0"
  description: "d"
  tags: ["x"]
  source: { repo: "https://github.com/x/y", license: "MIT" }
  quality: { accuracy: 5, actionability: 4 }
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`);
    expect(frontmatter.source).toEqual({ repo: "https://github.com/x/y", license: "MIT" });
    expect(frontmatter.quality).toEqual({ accuracy: 5, actionability: 4 });
  });
});

describe("emitYamlAtom — links", () => {
  test("emits specializes/enhances as YAML fields", () => {
    const { frontmatter } = emitFrom(`
prime X extends Knowledge {
  name: "x"
  version: "1.0.0"
  description: "d"
  tags: ["a"]
  specializes: "parent-concept"
  enhances: ["sibling-a", "sibling-b"]
  facts: [{ statement: "long enough statement here", confidence: "consensus" }]
}`);
    expect(frontmatter.specializes).toBe("parent-concept");
    expect(frontmatter.enhances).toEqual(["sibling-a", "sibling-b"]);
  });
});

describe("emitYamlAtom — body", () => {
  test("appends Notes section with description", () => {
    const { text } = emitFrom(`
prime K extends Knowledge {
  name: "k"
  version: "1.0.0"
  description: "This is the description body."
  tags: ["x"]
  facts: [{ statement: "long enough statement", confidence: "consensus" }]
}`);
    expect(text).toContain("## Notes");
    expect(text).toContain("This is the description body.");
  });
});
