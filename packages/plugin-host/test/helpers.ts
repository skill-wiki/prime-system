import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scope } from "../src/events.ts";
import { MANIFEST_FILENAME } from "../src/manifest.ts";

export const TEST_SCOPE: Scope = {
  tenant: "acme",
  workspace: "ws-1",
  corpus: "ops",
  release: "2026.08.1",
  unitId: "unit-7",
  version: "1.0.0",
  digest: "sha256:deadbeefdeadbeef",
};

export interface FixtureSpec {
  readonly name: string;
  readonly version?: string;
  readonly provides?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly sandbox?: Record<string, unknown>;
  readonly entry?: string;
  readonly entrySource: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
  /** Raw manifest override, for schema-refusal cases. */
  readonly manifestSource?: string;
}

/**
 * Writes a real plugin directory. The entry is a real module the real child
 * process really imports — a fake entry would make the sandbox suite assert that
 * the host formats argv correctly rather than that a plugin is confined.
 */
export function writePlugin(parentDir: string, spec: FixtureSpec): string {
  const root = join(parentDir, spec.name);
  mkdirSync(root, { recursive: true });
  const entry = spec.entry ?? "index.ts";
  const entryPath = join(root, entry);
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, spec.entrySource);
  for (const [rel, content] of Object.entries(spec.extraFiles ?? {})) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const manifest = spec.manifestSource ?? [
    "protocol: prime/plugin/v1",
    `name: ${spec.name}`,
    `version: ${spec.version ?? "1.0.0"}`,
    "apiVersion: 1",
    `entry: ${entry}`,
    "provides:",
    ...(spec.provides ?? ["action-executor:test"]).map(p => `  - ${p}`),
    ...((spec.capabilities ?? []).length === 0
      ? []
      : ["capabilities:", ...(spec.capabilities ?? []).map(c => `  - ${c}`)]),
    "sandbox:",
    ...Object.entries(spec.sandbox ?? { mode: "process" }).flatMap(([key, value]) => yamlEntry(key, value, 1)),
    "",
  ].join("\n");
  writeFileSync(join(root, MANIFEST_FILENAME), manifest);
  return root;
}

/**
 * `Array.isArray` is checked before `typeof === "object"`, which is the bug this
 * helper had first: an array *is* an object, so the object branch turned
 * `networkAllowlist: [a]` into `networkAllowlist: {0: a}` and every network test
 * failed on a fixture defect rather than on the code under test.
 */
function yamlEntry(key: string, value: unknown, depth: number): readonly string[] {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    return [`${pad}${key}:`, ...value.map(item => `${pad}  - ${String(item)}`)];
  }
  if (typeof value === "object" && value !== null) {
    return [`${pad}${key}:`, ...Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => yamlEntry(k, v, depth + 1))];
  }
  return [`${pad}${key}: ${String(value)}`];
}

/** A plugin that echoes its params. The baseline "nothing hostile" case. */
export const ECHO_SOURCE = `export default {
  methods: ["echo"],
  handle(method, params) { return { method, params }; },
};
`;

/**
 * A plugin that tries to read a path outside its bundle through the mediated
 * context. The escape attempt is in the plugin, not in the test, so the refusal
 * being asserted is the one a real hostile plugin would receive.
 */
export function readerSource(path: string): string {
  return `export default {
  methods: ["read"],
  async handle(method, params, ctx) {
    try { return { ok: true, content: await ctx.readFile(${JSON.stringify(path)}) }; }
    catch (error) { return { ok: false, message: String(error && error.message || error) }; }
  },
};
`;
}

export function fetcherSource(url: string): string {
  return `export default {
  methods: ["get"],
  async handle(method, params, ctx) {
    try { return { ok: true, body: await ctx.fetch(${JSON.stringify(url)}) }; }
    catch (error) { return { ok: false, message: String(error && error.message || error) }; }
  },
};
`;
}

/** Reads the host's own environment: the check that secrets are not inherited. */
export const ENV_PROBE_SOURCE = `export default {
  methods: ["env"],
  handle() { return { keys: Object.keys(process.env).sort() }; },
};
`;
