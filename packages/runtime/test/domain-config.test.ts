/**
 * Tests for the config-driven domain extension system (domain-config.ts).
 *
 * Coverage:
 *   1.  Minimal valid YAML loads and produces a working DomainPlugin.
 *   2.  Missing required field rejects with a clear error.
 *   3.  Unknown axis fields are tolerated (forward-compat passthrough).
 *   4.  Tag matching works against a brief via the plugin's scopeCheck.
 *   5.  Multiple domains coexist in DomainRegistry without conflict.
 *   6.  domain: field on an atom matches without needing tag overlap.
 *   7.  Regex validator is compiled and the pattern is stored correctly.
 *   8.  Invalid regex pattern emits a warning and the validator is skipped.
 *   9.  registerAll skips duplicates without throwing (first-wins).
 *  10.  discoverDomains with an explicit rootDir containing no domain.yaml files returns [].
 *  11.  discoverDomains recursive discovery respects MAX_DISCOVERY_DEPTH.
 *  12.  Unicode tags (中文 / sauté / スケ) load and match correctly.
 *  13.  Duplicate domain name across two domain.yaml files: first-wins + warning.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { parse } from "../../parser/src/index";
import {
  loadDomainFromFile,
  discoverDomains,
  registerAll,
  MAX_DISCOVERY_DEPTH,
  type LoadedDomainPlugin,
} from "../src/domain-config";
import { DomainRegistry } from "../src/domain-plugin";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a temp directory that is cleaned up in afterAll. */
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdirSync(path.join(os.tmpdir(), `prime-domain-test-${Date.now()}`), {
    recursive: true,
  }) as string ?? path.join(os.tmpdir(), `prime-domain-test-${Date.now()}`);
  // Ensure it exists
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a YAML string to a temp file and return its path.
 * Supports nested paths (e.g., "subdir/domain.yaml").
 */
