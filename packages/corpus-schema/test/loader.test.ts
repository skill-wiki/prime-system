import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { CORPUS_DECLARATION_FILE, loadCorpusPackage, resolveCorpusPackage } from "../src/loader.ts";
import type { CorpusPackageDeclaration } from "../src/schema.ts";

function withPackage(run: (root: string, write: (document: unknown) => string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "prime-corpus-package-"));
  try {
    run(root, (document) => {
      const path = join(root, CORPUS_DECLARATION_FILE);
      writeFileSync(path, stringify(document));
      return path;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "prime/corpus/v2",
    namespace: "org.example/frontend-design",
    version: "0.1.0",
    title: "Example",
    description: "An example corpus package.",
    models: [{ name: "prime-v1-compatibility", versionRange: "^1.0.0" }],
    sources: [{ id: "own", origin: "authored here", license: "Apache-2.0", unitCount: 3 }],
    license: { expression: "Apache-2.0", policy: { allow: ["Apache-2.0"], deny: ["GPL-3.0"] } },
    retrieval: { defaultProfile: "default" },
    publication: { visibility: "internal", channel: "pinned", requireSignature: false },
    eval: { goldenQueries: [{ name: "g", request: { unitId: "a" }, expectedUnitIds: ["a"] }] },
    ...overrides,
  };
}

describe("loadCorpusPackage", () => {
  it("loads a complete declaration", () => withPackage((_root, write) => {
    const result = loadCorpusPackage(write(declaration()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declaration.namespace).toBe("org.example/frontend-design");
    // Defaults exist so an omitted policy is still a policy, never "no checks".
    expect(result.value.declaration.license.policy.requireDeclared).toBe(true);
    expect(result.value.declaration.models[0]?.required).toBe(true);
  }));

  it("rejects a directory basename as a namespace", () => withPackage((_root, write) => {
    // This is the value `compiled-v3-final/corpus.manifest.json` carries today and
    // that reaches the public prime:// URI. The grammar makes it unrepresentable.
    const result = loadCorpusPackage(write(declaration({ namespace: "compiled-v3-final" })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some(d => d.code === "INVALID_CORPUS_DECLARATION" && d.message.includes("namespace"))).toBe(true);
  }));

  it("rejects an unparsable model version range", () => withPackage((_root, write) => {
    const result = loadCorpusPackage(write(declaration({ models: [{ name: "m", versionRange: "~>1.0" }] })));
    expect(result.ok).toBe(false);
  }));

  it("rejects an unknown top-level field instead of ignoring it", () => withPackage((_root, write) => {
    const result = loadCorpusPackage(write(declaration({ licence: "Apache-2.0" })));
    expect(result.ok).toBe(false);
  }));

  it("rejects a missing licence, retrieval, publication or eval block", () => withPackage((_root, write) => {
    for (const field of ["license", "retrieval", "publication", "eval"]) {
      const document = declaration();
      delete document[field];
      expect(loadCorpusPackage(write(document)).ok).toBe(false);
    }
  }));

  it("checks declared paths against disk and refuses an escape", () => withPackage((root, write) => {
    mkdirSync(join(root, "sources"));
    expect(loadCorpusPackage(write(declaration({ sources: [{ id: "own", origin: "x", path: "sources", license: "Apache-2.0" }] }))).ok).toBe(true);
    const missing = loadCorpusPackage(write(declaration({ sources: [{ id: "own", origin: "x", path: "absent", license: "Apache-2.0" }] })));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics.some(d => d.code === "PATH_NOT_FOUND")).toBe(true);
    const escaping = loadCorpusPackage(write(declaration({ sources: [{ id: "own", origin: "x", path: "../..", license: "Apache-2.0" }] })));
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) expect(escaping.diagnostics.some(d => d.code === "PATH_ESCAPES_ROOT")).toBe(true);
  }));

  it("refuses a public corpus that does not require a signature", () => withPackage((_root, write) => {
    const result = loadCorpusPackage(write(declaration({
      publication: { visibility: "public", channel: "pinned", requireSignature: false, publishers: ["p"] },
    })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.code === "PUBLIC_WITHOUT_SIGNATURE")).toBe(true);
  }));

  it("refuses a source set whose licence is prose", () => withPackage((_root, write) => {
    const result = loadCorpusPackage(write(declaration({
      sources: [{ id: "own", origin: "x", license: "metadata-only (each resource has its own license)" }],
    })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.some(d => d.code === "SOURCE_LICENSE_UNPARSABLE")).toBe(true);
  }));
});

describe("resolveCorpusPackage", () => {
  const parse = (overrides: Record<string, unknown> = {}): CorpusPackageDeclaration => {
    let parsed: CorpusPackageDeclaration | undefined;
    withPackage((_root, write) => {
      const result = loadCorpusPackage(write(declaration(overrides)));
      if (result.ok) parsed = result.value.declaration;
    });
    if (parsed === undefined) throw new Error("fixture declaration failed to load");
    return parsed;
  };

  it("resolves a range to the highest available model version", () => {
    const resolved = resolveCorpusPackage(parse(), { availableModelVersions: { "prime-v1-compatibility": ["1.0.0", "1.3.1", "2.0.0"] } });
    expect(resolved.models[0]?.resolved?.raw).toBe("1.3.1");
    expect(resolved.diagnostics).toEqual([]);
  });

  it("errors when a required model range matches nothing", () => {
    const resolved = resolveCorpusPackage(parse(), { availableModelVersions: { "prime-v1-compatibility": ["2.0.0"] } });
    expect(resolved.diagnostics.some(d => d.code === "MODEL_VERSION_UNRESOLVED" && d.severity === "error")).toBe(true);
  });

  it("only warns when an optional model range matches nothing", () => {
    const resolved = resolveCorpusPackage(
      parse({ models: [{ name: "prime-v1-compatibility", versionRange: "^1.0.0" }, { name: "extra", versionRange: "^9.0.0", required: false }] }),
      { availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] } },
    );
    expect(resolved.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(resolved.diagnostics.some(d => d.code === "OPTIONAL_MODEL_VERSION_UNRESOLVED")).toBe(true);
  });

  it("errors when the corpus picks a retrieval profile the model does not declare", () => {
    const resolved = resolveCorpusPackage(parse({ retrieval: { defaultProfile: "invented" } }), {
      availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] },
      declaredProfiles: ["default"],
    });
    expect(resolved.diagnostics.some(d => d.code === "DEFAULT_PROFILE_NOT_DECLARED")).toBe(true);
  });

  it("accepts a corpus-side override of a model-declared profile", () => {
    const resolved = resolveCorpusPackage(parse({ retrieval: { defaultProfile: "terse" } }), {
      availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] },
      declaredProfiles: ["default", "terse"],
    });
    expect(resolved.effectiveProfile).toBe("terse");
    expect(resolved.diagnostics).toEqual([]);
  });

  it("reports a denied licence carried by a source set", () => {
    const resolved = resolveCorpusPackage(
      parse({
        sources: [{ id: "legacy", origin: "primes/atoms", license: "GPL-3.0" }],
        license: { expression: "GPL-3.0", policy: { allow: ["Apache-2.0"], deny: ["GPL-3.0"] } },
      }),
      { availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] } },
    );
    expect(resolved.diagnostics.some(d => d.code === "LICENSE_DENIED")).toBe(true);
  });

  it("warns when the corpus licence omits an obligation its sources carry", () => {
    const resolved = resolveCorpusPackage(
      parse({
        sources: [{ id: "a", origin: "x", license: "Apache-2.0" }, { id: "b", origin: "y", license: "MPL-2.0" }],
        license: { expression: "Apache-2.0", policy: { allow: ["Apache-2.0", "MPL-2.0"] } },
      }),
      { availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] } },
    );
    expect(resolved.diagnostics.some(d => d.code === "CORPUS_LICENSE_INCOMPLETE" && d.subject === "MPL-2.0")).toBe(true);
  });

  it("collects every licence id the corpus carries", () => {
    const resolved = resolveCorpusPackage(
      parse({
        sources: [{ id: "a", origin: "x", license: "MIT AND Apache-2.0 AND MPL-2.0" }],
        license: { expression: "MIT AND Apache-2.0 AND MPL-2.0", policy: { allow: ["MIT", "Apache-2.0", "MPL-2.0"] } },
      }),
      { availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] } },
    );
    expect(resolved.licenseIds).toEqual(["Apache-2.0", "MIT", "MPL-2.0"]);
  });
});
