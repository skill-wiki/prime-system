import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, MANIFEST_FILENAME } from "../src/manifest.ts";
import { PluginDigestRegistry, checkProvenance, computePluginDigest, verifyPluginSignature } from "../src/trust.ts";
import { ECHO_SOURCE, writePlugin } from "./helpers.ts";

const base = mkdtempSync(join(tmpdir(), "plugin-host-trust-"));
const pluginRoot = join(base, "plugins");
const dataRoot = join(base, "corpus");
mkdirSync(pluginRoot, { recursive: true });
mkdirSync(dataRoot, { recursive: true });

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("Model/Corpus data cannot implicitly gain code execution (§12.3)", () => {
  /**
   * The decisive case. This directory is a *valid* plugin in every respect —
   * correct protocol, real entry, well-formed capabilities. The only thing wrong
   * with it is where it lives. If provenance were enforced by inspecting content
   * rather than location, this would load.
   */
  test("a valid plugin sitting inside a corpus data root is refused", () => {
    const inCorpus = writePlugin(dataRoot, { name: "corpus-smuggled", entrySource: ECHO_SOURCE });
    const loaded = loadManifest(inCorpus);
    expect(loaded.ok).toBe(true); // the manifest itself is fine, which is the point

    const decision = checkProvenance(inCorpus, { pluginRoots: [pluginRoot, dataRoot], dataRoots: [dataRoot] });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("PROVENANCE_INSIDE_DATA_ROOT");
  });

  test("an overlapping declaration resolves towards refusal", () => {
    const nested = join(dataRoot, "nested");
    mkdirSync(nested, { recursive: true });
    const decision = checkProvenance(nested, { pluginRoots: [base], dataRoots: [dataRoot] });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("PROVENANCE_INSIDE_DATA_ROOT");
  });

  /**
   * Provenance is compared after `realpath`, so a link from the plugin root into
   * the corpus does not launder the corpus directory into a plugin directory.
   */
  test("a symlink from a plugin root into the data root does not launder provenance", () => {
    const smuggled = writePlugin(dataRoot, { name: "linked", entrySource: ECHO_SOURCE });
    const link = join(pluginRoot, "looks-legit");
    symlinkSync(smuggled, link);
    const decision = checkProvenance(link, { pluginRoots: [pluginRoot], dataRoots: [dataRoot] });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("PROVENANCE_INSIDE_DATA_ROOT");
  });

  test("a directory under no declared plugin root is refused", () => {
    const loose = mkdtempSync(join(tmpdir(), "plugin-host-loose-"));
    const decision = checkProvenance(loose, { pluginRoots: [pluginRoot], dataRoots: [] });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe("PROVENANCE_NOT_IN_PLUGIN_ROOT");
    rmSync(loose, { recursive: true, force: true });
  });

  test("a directory under a declared plugin root is accepted", () => {
    const legit = writePlugin(pluginRoot, { name: "legit", entrySource: ECHO_SOURCE });
    expect(checkProvenance(legit, { pluginRoots: [pluginRoot], dataRoots: [dataRoot] }).ok).toBe(true);
  });
});

describe("entry containment (§12.3 applied to the one path that becomes code)", () => {
  test("an entry escaping the plugin root is refused at load", () => {
    const root = writePlugin(pluginRoot, { name: "escaping-entry", entrySource: ECHO_SOURCE });
    writeFileSync(join(root, MANIFEST_FILENAME), readFileSync(join(root, MANIFEST_FILENAME), "utf8").replace("entry: index.ts", "entry: ../legit/index.ts"));
    const loaded = loadManifest(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.diagnostics[0]?.code).toBe("ENTRY_PATH_TRAVERSAL");
  });

  test("an absolute entry is refused", () => {
    const root = writePlugin(pluginRoot, { name: "absolute-entry", entrySource: ECHO_SOURCE });
    writeFileSync(join(root, MANIFEST_FILENAME), readFileSync(join(root, MANIFEST_FILENAME), "utf8").replace("entry: index.ts", "entry: /etc/passwd"));
    const loaded = loadManifest(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.diagnostics[0]?.code).toBe("ENTRY_PATH_ABSOLUTE");
  });

  test("a declared filesystem read root escaping the bundle is refused", () => {
    const root = writePlugin(pluginRoot, {
      name: "escaping-fs-root",
      entrySource: ECHO_SOURCE,
      sandbox: { mode: "process", filesystem: { readRoots: ["../legit"] } },
    });
    const loaded = loadManifest(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.diagnostics[0]?.code).toBe("FILESYSTEM_ROOT_PATH_TRAVERSAL");
  });
});

