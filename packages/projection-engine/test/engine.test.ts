/**
 * End-to-end: catalog + routing + budget + redaction + transport + cache.
 *
 * The bundle on disk holds three levels for two units so the budget solver has
 * something real to degrade, and a symlink escape so the security path is
 * exercised through the full engine rather than only in the unit test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionEngine } from "../src/engine.ts";
import { ProjectionCatalog } from "../src/profile.ts";
import { ProjectionCache } from "../src/cache.ts";
import { atomLoaderAdapter } from "../src/adapters/atom-loader.ts";
import type { ProjectionRequest, PurposeRouting } from "../src/select.ts";
import type { RedactionPolicy } from "../src/redact.ts";
import type { ProjectionPayload } from "../src/transport.ts";
import { projectionDef, scope, str, unit } from "./fixtures.ts";

const BODIES: Readonly<Record<string, string>> = {
  "lv-thin": "thin\n",
  "lv-mid": "mid body of about fifty characters, give or take a few.\n",
  "lv-wide": "wide body mentioning SUPER-TOKEN-123 and quite a lot more text besides.\n",
};

let base: string;
let bundleRoot: string;

/** Mirrors what `runtime`'s atom.yaml holds: a level-name → relative-path map. */
const projectionMaps: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "u-1": { "lv-thin": "chunks/lv-thin.md", "lv-mid": "chunks/lv-mid.md", "lv-wide": "chunks/lv-wide.md" },
  "u-2": { "lv-thin": "chunks/lv-thin.md", "lv-mid": "chunks/lv-mid.md", "lv-wide": "chunks/lv-wide.md" },
  "u-evil": { "lv-thin": "chunks/escape.md", "lv-mid": "chunks/escape.md", "lv-wide": "chunks/escape.md" },
  "u-gap": { "lv-other": "chunks/lv-thin.md" },
};

const locate = atomLoaderAdapter({ loadMeta: (id) => {
  const projection = projectionMaps[id];
  return projection === undefined ? undefined : { projection };
} });

const catalog = ProjectionCatalog.fromDefinitions([
  projectionDef("pf-one/lv-thin", 50),
  projectionDef("pf-one/lv-mid", 200),
  projectionDef("pf-one/lv-wide", 800),
  // A custom profile with a level name the engine has never been told about.
  projectionDef("pf-tool/lv-sig", 30),
] as never);

const routing: PurposeRouting = {
  byPurpose: { "purpose-context": ["pf-one"], "purpose-signature": ["pf-tool"] },
  fallback: ["pf-one"],
};

