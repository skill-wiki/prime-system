import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CorpusRegistry, computeCorpusContentDigest, corpusMountKey, mountCorpus } from "../src/corpus-snapshot";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "prime-corpus-mount-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Build a valid bundle whose manifest identity is exactly `corpus`/`release`. */
function bundle(root: string, name: string, corpus: string, release: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  // Release-specific index bytes, so two releases have distinct digests.
  const index = `<prime_index version="1.0" total="0" total_tokens="0" release="${release}"></prime_index>`;
  writeFileSync(join(dir, "_index.xml"), index);
  writeFileSync(join(dir, "corpus.manifest.json"), JSON.stringify({
    protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "4",
    corpus, release, sourceRevision: "git:abc123", models: { "prime-v1-compatibility": "1.0.0" },
    schemaDigest: digest("schema"), contentDigest: computeCorpusContentDigest(dir),
    indexDigest: digest(index), createdAt: "2026-08-29T00:00:00Z",
  }));
  return dir;
}

function declarationAt(root: string, name: string, namespace: string, defaultProfile = "default"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prime-corpus.yaml"), [
    "protocol: prime/corpus/v2",
    `namespace: ${namespace}`,
    "version: 0.1.0",
    "title: Fixture",
    "description: A fixture corpus package.",
    "models:",
    "  - name: prime-v1-compatibility",
    "    versionRange: ^1.0.0",
    "sources:",
    "  - id: own",
    "    origin: authored here",
    "    license: Apache-2.0",
    "license:",
    "  expression: Apache-2.0",
    "  policy:",
    "    allow: [Apache-2.0]",
    "retrieval:",
    `  defaultProfile: ${defaultProfile}`,
    "publication:",
    "  visibility: internal",
    "  channel: pinned",
    "  requireSignature: false",
    "eval:",
    "  goldenQueries:",
    "    - name: g",
    "      request: { unitId: a }",
    "      expectedUnitIds: [a]",
    "",
  ].join("\n"));
  return dir;
}

