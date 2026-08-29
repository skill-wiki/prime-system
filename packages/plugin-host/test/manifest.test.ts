import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/manifest.ts";

/** The §12.1 example verbatim, plus the `entry` the lifecycle needs. */
const EXAMPLE = `protocol: prime/plugin/v1
name: http-action-provider
version: 1.0.0
apiVersion: 2
entry: index.ts

provides:
  - action-executor:http

capabilities:
  - network:https
  - secrets:read:scoped

sandbox:
  mode: process
  filesystem: none
  networkAllowlist:
    - api.example.com
`;

function refusal(source: string): readonly string[] {
  const parsed = parseManifest(source);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return [];
  return parsed.diagnostics.map(d => d.message);
}

describe("PluginManifestSchema — the §12.1 example", () => {
  test("parses, with every field preserved", () => {
    const parsed = parseManifest(EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const m = parsed.manifest;
    expect(m.protocol).toBe("prime/plugin/v1");
    expect(m.name).toBe("http-action-provider");
    expect(m.apiVersion).toBe(2);
    expect(m.provides).toEqual(["action-executor:http"]);
    expect(m.capabilities).toEqual(["network:https", "secrets:read:scoped"]);
    expect(m.sandbox.mode).toBe("process");
    expect(m.sandbox.filesystem).toBe("none");
    expect(m.sandbox.networkAllowlist).toEqual(["api.example.com"]);
  });

  test("filesystem defaults to none and the allowlist to empty — the deny-by-default floor", () => {
    const parsed = parseManifest("protocol: prime/plugin/v1\nname: minimal\nversion: 0.1.0\napiVersion: 1\nentry: i.ts\nprovides:\n  - renderer:markdown\nsandbox:\n  mode: process\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.sandbox.filesystem).toBe("none");
    expect(parsed.manifest.sandbox.networkAllowlist).toEqual([]);
    expect(parsed.manifest.capabilities).toEqual([]);
  });

  test("`capabilities:` with nothing under it reads as no capabilities", () => {
    const parsed = parseManifest(EXAMPLE.replace("capabilities:\n  - network:https\n  - secrets:read:scoped", "capabilities:"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest.capabilities).toEqual([]);
  });
});

describe("PluginManifestSchema — what it refuses", () => {
  test("a wrong protocol is refused, so a v2 manifest cannot be read as v1", () => {
    expect(refusal(EXAMPLE.replace("prime/plugin/v1", "prime/plugin/v2")).join()).toContain("protocol");
  });

  test("an unknown field is refused rather than ignored", () => {
    expect(refusal(`${EXAMPLE}unexpected: true\n`).join()).toContain("unexpected");
  });

  test("a missing entry is refused, because the host must never infer one", () => {
    expect(refusal(EXAMPLE.replace("entry: index.ts\n", "")).join()).toContain("entry");
  });

  test("a missing sandbox block is refused, because there is no implicit sandbox", () => {
    expect(refusal(EXAMPLE.slice(0, EXAMPLE.indexOf("sandbox:"))).join()).toContain("sandbox");
  });

  test("an empty provides list is refused", () => {
    expect(refusal(EXAMPLE.replace("provides:\n  - action-executor:http", "provides: []")).join()).toContain("provides");
  });

  test("a malformed capability is refused at the manifest, not at first use", () => {
    expect(refusal(EXAMPLE.replace("network:https", "network")).join()).toContain("capabilities");
  });

  test("a non-SemVer version is refused", () => {
    expect(refusal(EXAMPLE.replace("version: 1.0.0", "version: v1")).join()).toContain("SemVer");
  });

  test("a signature block with a non-digest is refused", () => {
    expect(refusal(`${EXAMPLE}signature:\n  algorithm: ed25519\n  digest: not-a-digest\n  value: x\n`).join()).toContain("digest");
  });

  test("invalid YAML is a diagnostic, not a throw", () => {
    const parsed = parseManifest("protocol: [unclosed\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics[0]?.code).toBe("MANIFEST_YAML_INVALID");
  });

  test("a filesystem policy with an empty readRoots list is refused", () => {
    expect(refusal(EXAMPLE.replace("filesystem: none", "filesystem:\n    readRoots: []")).join()).toContain("readRoots");
  });
});
