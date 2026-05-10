/**
 * Tests for DomainRegistry and the DomainPlugin interface.
 *
 * There are no built-in code-defined domains. All test plugins are
 * constructed inline or loaded from YAML fixtures via loadDomainFromFile.
 */

import { describe, test, expect } from "bun:test";
import { parse } from "../../parser/src/index";
import {
  DomainRegistry,
  type DomainPlugin,
} from "../src/domain-plugin";

// ─── Shared test plugin (replaces FRONTEND_DESIGN_DOMAIN) ────────────────────

/** Minimal DomainPlugin covering frontend-design tags — for registry tests. */
const FRONTEND_DESIGN_TEST_PLUGIN: DomainPlugin = {
  name: "frontend-design",
  tags: ["modal", "focus", "a11y", "typography", "color", "layout", "ui", "ux"],
  scopeCheck(ast) {
    const f = ast.body.find((x) => x.key === "tags");
    if (!f || f.value.type !== "Array") return false;
    const known = new Set(FRONTEND_DESIGN_TEST_PLUGIN.tags);
    return f.value.items.some(
      (v) => v.type === "String" && known.has((v as { type: string; value: string }).value.toLowerCase())
    );
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseOne(source: string) {
  const { ast, errors } = parse(source, "x.prime");
  expect(errors).toHaveLength(0);
  return ast;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DomainRegistry", () => {
  test("registers and retrieves plugins by name", () => {
    const r = new DomainRegistry();
    r.register(FRONTEND_DESIGN_TEST_PLUGIN);
    expect(r.get("frontend-design")).toBe(FRONTEND_DESIGN_TEST_PLUGIN);
    expect(r.names()).toEqual(["frontend-design"]);
  });

  test("rejects duplicate names", () => {
    const r = new DomainRegistry();
    r.register(FRONTEND_DESIGN_TEST_PLUGIN);
    expect(() => r.register(FRONTEND_DESIGN_TEST_PLUGIN)).toThrow(/already registered/);
  });

  test("matching returns plugins that accept the AST", () => {
    const r = new DomainRegistry();
    r.register(FRONTEND_DESIGN_TEST_PLUGIN);
    const ast = parseOne(`
prime M extends Rule {
  name: "mod"
  version: "1.0.0"
  tags: ["modal", "focus"]
  checks: [{ description: "x", pass_condition: "y" }]
}`);
    expect(r.matching(ast).map((p) => p.name)).toContain("frontend-design");
  });

  test("matching returns no plugins for out-of-domain atoms", () => {
    const r = new DomainRegistry();
    r.register(FRONTEND_DESIGN_TEST_PLUGIN);
    const ast = parseOne(`
prime M extends Knowledge {
  name: "crypto-thing"
  version: "1.0.0"
  tags: ["cryptography", "rsa"]
  facts: [{ statement: "RSA is asymmetric", confidence: "consensus" }]
}`);
    expect(r.matching(ast)).toHaveLength(0);
  });

  test("starts empty — no built-in domains registered automatically", () => {
    const r = new DomainRegistry();
    expect(r.names()).toHaveLength(0);
  });

  test("custom plugin can add domain-specific heuristics", () => {
    const cryptoPlugin: DomainPlugin = {
      name: "cryptography",
      tags: ["cryptography", "rsa", "aes", "sha"],
      scopeCheck(ast) {
        const tags = ast.body.find((f) => f.key === "tags");
        if (!tags || tags.value.type !== "Array") return false;
        const known = new Set(cryptoPlugin.tags);
        return tags.value.items.some(
          (v) => v.type === "String" && known.has(v.value.toLowerCase())
        );
      },
      extraHeuristics() {
        return [
          {
            level: "suggestion",
            code: "CRYPTO-1",
            message: "cryptography atoms should cite the source standard (FIPS, RFC)",
          },
        ];
      },
    };

    const r = new DomainRegistry();
    r.register(cryptoPlugin);
    const ast = parseOne(`
prime AES extends Knowledge {
  name: "aes-256"
  version: "1.0.0"
  tags: ["cryptography", "aes"]
  facts: [{ statement: "AES-256 uses 14 rounds", confidence: "proven" }]
}`);
    const findings = r.runHeuristics(ast);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CRYPTO-1");
  });
});