describe("mountCorpus", () => {
  it("keys a mount by identity, never by path", () => withRoot((root) => {
    const dir = bundle(root, "bundle-a", "org.example/alpha", "2026.08.29.1");
    const outcome = mountCorpus({ path: dir });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mount.key).toBe(corpusMountKey("org.example/alpha", "2026.08.29.1"));
    expect(outcome.mount.key).not.toContain("bundle-a");
  }));

  it("records a failed bundle rather than dropping it", () => withRoot((root) => {
    const empty = join(root, "not-a-bundle");
    mkdirSync(empty);
    const outcome = mountCorpus({ path: empty });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.diagnostics[0]?.code).toBe("MOUNT_LOAD_FAILED");
    expect(outcome.failure.diagnostics[0]?.context?.["bundleError"]).toBe("INDEX_MISSING");
  }));

  it("reads the namespace and default profile from prime-corpus.yaml", () => withRoot((root) => {
    const dir = bundle(root, "bundle-a", "org.example/alpha", "r1");
    const declaration = declarationAt(root, "pkg-a", "org.example/alpha");
    const outcome = mountCorpus({ path: dir, declarationRoot: declaration });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mount.declaredNamespace).toBe("org.example/alpha");
    expect(outcome.mount.defaultProfile).toBe("default");
    expect(outcome.mount.diagnostics).toEqual([]);
  }));

  it("adopts the declared namespace by default, and says which value it served", () => withRoot((root) => {
    // The live case at the moment of the cutover: the bundle's manifest still
    // says `compiled-v3-final` while the declaration says a formal namespace.
    // The declared value is what reaches a public prime:// URI now, and the
    // divergence is still reported so a stale artifact cannot hide.
    const dir = bundle(root, "bundle-a", "compiled-v3-final", "2026-08-29");
    const declaration = declarationAt(root, "pkg-a", "com.github.skill-wiki/frontend-design");
    const outcome = mountCorpus({ path: dir, declarationRoot: declaration });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mount.namespace).toBe("com.github.skill-wiki/frontend-design");
    expect(outcome.mount.declaredNamespace).toBe("com.github.skill-wiki/frontend-design");
    // The manifest's own value is kept, not overwritten: it is the evidence that
    // the bundle on disk was built from a different declaration.
    expect(outcome.mount.manifestCorpus).toBe("compiled-v3-final");
    expect(outcome.mount.key).toBe(corpusMountKey("com.github.skill-wiki/frontend-design", "2026-08-29"));
    const mismatch = outcome.mount.diagnostics.find(d => d.code === "MOUNT_NAMESPACE_MISMATCH");
    expect(mismatch?.severity).toBe("warning");
    expect(mismatch?.context?.["served"]).toBe("com.github.skill-wiki/frontend-design");
    expect(mismatch?.context?.["namespaceSource"]).toBe("declaration");
  }));

  it("stops warning once the manifest carries the declared namespace", () => withRoot((root) => {
    // What MOUNT_NAMESPACE_MISMATCH means after the cutover. Before it, the
    // manifest held a directory basename that could never match a formal
    // namespace, so the warning fired on every mount that read a declaration at
    // all — i.e. it reported "a declaration exists". Now the compiler stamps the
    // declared value, so a warning means the two authorities really disagree.
    const dir = bundle(root, "bundle-a", "com.github.skill-wiki/frontend-design", "2026-08-29");
    const declaration = declarationAt(root, "pkg-a", "com.github.skill-wiki/frontend-design");
    const outcome = mountCorpus({ path: dir, declarationRoot: declaration });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mount.namespace).toBe("com.github.skill-wiki/frontend-design");
    expect(outcome.mount.diagnostics).toEqual([]);
  }));

  it("keeps the manifest value verbatim, unchecked, only when asked", () => withRoot((root) => {
    const dir = bundle(root, "bundle-a", "compiled-v3-final", "2026-08-29");
    const declaration = declarationAt(root, "pkg-a", "com.github.skill-wiki/frontend-design");
    const kept = mountCorpus({ path: dir, declarationRoot: declaration }, { namespaceSource: "manifest" });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    // The escape hatch for reading a bundle whose identity predates the grammar.
    // `compiled-v3-final` fails NAMESPACE and is served anyway, which is the
    // whole point of the mode and the reason it is not the default.
    expect(kept.mount.namespace).toBe("compiled-v3-final");
    expect(kept.mount.diagnostics.find(d => d.code === "MOUNT_NAMESPACE_MISMATCH")?.context?.["served"])
      .toBe("compiled-v3-final");
  }));

  it("fails closed by default when nothing supplies a formal namespace", () => withRoot((root) => {
    // No declaration to draw from, and the manifest carries a directory basename.
    // Under the default there is no value here that may be published, so the
    // mount is rejected rather than quietly keyed on a renameable directory name.
    const dir = bundle(root, "bundle-a", "compiled-v3-final", "2026-08-29");
    const bare = mountCorpus({ path: dir });
    expect(bare.ok).toBe(false);
    if (bare.ok) return;
    expect(bare.failure.diagnostics[0]?.code).toBe("MOUNT_NAMESPACE_INVALID");
    expect(bare.failure.diagnostics[0]?.context?.["source"]).toBe("manifest");
  }));

  it("rejects a declaration that does not load", () => withRoot((root) => {
    const dir = bundle(root, "bundle-a", "org.example/alpha", "r1");
    const broken = join(root, "pkg-broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "prime-corpus.yaml"), "protocol: prime/corpus/v2\nnamespace: compiled-v3-final\n");
    const outcome = mountCorpus({ path: dir, declarationRoot: broken });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.diagnostics[0]?.code).toBe("MOUNT_DECLARATION_INVALID");
  }));
});

