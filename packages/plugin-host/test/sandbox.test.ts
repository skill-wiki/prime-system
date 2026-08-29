import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeCapabilities } from "../src/capabilities.ts";
import { collectingSink, type HostEvent } from "../src/events.ts";
import { createExecutor, ProcessSandboxExecutor, type CallResult } from "../src/executor/process.ts";
import { PluginHost } from "../src/host.ts";
import { loadManifest } from "../src/manifest.ts";
import { ECHO_SOURCE, ENV_PROBE_SOURCE, TEST_SCOPE, fetcherSource, readerSource, writePlugin } from "./helpers.ts";

/**
 * These tests spawn real OS processes and load real plugin modules. The escape
 * attempts are written *inside the plugin*, so what is asserted is the refusal a
 * hostile plugin actually receives — not the return value of a validator the
 * test called on the plugin's behalf.
 */

const base = mkdtempSync(join(tmpdir(), "plugin-host-sandbox-"));
const pluginRoot = join(base, "plugins");
const outside = mkdtempSync(join(tmpdir(), "plugin-host-sandbox-outside-"));
mkdirSync(pluginRoot, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "STOLEN-SECRET-VALUE\n");

const running: ProcessSandboxExecutor[] = [];

afterAll(async () => {
  for (const executor of running) await executor.shutdown();
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface Harness {
  readonly call: (method: string, params?: unknown) => Promise<CallResult>;
  readonly events: readonly HostEvent[];
  readonly shutdown: () => Promise<void>;
}

async function start(spec: Parameters<typeof writePlugin>[1], grants: readonly string[], fetcher?: (url: string) => Promise<string>): Promise<Harness> {
  const root = writePlugin(pluginRoot, spec);
  const loaded = loadManifest(root);
  if (!loaded.ok) throw new Error(`fixture: ${JSON.stringify(loaded.diagnostics)}`);
  const { sink, events } = collectingSink();
  const authorization = authorizeCapabilities(loaded.manifest.capabilities, grants);
  const executor = new ProcessSandboxExecutor({
    root: loaded.root,
    entryPath: loaded.entryPath,
    manifest: loaded.manifest,
    grants: authorization.grants,
    scope: TEST_SCOPE,
    sink,
    fetcher,
  });
  running.push(executor);
  await executor.start();
  return { call: (method, params) => executor.call(method, params), events, shutdown: () => executor.shutdown() };
}

/** The plugin's own answer, unwrapped, so a test reads what the plugin saw. */
function pluginSaw(result: CallResult): { ok: boolean; message?: string; content?: string; body?: string } {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value as { ok: boolean; message?: string };
}

describe("the process sandbox actually runs a plugin", () => {
  test("a plugin's method is dispatched into a separate process and answers", async () => {
    const harness = await start({ name: "echo", entrySource: ECHO_SOURCE }, []);
    const result = await harness.call("echo", { n: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ method: "echo", params: { n: 1 } });
    await harness.shutdown();
  });

  /**
   * The host's own environment is where API keys live. Inheriting it would put
   * every secret the host holds inside an untrusted process for free — and no
   * capability check would ever see it happen.
   */
  test("the host's environment is not inherited by the sandbox", async () => {
    process.env["PLUGIN_HOST_TEST_SECRET"] = "must-not-reach-the-child";
    const harness = await start({ name: "env-probe", entrySource: ENV_PROBE_SOURCE }, []);
    const result = await harness.call("env");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = (result.value as { keys: readonly string[] }).keys;
      expect(keys).not.toContain("PLUGIN_HOST_TEST_SECRET");
    }
    delete process.env["PLUGIN_HOST_TEST_SECRET"];
    await harness.shutdown();
  });
});

describe("sandbox escape attempts, made by the plugin itself", () => {
  test("escape 1 — '..' traversal out of the bundle is refused", async () => {
    const harness = await start({
      name: "escape-traversal",
      entrySource: readerSource("../../../etc/passwd"),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process", filesystem: { readRoots: ["templates"] } },
      extraFiles: { "templates/page.md": "inside\n" },
    }, ["filesystem:read"]);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("PATH_TRAVERSAL");
    expect(harness.events.some(e => e.kind === "plugin.effect.refused")).toBe(true);
    await harness.shutdown();
  });

  test("escape 2 — an absolute path is refused", async () => {
    const harness = await start({
      name: "escape-absolute",
      entrySource: readerSource(join(outside, "secret.txt")),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process", filesystem: { readRoots: ["templates"] } },
      extraFiles: { "templates/page.md": "inside\n" },
    }, ["filesystem:read"]);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("PATH_ABSOLUTE");
    await harness.shutdown();
  });

  test("escape 3 — a symlink out of the bundle is refused after realpath", async () => {
    const root = join(pluginRoot, "escape-symlink");
    const harness = await start({
      name: "escape-symlink",
      entrySource: readerSource("stolen.txt"),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process", filesystem: { readRoots: ["."] } },
      extraFiles: { "keep.md": "x\n" },
    }, ["filesystem:read"]);
    symlinkSync(join(outside, "secret.txt"), join(root, "stolen.txt"));
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("PATH_ESCAPES_ROOT");
    expect(JSON.stringify(saw)).not.toContain("STOLEN-SECRET-VALUE");
    await harness.shutdown();
  });

  test("escape 4 — a NUL byte in the requested path is refused", async () => {
    const harness = await start({
      name: "escape-nul",
      entrySource: readerSource("templates/page.md\0../../etc/passwd"),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process", filesystem: { readRoots: ["templates"] } },
      extraFiles: { "templates/page.md": "inside\n" },
    }, ["filesystem:read"]);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("PATH_NUL_BYTE");
    await harness.shutdown();
  });

  test("escape 5 — a sibling directory outside the declared read roots is refused", async () => {
    const harness = await start({
      name: "escape-sibling",
      entrySource: readerSource("private/key.pem"),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process", filesystem: { readRoots: ["templates"] } },
      extraFiles: { "templates/page.md": "inside\n", "private/key.pem": "PRIVATE-KEY-BYTES\n" },
    }, ["filesystem:read"]);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(JSON.stringify(saw)).not.toContain("PRIVATE-KEY-BYTES");
    await harness.shutdown();
  });

  /** Deny-by-default, exercised through the real mediation channel. */
  test("escape 6 — an undeclared capability cannot be exercised", async () => {
    const harness = await start({
      name: "escape-undeclared",
      entrySource: readerSource("templates/page.md"),
      capabilities: [],
      sandbox: { mode: "process", filesystem: { readRoots: ["templates"] } },
      extraFiles: { "templates/page.md": "inside\n" },
    }, ["filesystem:read"]);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("CAPABILITY_NOT_DECLARED");
    await harness.shutdown();
  });

  test("escape 7 — a declared but ungranted capability cannot be exercised", async () => {
    const harness = await start({
      name: "escape-ungranted",
      entrySource: readerSource("templates/page.md"),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process", filesystem: { readRoots: ["templates"] } },
      extraFiles: { "templates/page.md": "inside\n" },
    }, []);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("CAPABILITY_NOT_GRANTED");
    await harness.shutdown();
  });

  test("escape 8 — `filesystem: none` beats a granted read capability", async () => {
    const harness = await start({
      name: "escape-fs-none",
      entrySource: readerSource("templates/page.md"),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process" },
      extraFiles: { "templates/page.md": "inside\n" },
    }, ["filesystem:read"]);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("FILESYSTEM_NONE");
    await harness.shutdown();
  });

  test("escape 9 — a host outside the networkAllowlist is refused", async () => {
    const harness = await start({
      name: "escape-network",
      entrySource: fetcherSource("https://evil.example.net/exfil"),
      capabilities: ["network:https"],
      sandbox: { mode: "process", networkAllowlist: ["api.example.com"] },
    }, ["network:https"], async () => "never reached");
    const saw = pluginSaw(await harness.call("get"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("NETWORK_HOST_NOT_ALLOWLISTED");
    await harness.shutdown();
  });

  /** A suffix match would let this through. An exact match does not. */
  test("escape 10 — a near-miss hostname does not satisfy the allowlist", async () => {
    const harness = await start({
      name: "escape-network-near-miss",
      entrySource: fetcherSource("https://evil-api.example.com/exfil"),
      capabilities: ["network:https"],
      sandbox: { mode: "process", networkAllowlist: ["api.example.com"] },
    }, ["network:https"], async () => "never reached");
    const saw = pluginSaw(await harness.call("get"));
    expect(saw.ok).toBe(false);
    expect(saw.message).toContain("NETWORK_HOST_NOT_ALLOWLISTED");
    await harness.shutdown();
  });
});

describe("what the sandbox must still permit", () => {
  /**
   * The control for the escape suite. Without it every refusal above would also
   * pass if mediation simply refused everything, which is not confinement — it is
   * a broken feature.
   */
  test("a file inside a declared read root, with the capability granted, is readable", async () => {
    const harness = await start({
      name: "legit-read",
      entrySource: readerSource("page.md"),
      capabilities: ["filesystem:read"],
      sandbox: { mode: "process", filesystem: { readRoots: ["templates"] } },
      extraFiles: { "templates/page.md": "LEGITIMATE-CONTENT\n" },
    }, ["filesystem:read"]);
    const saw = pluginSaw(await harness.call("read"));
    expect(saw.ok).toBe(true);
    expect(saw.content).toContain("LEGITIMATE-CONTENT");
    await harness.shutdown();
  });

  test("an allowlisted host reaches the host's fetcher", async () => {
    const harness = await start({
      name: "legit-fetch",
      entrySource: fetcherSource("https://api.example.com/v1/ping"),
      capabilities: ["network:https"],
      sandbox: { mode: "process", networkAllowlist: ["api.example.com"] },
    }, ["network:https"], async url => `fetched:${url}`);
    const saw = pluginSaw(await harness.call("get"));
    expect(saw.ok).toBe(true);
    expect(saw.body).toBe("fetched:https://api.example.com/v1/ping");
    await harness.shutdown();
  });
});

describe("containment of a misbehaving plugin", () => {
  test("a plugin that never returns is killed at its declared timeout", async () => {
    const harness = await start({
      name: "hangs",
      entrySource: "export default { methods: [\"spin\"], handle() { return new Promise(() => {}); } };\n",
      sandbox: { mode: "process", timeoutMs: 300 },
    }, []);
    const result = await harness.call("spin");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CALL_TIMEOUT");
    await harness.shutdown();
  }, 10_000);

  test("a plugin that throws returns an error, not a crashed host", async () => {
    const harness = await start({
      name: "throws",
      entrySource: "export default { methods: [\"boom\"], handle() { throw new Error(\"plugin exploded\"); } };\n",
    }, []);
    const result = await harness.call("boom");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PLUGIN_THREW");
      expect(result.reason).toContain("plugin exploded");
    }
    await harness.shutdown();
  });
});

describe("an unsupported sandbox mode fails closed", () => {
  /**
   * The single most dangerous fallback available to a plugin host: running a
   * plugin that asked for stronger confinement in the host's own process because
   * the requested mode was unavailable.
   */
  test("a mode with no executor is refused, never downgraded to in-process", () => {
    const root = writePlugin(pluginRoot, { name: "wasi-plugin", entrySource: ECHO_SOURCE, sandbox: { mode: "wasi" } });
    const loaded = loadManifest(root);
    if (!loaded.ok) throw new Error("fixture");
    const created = createExecutor({
      root: loaded.root,
      entryPath: loaded.entryPath,
      manifest: loaded.manifest,
      grants: { granted: new Set(), declared: new Set() },
      scope: TEST_SCOPE,
      sink: () => {},
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe("SANDBOX_MODE_UNSUPPORTED");
  });
});

describe("PluginHost end to end — deny-by-default at every gate", () => {
  test("a host that accepts nothing runs nothing", async () => {
    const roots = join(base, "host-empty");
    mkdirSync(roots, { recursive: true });
    writePlugin(roots, { name: "wants-to-run", entrySource: ECHO_SOURCE });
    const host = new PluginHost({
      pluginRoots: [roots],
      dataRoots: [],
      acceptedProvides: [],
      capabilityGrants: {},
      signature: { requireSignature: false, algorithms: ["sha256"] },
      scope: TEST_SCOPE,
    });
    expect(host.discover()).toHaveLength(1);
    const activation = await host.activate("wants-to-run");
    expect(activation.ok).toBe(false);
    if (!activation.ok) {
      expect(activation.code).toBe("PROVIDES_NOT_ACCEPTED");
      expect(activation.at).toBe("dependencies-resolved");
    }
    const call = await host.call("wants-to-run", "echo", {});
    expect(call.ok).toBe(false);
    if (!call.ok) expect(call.code).toBe("PLUGIN_NOT_SERVING");
    await host.shutdownAll();
  });

  test("an accepted plugin reaches serving and can be called, then shut down", async () => {
    const roots = join(base, "host-accepting");
    mkdirSync(roots, { recursive: true });
    writePlugin(roots, { name: "accepted", entrySource: ECHO_SOURCE, provides: ["action-executor:test"] });
    const { sink, events } = collectingSink();
    const host = new PluginHost({
      pluginRoots: [roots],
      dataRoots: [],
      acceptedProvides: ["action-executor:test"],
      capabilityGrants: {},
      signature: { requireSignature: false, algorithms: ["sha256"] },
      scope: TEST_SCOPE,
      sink,
    });
    host.discover();
    const activation = await host.activate("accepted");
    expect(activation).toEqual({ ok: true });
    expect(host.stateOf("accepted")).toBe("serving");
    const call = await host.call("accepted", "echo", { hello: true });
    expect(call.ok).toBe(true);
    await host.shutdown("accepted");
    expect(host.stateOf("accepted")).toBe("stopped");
    expect(events.map(e => e.kind)).toContain("plugin.authorized");
    // Every event carries the full §12.4 key rather than a loose tenant field.
    expect(events.every(e => e.scopeKey.split("/").length === 7)).toBe(true);
  });

  test("a plugin whose files live in a corpus data root is rejected during discovery", () => {
    const roots = join(base, "host-overlap");
    const corpus = join(roots, "corpus");
    mkdirSync(corpus, { recursive: true });
    writePlugin(corpus, { name: "smuggled", entrySource: ECHO_SOURCE });
    const host = new PluginHost({
      pluginRoots: [roots],
      dataRoots: [corpus],
      acceptedProvides: ["action-executor:test"],
      capabilityGrants: {},
      signature: { requireSignature: false, algorithms: ["sha256"] },
      scope: TEST_SCOPE,
    });
    host.discover();
    expect(host.plugins).toHaveLength(0);
    expect(host.rejected.map(r => r.code)).toContain("PROVENANCE_INSIDE_DATA_ROOT");
  });

  test("an unresolved plugin dependency stops activation before authorization", async () => {
    const roots = join(base, "host-deps");
    mkdirSync(roots, { recursive: true });
    const root = writePlugin(roots, { name: "needs-friend", entrySource: ECHO_SOURCE });
    writeFileSync(join(root, "prime-plugin.yaml"), `${require("node:fs").readFileSync(join(root, "prime-plugin.yaml"), "utf8")}dependencies:\n  missing-friend: "^1.0.0"\n`);
    const host = new PluginHost({
      pluginRoots: [roots],
      dataRoots: [],
      acceptedProvides: ["action-executor:test"],
      capabilityGrants: {},
      signature: { requireSignature: false, algorithms: ["sha256"] },
      scope: TEST_SCOPE,
    });
    host.discover();
    const activation = await host.activate("needs-friend");
    expect(activation.ok).toBe(false);
    if (!activation.ok) {
      expect(activation.code).toBe("DEPENDENCY_UNRESOLVED");
      expect(activation.at).toBe("verified");
    }
  });
});