describe("signature verification precedes everything (§12.2 step 2)", () => {
  test("an unsigned plugin is refused when the host requires a signature", () => {
    const root = writePlugin(pluginRoot, { name: "unsigned", entrySource: ECHO_SOURCE });
    const loaded = loadManifest(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const result = verifyPluginSignature(root, loaded.manifest, { requireSignature: true, algorithms: ["sha256"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_MISSING");
  });

  test("an unsigned plugin passes when the host does not require one", () => {
    const root = writePlugin(pluginRoot, { name: "unsigned-ok", entrySource: ECHO_SOURCE });
    const loaded = loadManifest(root);
    if (!loaded.ok) throw new Error("fixture");
    expect(verifyPluginSignature(root, loaded.manifest, { requireSignature: false, algorithms: ["sha256"] }).ok).toBe(true);
  });

  test("a correct digest verifies, and tampering with one byte breaks it", () => {
    const root = writePlugin(pluginRoot, { name: "signed", entrySource: ECHO_SOURCE });
    const digest = computePluginDigest(root);
    writeFileSync(
      join(root, MANIFEST_FILENAME),
      `${readFileSync(join(root, MANIFEST_FILENAME), "utf8")}signature:\n  algorithm: ed25519\n  digest: ${digest}\n  value: not-a-real-signature\n`,
    );
    const loaded = loadManifest(root);
    if (!loaded.ok) throw new Error(`fixture: ${JSON.stringify(loaded.diagnostics)}`);
    expect(verifyPluginSignature(root, loaded.manifest, { requireSignature: true, algorithms: ["sha256"] }).ok).toBe(true);

    writeFileSync(join(root, "index.ts"), `${ECHO_SOURCE}// tampered\n`);
    const tampered = verifyPluginSignature(root, loaded.manifest, { requireSignature: true, algorithms: ["sha256"] });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.code).toBe("SIGNATURE_DIGEST_MISMATCH");
  });

  test("an unsupported digest algorithm is refused, not attempted", () => {
    const root = writePlugin(pluginRoot, { name: "weird-alg", entrySource: ECHO_SOURCE });
    writeFileSync(
      join(root, MANIFEST_FILENAME),
      `${readFileSync(join(root, MANIFEST_FILENAME), "utf8")}signature:\n  algorithm: rot13\n  digest: rot13:00112233445566778899\n  value: x\n`,
    );
    const loaded = loadManifest(root);
    if (!loaded.ok) throw new Error("fixture");
    const result = verifyPluginSignature(root, loaded.manifest, { requireSignature: true, algorithms: ["sha256"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_ALGORITHM_UNSUPPORTED");
  });
});

describe("Registry 同版本不同 digest 必须拒绝 (§12.3)", () => {
  test("a second digest for the same version is refused", () => {
    const registry = new PluginDigestRegistry();
    expect(registry.record("http", "1.0.0", "sha256:aaaa").ok).toBe(true);
    const conflict = registry.record("http", "1.0.0", "sha256:bbbb");
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("REGISTRY_DIGEST_CONFLICT");
    expect(registry.digestOf("http", "1.0.0")).toBe("sha256:aaaa");
  });

  test("the same digest twice is idempotent, and a new version is fine", () => {
    const registry = new PluginDigestRegistry();
    registry.record("http", "1.0.0", "sha256:aaaa");
    expect(registry.record("http", "1.0.0", "sha256:aaaa").ok).toBe(true);
    expect(registry.record("http", "1.1.0", "sha256:bbbb").ok).toBe(true);
  });
});

describe("computePluginDigest", () => {
  test("moving a file changes the digest even when the bytes are identical", () => {
    const a = writePlugin(pluginRoot, { name: "digest-a", entrySource: ECHO_SOURCE, extraFiles: { "t/x.md": "same" } });
    const b = writePlugin(pluginRoot, { name: "digest-b", entrySource: ECHO_SOURCE, extraFiles: { "u/x.md": "same" } });
    expect(computePluginDigest(a)).not.toBe(computePluginDigest(b));
  });

  test("the digest is stable across repeated computation", () => {
    const root = writePlugin(pluginRoot, { name: "digest-stable", entrySource: ECHO_SOURCE });
    expect(computePluginDigest(root)).toBe(computePluginDigest(root));
  });
});