describe("CorpusRegistry", () => {
  it("mounts more than one corpus, which the single-PRIME_DIR shape forbade", () => withRoot((root) => {
    const { registry, failed } = CorpusRegistry.from([
      { path: bundle(root, "alpha", "org.example/alpha", "r1") },
      { path: bundle(root, "beta", "org.example/beta", "r1") },
    ]);
    expect(failed).toEqual([]);
    expect(registry.size).toBe(2);
    expect(registry.namespaces()).toEqual(["org.example/alpha", "org.example/beta"]);
    expect(registry.resolve("org.example/beta")?.release).toBe("r1");
  }));

  it("keeps two releases of one corpus mounted at once", () => withRoot((root) => {
    const { registry } = CorpusRegistry.from([
      { path: bundle(root, "alpha-r1", "org.example/alpha", "r1") },
      { path: bundle(root, "alpha-r2", "org.example/alpha", "r2") },
    ]);
    expect(registry.releasesOf("org.example/alpha")).toEqual(["r1", "r2"]);
    // Mount order must not repoint a namespace: the first mount stays active.
    expect(registry.activeRelease("org.example/alpha")).toBe("r1");
  }));

  it("rejects a duplicate identity instead of shadowing the first mount", () => withRoot((root) => {
    const { registry, failed } = CorpusRegistry.from([
      { path: bundle(root, "alpha", "org.example/alpha", "r1") },
      { path: bundle(root, "alpha-copy", "org.example/alpha", "r1") },
    ]);
    expect(registry.size).toBe(1);
    expect(failed[0]?.diagnostics[0]?.code).toBe("MOUNT_DUPLICATE");
  }));

  it("activates a mounted release and reports the displaced one", () => withRoot((root) => {
    const { registry } = CorpusRegistry.from([
      { path: bundle(root, "alpha-r1", "org.example/alpha", "r1") },
      { path: bundle(root, "alpha-r2", "org.example/alpha", "r2") },
    ]);
    const activated = registry.activate("org.example/alpha", "r2");
    expect(activated.ok).toBe(true);
    if (activated.ok) expect(activated.previous).toBe("r1");
    expect(registry.resolve("org.example/alpha")?.release).toBe("r2");
    // The displaced release is still resolvable, which is what makes §8.5's
    // "old runs remain replayable" true rather than merely representable.
    expect(registry.resolve("org.example/alpha", "r1")?.release).toBe("r1");
  }));

  it("refuses to activate a release that is not mounted", () => withRoot((root) => {
    const { registry } = CorpusRegistry.from([{ path: bundle(root, "alpha-r1", "org.example/alpha", "r1") }]);
    const outcome = registry.activate("org.example/alpha", "r9");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.diagnostic.code).toBe("MOUNT_NOT_FOUND");
    expect(registry.activeRelease("org.example/alpha")).toBe("r1");
  }));

  it("swaps in a new release atomically and keeps the old one replayable", () => withRoot((root) => {
    const { registry } = CorpusRegistry.from([{ path: bundle(root, "alpha-r1", "org.example/alpha", "r1") }]);
    const swapped = registry.swap({ path: bundle(root, "alpha-r2", "org.example/alpha", "r2") });
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    expect(swapped.mounted.release).toBe("r2");
    expect(swapped.previous?.release).toBe("r1");
    expect(registry.resolve("org.example/alpha")?.release).toBe("r2");
    expect(registry.resolve("org.example/alpha", "r1")).toBeDefined();
  }));

  it("leaves the active release untouched when a swap candidate fails its boot checks", () => withRoot((root) => {
    const { registry } = CorpusRegistry.from([{ path: bundle(root, "alpha-r1", "org.example/alpha", "r1") }]);
    const broken = join(root, "tampered");
    mkdirSync(broken);
    writeFileSync(join(broken, "_index.xml"), "<prime_index/>");
    writeFileSync(join(broken, "corpus.manifest.json"), JSON.stringify({
      protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "4",
      corpus: "org.example/alpha", release: "r2", sourceRevision: "git:abc", models: {},
      schemaDigest: digest("s"), contentDigest: digest("wrong"), indexDigest: digest("<prime_index/>"),
      createdAt: "2026-08-29T00:00:00Z",
    }));
    const swapped = registry.swap({ path: broken });
    expect(swapped.ok).toBe(false);
    expect(registry.resolve("org.example/alpha")?.release).toBe("r1");
    expect(registry.size).toBe(1);
  }));
});