function request(overrides: Partial<ProjectionRequest> = {}): ProjectionRequest {
  return {
    purpose: "purpose-context",
    budget: { maxTokens: 2000 },
    consumer: { transports: ["path"] },
    policy: { refs: ["pol-1"] },
    ...overrides,
  };
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "prime-proj-engine-"));
  bundleRoot = join(base, "bundle");
  for (const id of ["u-1", "u-2", "u-evil", "u-gap"]) {
    mkdirSync(join(bundleRoot, id, "chunks"), { recursive: true });
    for (const [level, body] of Object.entries(BODIES)) {
      writeFileSync(join(bundleRoot, id, "chunks", `${level}.md`), body, "utf8");
    }
  }
  mkdirSync(join(base, "outside"), { recursive: true });
  writeFileSync(join(base, "outside", "stolen.md"), "outside\n", "utf8");
  symlinkSync(join(base, "outside", "stolen.md"), join(bundleRoot, "u-evil", "chunks", "escape.md"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function engine(overrides: Partial<ConstructorParameters<typeof ProjectionEngine>[0]> = {}) {
  return new ProjectionEngine({ catalog, routing, bundleRoot, locate, ...overrides });
}

describe("ProjectionEngine — profile resolution from purpose", () => {
  test("routes a purpose to its profile via data", () => {
    const result = engine().project([unit({ identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" } })], request(), scope);
    expect(result.profile).toBe("pf-one");
  });

  test("routes a different purpose to a wholly custom profile", () => {
    const result = engine().project(
      [unit({ identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" } })],
      request({ purpose: "purpose-signature" }),
      scope,
    );
    expect(result.profile).toBe("pf-tool");
    // pf-tool only declares lv-sig, which u-1's projection map does not carry.
    expect(result.diagnostics.some((d) => d.code === "PROJECTION_ARTIFACT_MISSING")).toBe(true);
  });

  test("an unroutable purpose yields a diagnostic, not a throw", () => {
    const bare = new ProjectionEngine({ catalog, routing: { byPurpose: {} }, bundleRoot, locate });
    const result = bare.project([unit()], request({ purpose: "purpose-unknown" }), scope);
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("PROJECTION_PROFILE_UNRESOLVED");
    expect(result.diagnostics[0]?.severity).toBe("error");
  });

  test("a consumer with no transport is a programming error", () => {
    expect(() =>
      engine().project([unit()], request({ consumer: { transports: [] } }), scope),
    ).toThrow();
  });
});

describe("ProjectionEngine — the three transports end to end", () => {
  const u1 = unit({ identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" } });

  test("path: a local agent gets a controlled path", () => {
    const result = engine().project([u1], request({ consumer: { transports: ["path"] } }), scope);
    expect(result.transport).toBe("path");
    const payload = result.units[0]?.payload;
    expect(payload?.transport).toBe("path");
    // Compared against the realpath: on macOS the tmp root is itself a symlink
    // (/var → /private/var), and the engine returns the resolved form by design.
    if (payload?.transport === "path") expect(payload.path.startsWith(realpathSync(bundleRoot))).toBe(true);
  });

  test("inline: a remote MCP consumer gets content and no path", () => {
    const result = engine().project([u1], request({ consumer: { transports: ["inline"] } }), scope);
    const payload = result.units[0]?.payload;
    expect(payload?.transport).toBe("inline");
    if (payload?.transport === "inline") expect(payload.content).toBe(BODIES["lv-wide"]);
  });

  test("uri: a cross-environment consumer gets a aoe:// identity", () => {
    const result = engine().project([u1], request({ consumer: { transports: ["uri"] } }), scope);
    const payload = result.units[0]?.payload;
    expect(payload?.transport).toBe("uri");
    if (payload?.transport === "uri") {
      expect(payload.uri).toBe("aoe://tenant-a/cx@r-1/units/u-1/projections/pf-one/lv-wide");
      expect(payload.uri).not.toContain(bundleRoot);
    }
  });
});

describe("ProjectionEngine — consumer capability narrows the levels", () => {
  const u1 = unit({ identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" } });

  test("a per-unit token ceiling excludes the richer levels with a reason", () => {
    const result = engine().project(
      [u1],
      request({ consumer: { transports: ["inline"], maxTokensPerUnit: 60 } }),
      scope,
    );
    expect(result.units[0]?.level).toBe("lv-thin");
    const rejections = result.diagnostics.filter((d) => d.code === "PROJECTION_LEVEL_REJECTED");
    expect(rejections.length).toBe(2);
    expect(rejections[0]?.message).toContain("consumer ceiling");
  });
});

describe("ProjectionEngine — budget degradation is reported", () => {
  const u1 = unit({ identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" } });
  const u2 = unit({ identity: { id: "u-2", version: "1.0.0", digest: "sha256:u2", corpus: "cx" } });

  test("degrades both units to fit and says so", () => {
    const result = engine().project([u1, u2], request({ budget: { maxTokens: 400 } }), scope);
    expect(result.budget.consumedTokens).toBeLessThanOrEqual(400);
    expect(result.budget.degraded.length).toBe(2);
    expect(result.diagnostics.filter((d) => d.code === "PROJECTION_UNIT_DEGRADED").length).toBe(2);
  });

  test("drops a unit rather than truncating, with the reason in a warning", () => {
    const result = engine().project([u1, u2], request({ budget: { maxTokens: 60 } }), scope);
    expect(result.budget.dropped.length).toBe(1);
    const warning = result.diagnostics.find((d) => d.code === "PROJECTION_UNIT_DROPPED");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("60");
  });

  test("a unit whose projection map lacks every declared level is diagnosed", () => {
    const gap = unit({ identity: { id: "u-gap", version: "1.0.0", digest: "sha256:ug", corpus: "cx" } });
    const result = engine().project([gap], request(), scope);
    expect(result.units).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === "PROJECTION_ARTIFACT_MISSING")).toBe(true);
  });
});

describe("ProjectionEngine — security", () => {
  test("a unit whose artifact escapes the bundle is refused, not delivered", () => {
    const evil = unit({ identity: { id: "u-evil", version: "1.0.0", digest: "sha256:ue", corpus: "cx" } });
    const result = engine().project([evil], request({ consumer: { transports: ["inline"] } }), scope);
    expect(result.units).toEqual([]);
    const refusal = result.diagnostics.find((d) => d.code === "PROJECTION_DELIVERY_REFUSED");
    expect(refusal?.message).toContain("PATH_ESCAPES_ROOT");
  });

  test("secrets are scrubbed from inline content before it leaves the engine", () => {
    const redaction: RedactionPolicy = { rules: [{ label: "lbl-restricted", fields: ["fSecret"] }] };
    const carrier = unit({
      identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" },
      policyLabels: ["lbl-restricted"],
      fields: { fSecret: str("SUPER-TOKEN-123") },
    });
    const result = engine({ redaction }).project(
      [carrier],
      request({ consumer: { transports: ["inline"] } }),
      scope,
    );
    const payload = result.units[0]?.payload;
    expect(payload?.transport).toBe("inline");
    if (payload?.transport === "inline") {
      expect(payload.content).not.toContain("SUPER-TOKEN-123");
      expect(payload.content).toContain("[redacted]");
    }
    expect(result.units[0]?.redactedPaths).toEqual(["fSecret"]);
  });

  test("a redacted unit is not delivered as a path, because the file is unredacted", () => {
    const redaction: RedactionPolicy = { rules: [{ label: "lbl-restricted", fields: ["fSecret"] }] };
    const carrier = unit({
      identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" },
      policyLabels: ["lbl-restricted"],
      fields: { fSecret: str("SUPER-TOKEN-123") },
    });
    const result = engine({ redaction }).project(
      [carrier],
      request({ consumer: { transports: ["path"] } }),
      scope,
    );
    expect(result.units).toEqual([]);
    const refusal = result.diagnostics.find((d) => d.code === "PROJECTION_DELIVERY_REFUSED");
    expect(refusal?.message).toContain("TRANSPORT_UNSUPPORTED");
  });
});

describe("ProjectionEngine — cache isolation", () => {
  const u1 = unit({ identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" } });

  test("a second identical request is served from cache", () => {
    const shared = new ProjectionCache<ProjectionPayload>();
    const e = engine({ cache: shared });
    expect(e.project([u1], request(), scope).units[0]?.cacheKeyed).toBe(false);
    expect(e.project([u1], request(), scope).units[0]?.cacheKeyed).toBe(true);
    expect(shared.size).toBe(1);
  });

  test("another tenant does not hit the first tenant's entry", () => {
    const shared = new ProjectionCache<ProjectionPayload>();
    const e = engine({ cache: shared });
    e.project([u1], request(), scope);
    const other = e.project([u1], request(), { ...scope, tenant: "tenant-b" });
    expect(other.units[0]?.cacheKeyed).toBe(false);
    expect(shared.size).toBe(2);
  });

  test("another policy does not hit the first policy's entry", () => {
    const shared = new ProjectionCache<ProjectionPayload>();
    const e = engine({ cache: shared });
    e.project([u1], request(), scope);
    const other = e.project([u1], request({ policy: { refs: ["pol-2"] } }), scope);
    expect(other.units[0]?.cacheKeyed).toBe(false);
    expect(shared.size).toBe(2);
  });

  test("a different transport is a different entry — payload shapes differ", () => {
    const shared = new ProjectionCache<ProjectionPayload>();
    const e = engine({ cache: shared });
    e.project([u1], request({ consumer: { transports: ["inline"] } }), scope);
    const asUri = e.project([u1], request({ consumer: { transports: ["uri"] } }), scope);
    expect(asUri.units[0]?.payload.transport).toBe("uri");
    expect(shared.size).toBe(2);
  });
});

describe("atomLoaderAdapter", () => {
  test("indexes the projection map by the model's level name, not a fixed triple", () => {
    const path = locate(
      unit({ identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" } }),
      { profile: "pf-one", level: "lv-mid", definitionName: "pf-one/lv-mid", version: "1.0.0", targetTokens: 200, include: [], exclude: [], typeGroups: {}, rules: [], extensions: {} },
    );
    expect(path).toBe("u-1/chunks/lv-mid.md");
  });

  test("returns undefined for an unknown unit instead of throwing", () => {
    const path = locate(
      unit({ identity: { id: "u-absent", version: "1.0.0", digest: "x", corpus: "cx" } }),
      { profile: "pf-one", level: "lv-mid", definitionName: "pf-one/lv-mid", version: "1.0.0", targetTokens: 200, include: [], exclude: [], typeGroups: {}, rules: [], extensions: {} },
    );
    expect(path).toBeUndefined();
  });

  test("a throwing loader is contained", () => {
    const throwing = atomLoaderAdapter({ loadMeta: () => { throw new Error("io"); } });
    const path = throwing(unit(), { profile: "p", level: "l", definitionName: "p/l", version: "1.0.0", targetTokens: 1, include: [], exclude: [], typeGroups: {}, rules: [], extensions: {} });
    expect(path).toBeUndefined();
  });
});
