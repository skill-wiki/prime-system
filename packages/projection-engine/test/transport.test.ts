/**
 * The three transport semantics (plan §9.5) against a real bundle on disk, plus
 * the digest/token accounting that has to agree with the landed compiler.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentDigest,
  deliver,
  estimateTokens,
  negotiateTransport,
  resolveUriToPath,
} from "../src/transport.ts";
import type { ProjectionUri } from "../src/uri.ts";

const BODY = "level body with a MARKER-TOKEN inside\n";
const REL = "units/u-1/lv-wide.md";

let base: string;
let bundleRoot: string;

const uri: ProjectionUri = {
  tenant: "tenant-a",
  corpus: "cx",
  release: "r-1",
  unitId: "u-1",
  profile: "pf-one",
  level: "lv-wide",
};

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "prime-proj-transport-"));
  bundleRoot = join(base, "bundle");
  mkdirSync(join(bundleRoot, "units", "u-1"), { recursive: true });
  writeFileSync(join(bundleRoot, "units", "u-1", "lv-wide.md"), BODY, "utf8");
  mkdirSync(join(base, "outside"), { recursive: true });
  writeFileSync(join(base, "outside", "stolen.md"), "outside\n", "utf8");
  symlinkSync(join(base, "outside", "stolen.md"), join(bundleRoot, "units", "u-1", "escape.md"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("accounting matches the landed compiler", () => {
  test("digest is 'sha256:' + hex, same as atom-dir-emitter", () => {
    const expected = "sha256:" + createHash("sha256").update(BODY, "utf8").digest("hex");
    expect(contentDigest(BODY)).toBe(expected);
  });

  test("tokens are ceil(chars / 4), same as chunker.estimateTokens", () => {
    expect(estimateTokens(BODY)).toBe(Math.ceil(BODY.length / 4));
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("transport: path (local agent, pointer-first)", () => {
  test("returns a controlled absolute path and never the content", () => {
    const result = deliver("path", { bundleRoot, artifactPath: REL, uri });
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.transport === "path") {
      expect(result.payload.path.endsWith("lv-wide.md")).toBe(true);
      expect(Object.keys(result.payload)).not.toContain("content");
      expect(result.payload.tokens).toBe(estimateTokens(BODY));
    }
  });

  test("prefers compiler-supplied accounting when given", () => {
    const result = deliver("path", { bundleRoot, artifactPath: REL, uri }, {
      artifact: { tokens: 7, bytes: 99, digest: "sha256:from-meta" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.tokens).toBe(7);
      expect(result.payload.digest).toBe("sha256:from-meta");
    }
  });

  test("refuses to hand out a path for redacted content — the file is unredacted", () => {
    const result = deliver("path", { bundleRoot, artifactPath: REL, uri }, {
      overrideContent: "scrubbed",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TRANSPORT_UNSUPPORTED");
  });

  test("still refuses an escaping path", () => {
    const result = deliver("path", { bundleRoot, artifactPath: "units/u-1/escape.md", uri });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_ESCAPES_ROOT");
  });
});

describe("transport: inline (remote MCP)", () => {
  test("returns the content and no local path", () => {
    const result = deliver("inline", { bundleRoot, artifactPath: REL, uri });
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.transport === "inline") {
      expect(result.payload.content).toBe(BODY);
      expect(Object.keys(result.payload)).not.toContain("path");
      expect(result.payload.digest).toBe(contentDigest(BODY));
      expect(result.payload.bytes).toBe(Buffer.byteLength(BODY, "utf8"));
    }
  });

  test("recomputes accounting for redacted content instead of copying metadata", () => {
    const scrubbed = "level body with a [redacted] inside\n";
    const result = deliver("inline", { bundleRoot, artifactPath: REL, uri }, {
      overrideContent: scrubbed,
      artifact: { tokens: 999, bytes: 999, digest: "sha256:stale" },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.transport === "inline") {
      expect(result.payload.content).toBe(scrubbed);
      expect(result.payload.content).not.toContain("MARKER-TOKEN");
      expect(result.payload.digest).toBe(contentDigest(scrubbed));
      expect(result.payload.tokens).toBe(estimateTokens(scrubbed));
    }
  });

  test("refuses a traversal path", () => {
    const result = deliver("inline", { bundleRoot, artifactPath: "../outside/stolen.md", uri });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_TRAVERSAL");
  });
});

describe("transport: uri (§11.3)", () => {
  test("returns the resource URI, not a server-local path", () => {
    const result = deliver("uri", { bundleRoot, artifactPath: REL, uri });
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.transport === "uri") {
      expect(result.payload.uri).toBe("aoe://tenant-a/cx@r-1/units/u-1/projections/pf-one/lv-wide");
      expect(result.payload.uri).not.toContain(bundleRoot);
      expect(result.payload.tokens).toBe(estimateTokens(BODY));
    }
  });

  test("carries size and digest so a client can plan the fetch", () => {
    const result = deliver("uri", { bundleRoot, artifactPath: REL, uri });
    if (result.ok) {
      expect(result.payload.bytes).toBe(Buffer.byteLength(BODY, "utf8"));
      expect(result.payload.digest).toBe(contentDigest(BODY));
    }
  });
});

describe("resolveUriToPath (local adapter)", () => {
  test("resolves a URI back to a validated local path", () => {
    const result = resolveUriToPath(bundleRoot, uri, () => REL);
    expect(result.ok).toBe(true);
    if (result.ok && result.payload.transport === "path") {
      expect(result.payload.path.endsWith("lv-wide.md")).toBe(true);
    }
  });

  test("a locator returning an escaping path is refused, not honoured", () => {
    const result = resolveUriToPath(bundleRoot, uri, () => "units/u-1/escape.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_ESCAPES_ROOT");
  });

  test("a locator returning an absolute path is refused", () => {
    const result = resolveUriToPath(bundleRoot, uri, () => join(base, "outside", "stolen.md"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PATH_ABSOLUTE");
  });
});

describe("negotiateTransport", () => {
  test("honours the consumer's stated preference order", () => {
    expect(negotiateTransport(["uri", "inline"])).toBe("uri");
    expect(negotiateTransport(["inline", "uri"])).toBe("inline");
  });

  test("returns undefined when the consumer supports nothing", () => {
    expect(negotiateTransport([])).toBeUndefined();
  });
});