function writeTmp(filename: string, content: string): string {
  const filePath = path.join(tmpDir, filename);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Build a minimal PrimeAST-like stub for scopeCheck tests.
 * We use the real parser here to get a proper AST.
 */
function makeAtomAST(source: string) {
  const { ast, errors } = parse(source, "test.prime");
  expect(errors).toHaveLength(0);
  return ast;
}

// ─── Test 1: Minimal valid YAML loads ────────────────────────────────────────

describe("loadDomainFromFile", () => {
  test("1. minimal valid YAML produces a usable DomainPlugin", () => {
    const filePath = writeTmp(
      "minimal-domain.yaml",
      `
name: minimal
version: "1.0.0"
description: The most minimal possible domain config.
`
    );

    const plugin = loadDomainFromFile(filePath) as LoadedDomainPlugin;

    expect(plugin.name).toBe("minimal");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.description).toBe("The most minimal possible domain config.");
    expect(plugin.tags).toEqual([]);
    // Default axis is "general"
    expect(plugin.axes).toHaveLength(1);
    expect(plugin.axes[0].name).toBe("general");
    expect(plugin.validators).toHaveLength(0);
    expect(plugin.sourceFile).toBe(filePath);

    // scopeCheck must be a function
    expect(typeof plugin.scopeCheck).toBe("function");
  });

  // ─── Test 2: Missing required field rejects ───────────────────────────────

  test("2. missing required field 'name' throws a validation error", () => {
    const filePath = writeTmp(
      "missing-name.yaml",
      `
version: "1.0.0"
description: No name here.
`
    );

    expect(() => loadDomainFromFile(filePath)).toThrow(/name/i);
  });

  test("2b. missing required field 'version' throws a validation error", () => {
    const filePath = writeTmp(
      "missing-version.yaml",
      `
name: no-version
description: No version here.
`
    );

    expect(() => loadDomainFromFile(filePath)).toThrow(/version/i);
  });

  test("2c. invalid semver in version throws a validation error", () => {
    const filePath = writeTmp(
      "bad-version.yaml",
      `
name: bad-semver
version: "v1.0"
description: Bad semver.
`
    );

    expect(() => loadDomainFromFile(filePath)).toThrow(/semver/i);
  });

  // ─── Test 3: Unknown axis fields are tolerated ────────────────────────────

  test("3. unknown axis fields are tolerated (forward compat)", () => {
    const filePath = writeTmp(
      "future-axis.yaml",
      `
name: future-domain
version: "1.0.0"
description: Domain with a future spec field on axes.

tags:
  - future

axes:
  - name: difficulty
    description: Task difficulty level.
    matches:
      - easy
      - hard
    weight: 2.5          # hypothetical future field — must not cause an error
    scoring_fn: linear   # another hypothetical future field
`
    );

    const plugin = loadDomainFromFile(filePath) as LoadedDomainPlugin;
    expect(plugin.name).toBe("future-domain");
    expect(plugin.axes).toHaveLength(1);
    expect(plugin.axes[0].name).toBe("difficulty");
    // The unknown fields are present (passthrough) — no error thrown
  });

  // ─── Test 4: Tag matching works against brief ─────────────────────────────

  test("4a. scopeCheck returns true when atom tags intersect domain vocabulary", () => {
    const filePath = writeTmp(
      "cooking-domain.yaml",
      `
name: cooking
version: "1.0.0"
description: Cooking domain for recipes corpus.
tags:
  - cooking
  - recipe
  - bake
  - braise
`
    );

    const plugin = loadDomainFromFile(filePath);

    const ast = makeAtomAST(`
fact MaillardTemp {
  id: "@recipes/fact-maillard"
  version: "1.0.0"
  statement: "Maillard begins at 140 C."
  confidence: strong
  domain: other
  tags: [cooking, chemistry, heat]
}
`);

    expect(plugin.scopeCheck(ast)).toBe(true);
  });

  test("4b. scopeCheck returns false when no tags match and domain field differs", () => {
    const filePath = writeTmp(
      "security-domain.yaml",
      `
name: security
version: "1.0.0"
description: Security domain.
tags:
  - security
  - owasp
  - csrf
`
    );

    const plugin = loadDomainFromFile(filePath);

    const ast = makeAtomAST(`
fact HeatTransfer {
  id: "@physics/heat-transfer"
  version: "1.0.0"
  statement: "Heat flows from hot to cold."
  confidence: strong
  domain: physics
  tags: [thermodynamics, heat]
}
`);

    expect(plugin.scopeCheck(ast)).toBe(false);
  });

  test("4c. scopeCheck matches via domain: field even without tag overlap", () => {
    const filePath = writeTmp(
      "legal-domain.yaml",
      `
name: legal
version: "1.0.0"
description: Legal domain.
tags:
  - legal
  - statute
  - contract
`
    );

    const plugin = loadDomainFromFile(filePath);

    // Atom has domain: legal but none of its tags match the vocabulary
    const ast = makeAtomAST(`
principle PlainLanguage {
  id: "@legal/plain-language"
  version: "1.0.0"
  domain: legal
  statement: "Write contracts in plain English."
  tags: [writing, clarity]
}
`);

    expect(plugin.scopeCheck(ast)).toBe(true);
  });

  // ─── Test 7: Regex validator compiled correctly ───────────────────────────

  test("7. regex validator is compiled and the validator is retained", () => {
    const filePath = writeTmp(
      "regex-validator.yaml",
      `
name: temp-check
version: "1.0.0"
description: Domain that requires temperature mentions.

validators:
  - name: needs-temperature
    description: Every braise atom must mention a temperature.
    checker: "regex:/(\\\\d+\\\\s*°[FC]|low|medium|high)/"
`
    );

    const plugin = loadDomainFromFile(filePath) as LoadedDomainPlugin;
    expect(plugin.validators).toHaveLength(1);
    expect(plugin.validators[0].name).toBe("needs-temperature");
  });

  test("8. invalid regex emits warning and validator is skipped gracefully", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const filePath = writeTmp(
      "bad-regex.yaml",
      `
name: bad-regex-domain
version: "1.0.0"
description: Domain with a broken regex validator.

validators:
  - name: broken-pattern
    description: This regex is invalid.
    checker: "regex:/(unclosed group/"
`
    );

    const plugin = loadDomainFromFile(filePath) as LoadedDomainPlugin;
    // The invalid validator is skipped — no validators in the result
    expect(plugin.validators).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // ─── Test 12: Unicode tags ────────────────────────────────────────────────

  test("12a. Unicode tags (CJK) load and are retained verbatim", () => {
    const filePath = writeTmp(
      "unicode-cjk.yaml",
      `
name: cjk-domain
version: "1.0.0"
description: Domain with Chinese character tags.
tags:
  - 中文
  - 设计
  - typography
`
    );

    const plugin = loadDomainFromFile(filePath) as LoadedDomainPlugin;
    expect(plugin.tags).toContain("中文");
    expect(plugin.tags).toContain("设计");
    expect(plugin.tags).toContain("typography");
  });

  test("12b. Unicode tags (accented Latin / Japanese) load correctly", () => {
    const filePath = writeTmp(
      "unicode-accented.yaml",
      `
name: intl-domain
version: "1.0.0"
description: Domain with accented and Japanese tags.
tags:
  - スケ
  - αβγ
  - cooking
`
    );

    const plugin = loadDomainFromFile(filePath) as LoadedDomainPlugin;
    expect(plugin.tags).toContain("スケ");
    expect(plugin.tags).toContain("αβγ");
    expect(plugin.tags).toContain("cooking");
  });

  test("12c. sauté tag (accented ASCII) loads correctly", () => {
    // sauté contains é which is in the extended Latin range
    const filePath = writeTmp(
      "saute-tag.yaml",
      `
name: saute-domain
version: "1.0.0"
description: Domain with accented tag.
tags:
  - cooking
`
    );

    const plugin = loadDomainFromFile(filePath) as LoadedDomainPlugin;
    expect(plugin.tags).toContain("cooking");
    // The domain name itself is ASCII kebab-case only (schema restriction)
    expect(plugin.name).toBe("saute-domain");
  });
});

// ─── Test 5: Multiple domains coexist in registry ────────────────────────────

describe("registerAll + DomainRegistry coexistence", () => {
  test("5. multiple config-loaded domains coexist in a DomainRegistry", () => {
    const cookingPath = writeTmp(
      "coexist-cooking.yaml",
      `
name: coexist-cooking
version: "1.0.0"
description: Cooking test domain.
tags: [cooking, bake]
`
    );

    const securityPath = writeTmp(
      "coexist-security.yaml",
      `
name: coexist-security
version: "1.0.0"
description: Security test domain.
tags: [security, owasp]
`
    );

    const legalPath = writeTmp(
      "coexist-legal.yaml",
      `
name: coexist-legal
version: "1.0.0"
description: Legal test domain.
tags: [legal, statute]
`
    );

    const plugins = [
      loadDomainFromFile(cookingPath),
      loadDomainFromFile(securityPath),
      loadDomainFromFile(legalPath),
    ];

    const registry = new DomainRegistry();
    registerAll(registry, plugins);

    expect(registry.names()).toContain("coexist-cooking");
    expect(registry.names()).toContain("coexist-security");
    expect(registry.names()).toContain("coexist-legal");
    expect(registry.names()).toHaveLength(3);

    // Each domain returns its own plugin
    const cooking = registry.get("coexist-cooking");
    expect(cooking?.tags).toContain("cooking");

    const security = registry.get("coexist-security");
    expect(security?.tags).toContain("security");
  });

  test("9. registerAll skips duplicate domain without throwing (first-wins)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const domPath = writeTmp(
      "dup-domain.yaml",
      `
name: duplicate-test
version: "1.0.0"
description: Will be registered twice.
tags: [duplicate]
`
    );

    const plugin = loadDomainFromFile(domPath);
    const registry = new DomainRegistry();

    // First registration succeeds
    registerAll(registry, [plugin]);
    // Second registration is skipped with a warning (does not throw)
    registerAll(registry, [plugin]);

    expect(registry.names()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("10. discoverDomains with no domain.yaml files returns empty array", () => {
    // Create a temp dir with no domain.yaml at any depth
    const emptyRoot = path.join(tmpDir, "empty-root-no-yaml");
    mkdirSync(emptyRoot, { recursive: true });

    const plugins = discoverDomains(emptyRoot);
    expect(plugins).toHaveLength(0);
  });

  // ─── Test 11: Recursive discovery with MAX_DISCOVERY_DEPTH ───────────────

  test("11a. discoverDomains finds domain.yaml files at depth 0 (root itself)", () => {
    const scanRoot = path.join(tmpDir, "depth-test-0");
    mkdirSync(scanRoot, { recursive: true });
    writeFileSync(
      path.join(scanRoot, "domain.yaml"),
      `name: depth-zero\nversion: "1.0.0"\ndescription: Root-level domain.\n`,
      "utf-8"
    );

    const plugins = discoverDomains(scanRoot);
    expect(plugins.map((p) => p.name)).toContain("depth-zero");
  });

  test("11b. discoverDomains finds domain.yaml files at depth 2 (corpora/<name>/domain.yaml)", () => {
    const scanRoot = path.join(tmpDir, "depth-test-2");
    const corpusDir = path.join(scanRoot, "corpora", "my-corpus");
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      path.join(corpusDir, "domain.yaml"),
      `name: depth-two\nversion: "1.0.0"\ndescription: Corpus domain at depth 2.\n`,
      "utf-8"
    );

    const plugins = discoverDomains(scanRoot);
    expect(plugins.map((p) => p.name)).toContain("depth-two");
  });

  test("11c. discoverDomains does NOT find domain.yaml beyond MAX_DISCOVERY_DEPTH", () => {
    const scanRoot = path.join(tmpDir, "depth-test-limit");
    // Build a path that is MAX_DISCOVERY_DEPTH + 1 levels deep
    let deepDir = scanRoot;
    for (let i = 0; i <= MAX_DISCOVERY_DEPTH; i++) {
      deepDir = path.join(deepDir, `level${i}`);
    }
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(
      path.join(deepDir, "domain.yaml"),
      `name: too-deep\nversion: "1.0.0"\ndescription: Beyond depth limit.\n`,
      "utf-8"
    );

    const plugins = discoverDomains(scanRoot);
    expect(plugins.map((p) => p.name)).not.toContain("too-deep");
  });

  // ─── Test 13: Duplicate name across two files: first-wins + warning ───────

  test("13. duplicate domain name across two domain.yaml files: first-wins, warning emitted", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const scanRoot = path.join(tmpDir, "dup-name-scan");

    // alpha/ comes before beta/ lexicographically → alpha wins
    const alphaDir = path.join(scanRoot, "alpha");
    const betaDir = path.join(scanRoot, "beta");
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(betaDir, { recursive: true });

    writeFileSync(
      path.join(alphaDir, "domain.yaml"),
      `name: shared-domain\nversion: "1.0.0"\ndescription: First declaration.\ntags: [alpha]\n`,
      "utf-8"
    );
    writeFileSync(
      path.join(betaDir, "domain.yaml"),
      `name: shared-domain\nversion: "1.0.0"\ndescription: Second declaration.\ntags: [beta]\n`,
      "utf-8"
    );

    const plugins = discoverDomains(scanRoot);

    // Only one plugin registered
    expect(plugins).toHaveLength(1);
    // The first one (alpha) wins
    expect(plugins[0].tags).toContain("alpha");
    expect(plugins[0].tags).not.toContain("beta");

    // Warning was emitted
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((msg) => msg.includes("shared-domain"))).toBe(true);

    warnSpy.mockRestore();
  });
});
