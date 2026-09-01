#!/usr/bin/env bun
/**
 * scripts/registry-server.ts — minimal HTTP registry for `aoe install --remote`
 * and `prime publish --remote` round-trip testing.
 *
 * Endpoints:
 *
 *   GET  /atoms/<id>.prime          → 200 with raw .prime body
 *                                  → 404 if id not present
 *   PUT  /atoms/<id>.prime          → 201 with `{ id }` (overwrites)
 *                                  → 401 if AOE_REGISTRY_TOKEN set & header missing/wrong
 *                                  → 422 if body fails basic .prime sanity check
 *   GET  /atoms                     → 200 JSON list of every id stored
 *   GET  /healthz                   → 200 `ok`
 *
 * Storage: filesystem under `--root` (default ./registry-store/). One file
 * per atom: `<root>/<@scope>/<name>.prime`. The store is plain text — anyone
 * can rsync it elsewhere. This is intentionally a stub: it gives `install`
 * and `publish` something to talk to so the round-trip is testable, not a
 * production-grade registry.
 *
 * Usage:
 *   bun scripts/registry-server.ts                           # serve on :7700
 *   bun scripts/registry-server.ts --port 8080
 *   bun scripts/registry-server.ts --root /tmp/my-registry
 *   AOE_REGISTRY_TOKEN=secret bun scripts/registry-server.ts   # require auth
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname } from "path";

const argv = process.argv.slice(2);
const arg = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const PORT = parseInt(arg("--port", "7700"), 10);
const ROOT = arg("--root", "./registry-store");
const TOKEN = process.env.AOE_REGISTRY_TOKEN;

mkdirSync(ROOT, { recursive: true });

function listAllIds(): string[] {
  const out: string[] = [];
  function walk(dir: string, prefix: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      const s = statSync(f);
      if (s.isDirectory()) {
        walk(f, prefix ? `${prefix}/${e}` : e);
      } else if (e.endsWith(".prime")) {
        const name = e.slice(0, -".prime".length);
        out.push(prefix ? `${prefix}/${name}` : name);
      }
    }
  }
  walk(ROOT, "");
  return out;
}

/** Resolve a request path like `/atoms/@community/pattern-foo.prime` to a
 *  filesystem path under ROOT. Reject anything that escapes ROOT. */
function pathForId(id: string): string | null {
  // id should look like "@scope/kind-slug" — reject path traversal
  if (!id || id.includes("..") || !id.startsWith("@")) return null;
  return join(ROOT, `${id}.prime`);
}

function checkAuth(req: Request): { ok: true } | { ok: false; status: number; msg: string } {
  if (!TOKEN) return { ok: true };
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${TOKEN}`;
  if (auth !== expected) return { ok: false, status: 401, msg: "Bad or missing Authorization" };
  return { ok: true };
}

/** Sanity-check a `.prime` body before accepting. Doesn't run the parser
 *  (would import the parser package); instead, requires the basic structure
 *  every `.prime` file has: an `@<ns>/<id>` header line and an `id:` field. */
function validatePrimeBody(body: string, expectedId: string): { ok: true } | { ok: false; reason: string } {
  if (body.length === 0 || body.length > 200_000) {
    return { ok: false, reason: "body length out of bounds (0..200KB)" };
  }
  if (!body.includes("{")) return { ok: false, reason: "no opening brace — not a .prime file" };
  const idMatch = body.match(/^\s*id\s*:\s*"([^"]+)"/m);
  if (!idMatch) return { ok: false, reason: "no `id:` field" };
  if (idMatch[1] !== expectedId) {
    return { ok: false, reason: `id field says "${idMatch[1]}" but URL says "${expectedId}"` };
  }
  return { ok: true };
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health
    if (path === "/healthz") {
      return new Response("ok\n", { status: 200 });
    }

    // List
    if (path === "/atoms" && req.method === "GET") {
      const ids = listAllIds();
      return new Response(JSON.stringify({ count: ids.length, atoms: ids }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /atoms/<id>.prime
    if (path.startsWith("/atoms/") && path.endsWith(".prime") && req.method === "GET") {
      const id = path.slice("/atoms/".length, -".prime".length);
      const fsPath = pathForId(id);
      if (!fsPath || !existsSync(fsPath)) {
        return new Response(`atom "${id}" not found\n`, { status: 404 });
      }
      const body = readFileSync(fsPath, "utf-8");
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // PUT /atoms/<id>.prime
    if (path.startsWith("/atoms/") && path.endsWith(".prime") && req.method === "PUT") {
      const auth = checkAuth(req);
      if (!auth.ok) return new Response(auth.msg + "\n", { status: auth.status });

      const id = path.slice("/atoms/".length, -".prime".length);
      const fsPath = pathForId(id);
      if (!fsPath) {
        return new Response(`invalid id "${id}"\n`, { status: 400 });
      }
      const body = await req.text();
      const v = validatePrimeBody(body, id);
      if (!v.ok) {
        return new Response(`rejected: ${v.reason}\n`, { status: 422 });
      }
      mkdirSync(dirname(fsPath), { recursive: true });
      writeFileSync(fsPath, body, "utf-8");
      return new Response(JSON.stringify({ id, bytes: body.length }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found\n", { status: 404 });
  },
});

console.error(`[aoe-registry] listening on http://localhost:${server.port}`);
console.error(`[aoe-registry] storage: ${ROOT}`);
console.error(`[aoe-registry] auth: ${TOKEN ? "Bearer token required" : "open (set AOE_REGISTRY_TOKEN to require)"}`);
console.error(`[aoe-registry] try:  curl http://localhost:${server.port}/healthz`);
console.error(`[aoe-registry]        curl http://localhost:${server.port}/atoms`);
