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
    // This is the value `corpus.manifest.json` carried before the namespace
    // cutover, and it reached the public aoe:// URI. The grammar makes it
    // unrepresentable, and `mountCorpus` now enforces the grammar at mount time.
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

  it("defaults assets and citations to empty rather than absent", () => withPackage((_root, write) => {
    // A pure-text corpus ships no bytes and may cite nothing. The fields still
    // exist on the parsed value, so a consumer never has to test for undefined
    // before deciding whether the corpus publishes assets.
    const result = loadCorpusPackage(write(declaration()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declaration.assets).toEqual([]);
    expect(result.value.declaration.citations).toEqual([]);
  }));

  it("requires an asset path to exist on disk, because assets are published bytes", () => withPackage((root, write) => {
    // Unlike a source set, `path` is mandatory on an asset: §8.3's bundle has an
    // `assets/` directory, so these bytes are copied through and served verbatim.
    mkdirSync(join(root, "assets"));
    const present = loadCorpusPackage(write(declaration({
      assets: [{ id: "brand", path: "assets", kind: "image", license: "Apache-2.0" }],
    })));
    expect(present.ok).toBe(true);
    if (present.ok) expect(present.value.declaration.assets[0]?.emit).toBe(true);
    const missing = loadCorpusPackage(write(declaration({
      assets: [{ id: "brand", path: "absent", kind: "image", license: "Apache-2.0" }],
    })));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics.some(d => d.code === "PATH_NOT_FOUND")).toBe(true);
    const pathless = loadCorpusPackage(write(declaration({
      assets: [{ id: "brand", kind: "image", license: "Apache-2.0" }],
    })));
    expect(pathless.ok).toBe(false);
  }));

  it("refuses two emitted asset sets that claim the same path", () => withPackage((root, write) => {
    mkdirSync(join(root, "assets"));
    const clashing = loadCorpusPackage(write(declaration({
      assets: [
        { id: "a", path: "assets", kind: "image", license: "Apache-2.0" },
        { id: "b", path: "assets", kind: "image", license: "MPL-2.0" },
      ],
      license: { expression: "Apache-2.0 AND MPL-2.0", policy: { allow: ["Apache-2.0", "MPL-2.0"] } },
    })));
    expect(clashing.ok).toBe(false);
    if (!clashing.ok) expect(clashing.diagnostics.some(d => d.code === "ASSET_PATH_CLAIMED_TWICE")).toBe(true);
    // Not emitted means not published, so the same path may be declared again:
    // the ambiguity the check guards against is about the bytes in the bundle.
    const unemitted = loadCorpusPackage(write(declaration({
      assets: [
        { id: "a", path: "assets", kind: "image", license: "Apache-2.0" },
        { id: "b", path: "assets", kind: "image", license: "Apache-2.0", emit: false },
      ],
    })));
    expect(unemitted.ok).toBe(true);
  }));

  it("refuses a citation that names a source set nobody declared", () => withPackage((_root, write) => {
    const citation = {
      id: "wcag-22", work: "WCAG 2.2", rightsHolder: "W3C",
      url: "https://www.w3.org/TR/WCAG22/", publishedOn: "2023-10-05",
      appliesTo: ["w3c-references"], use: "restatement",
    };
    const dangling = loadCorpusPackage(write(declaration({ citations: [citation] })));
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) expect(dangling.diagnostics.some(d => d.code === "CITATION_TARGET_UNKNOWN")).toBe(true);
    const attached = loadCorpusPackage(write(declaration({
      sources: [{ id: "w3c-references", origin: "https://www.w3.org/TR/WCAG22/", license: "Apache-2.0" }],
      citations: [citation],
    })));
    expect(attached.ok).toBe(true);
  }));

  it("requires a citation to be locatable and anchored to a version", () => withPackage((_root, write) => {
    const base = {
      id: "nielsen", work: "Usability Engineering", rightsHolder: "Jakob Nielsen",
      appliesTo: ["own"], use: "restatement" as const,
    };
    // An ISBN is a locator even though it is not a URL — the printed book this
    // corpus actually cites has no canonical URL, which is why `url` is optional.
    const byIsbn = loadCorpusPackage(write(declaration({
      citations: [{ ...base, identifier: "isbn:978-0125184069", publishedOn: "1994" }],
    })));
    expect(byIsbn.ok).toBe(true);
    const unlocatable = loadCorpusPackage(write(declaration({ citations: [{ ...base, publishedOn: "1994" }] })));
    expect(unlocatable.ok).toBe(false);
    if (!unlocatable.ok) expect(unlocatable.diagnostics.some(d => d.code === "CITATION_NOT_LOCATABLE")).toBe(true);
    const unanchored = loadCorpusPackage(write(declaration({ citations: [{ ...base, identifier: "isbn:978-0125184069" }] })));
    expect(unanchored.ok).toBe(false);
    if (!unanchored.ok) expect(unanchored.diagnostics.some(d => d.code === "CITATION_NOT_ANCHORED")).toBe(true);
  }));

  it("carries no licence on a citation, because nothing is redistributed", () => withPackage((_root, write) => {
    // §8.3's CorpusBundle has `assets/` and no `citations/`. A licence answers
    // "under what terms may I pass these bytes on", and for a cited work the
    // answer is "you may not, they are not here" — so the field is unrepresentable
    // rather than merely optional, and the obligation lives on the source set.
    const result = loadCorpusPackage(write(declaration({
      citations: [{
        id: "wcag-22", work: "WCAG 2.2", rightsHolder: "W3C", url: "https://www.w3.org/TR/WCAG22/",
        publishedOn: "2023-10-05", appliesTo: ["own"], use: "restatement", license: "CC-BY-4.0",
      }],
    })));
    expect(result.ok).toBe(false);
  }));
});

describe("resolveCorpusPackage", () => {
  const parse = (overrides: Record<string, unknown> = {}, setup?: (root: string) => void): CorpusPackageDeclaration => {
    let parsed: CorpusPackageDeclaration | undefined;
    let diagnostics: readonly { code: string; message: string }[] = [];
    withPackage((root, write) => {
      setup?.(root);
      const result = loadCorpusPackage(write(declaration(overrides)));
      if (result.ok) parsed = result.value.declaration;
      else diagnostics = result.diagnostics;
    });
    if (parsed === undefined) throw new Error(`fixture declaration failed to load: ${diagnostics.map(d => `${d.code}: ${d.message}`).join("; ")}`);
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

  it("runs asset licences through the same policy as source licences", () => {
    // Assets are the material that is published *verbatim*, so leaving them out
    // of the gate would exempt exactly the bytes whose terms matter most.
    const resolved = resolveCorpusPackage(
      parse({
        assets: [{ id: "borrowed-art", path: "assets", kind: "image", license: "GPL-3.0" }],
        license: { expression: "Apache-2.0 AND GPL-3.0", policy: { allow: ["Apache-2.0"], deny: ["GPL-3.0"] } },
      }, (root) => mkdirSync(join(root, "assets"))),
      { availableModelVersions: { "prime-v1-compatibility": ["1.0.0"] } },
    );
    expect(resolved.diagnostics.some(d => d.code === "LICENSE_DENIED" && d.subject === "borrowed-art")).toBe(true);
    expect(resolved.assetLicenses[0]?.verdictOk).toBe(false);
    // And an asset licence counts toward what the corpus expression must summarise.
    expect(resolved.licenseIds).toEqual(["Apache-2.0", "GPL-3.0"]);
  });
});
