# Registry

A Prime registry is a small HTTP service that stores `.prime` source
files and serves them by id. The system repo ships **two** server
binaries with deliberately different scopes:

| Server | Where | Purpose |
|---|---|---|
| `scripts/registry-server.ts` | top-level script | Minimal stub for `publish`/`install` round-trip testing. Filesystem-backed, ~160 lines. |
| `packages/registry/` | full Hono app | The full registry — SQLite, search, ratings, dependents graph, web UI. |

Both speak the same primary `GET /atoms/<id>.prime` and
`PUT /atoms/<id>.prime` surface that the CLI talks to. Pick one based
on operational needs: the script is enough to round-trip; the package
is what you'd self-host for a team.

This page covers both, and the round-trip test that ties them together.

---

## HTTP routes (the contract that matters to the CLI)

The CLI (`prime publish`, `prime install --remote`) only needs four
routes. Both server flavors implement these:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/healthz` | `200 ok\n` |
| `GET` | `/atoms` | `200` JSON list of every id stored — `{ count, atoms: [...] }` |
| `GET` | `/atoms/<id>.prime` | `200` raw `.prime` body, or `404` if missing |
| `PUT` | `/atoms/<id>.prime` | `201` JSON `{ id, bytes }`, `401` if auth fails, `422` if body fails sanity |

Where `<id>` is the `@scope/kind-slug` form, e.g.
`@community/persona-stripe`.

The package server additionally exposes the richer routes:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/health` | JSON `{ status, timestamp }` |
| `GET` | `/api/search?q=&type=&tag=&limit=&offset=` | JSON `{ results, count }` |
| `GET` | `/api/primes/:name` | latest version metadata |
| `GET` | `/api/primes/:name/:version` | specific version |
| `GET` | `/api/primes/:name/download` | bumps download counter, returns `{ source, compiled }` |
| `GET` | `/api/primes/:name/graph` | `{ dependencies, links, reverseLinks }` |
| `GET` | `/api/primes/:name/dependents` | who depends on this atom |
| `POST` | `/api/primes` | publish (full record with tags, deps, links) |
| `POST` | `/api/primes/:name/rate` | `{ rating: 1..5 }` |

The CLI uses the `/atoms/<id>.prime` form in v1. The richer
`/api/primes/...` routes are consumed by the web UI and a future
v2 CLI.

---

## Auth

Both servers use a single Bearer token, set at startup via
`PRIME_REGISTRY_TOKEN`:

```bash
PRIME_REGISTRY_TOKEN=secret bun scripts/registry-server.ts
```

When set:

- `GET` requests are unauthenticated (registries are read-public by
  default)
- `PUT /atoms/<id>.prime` requires `Authorization: Bearer secret`,
  else `401`

If `PRIME_REGISTRY_TOKEN` is unset, **the registry is fully open** —
anyone can `PUT`. That's intentional for local dev and the round-trip
script; do not run an unprotected registry on a public host.

---

## SQLite schema (the package server)

`packages/registry/src/db.ts` initializes three tables on boot:

```sql
CREATE TABLE IF NOT EXISTS primes (
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Knowledge',
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',     -- JSON array string
  author      TEXT NOT NULL DEFAULT '',
  license     TEXT NOT NULL DEFAULT 'MIT',
  source      TEXT NOT NULL DEFAULT '',       -- raw .prime
  compiled    TEXT NOT NULL DEFAULT '',       -- compiled .md (optional)
  downloads   INTEGER NOT NULL DEFAULT 0,
  rating_sum  INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS dependencies (
  prime_name  TEXT NOT NULL,
  dep_name    TEXT NOT NULL,
  dep_version TEXT NOT NULL DEFAULT '*',
  PRIMARY KEY (prime_name, dep_name)
);

CREATE TABLE IF NOT EXISTS links (
  from_prime TEXT NOT NULL,
  to_prime   TEXT NOT NULL,
  link_type  TEXT NOT NULL DEFAULT 'related',
  PRIMARY KEY (from_prime, to_prime, link_type)
);
```

Notes:

- The primary key is `(name, version)` — multi-version coexists.
- `tags` is a JSON string, not a real array column. `LIKE '%"foo"%'`
  is used for tag filtering. Good enough at the scale a single team
  registry sees; switch to FTS5 if you grow past ~100k atoms.
- `dependencies` is intentionally separate from `links` —
  `dependencies` is hard `requires`-style, `links` carries the
  semantic edge type (related / enhances / conflicts / …).
- WAL mode and foreign keys are enabled on init.
- Storage path: `packages/registry/data/registry.db` (relative to the
  package).

The SQLite file is the only durable state — back it up, ship it
between hosts, anything you'd do with a normal `.db` file.

The script server (`scripts/registry-server.ts`) does **not** use
SQLite. It stores one `.prime` file per atom under
`<root>/<scope>/<name>.prime`. That tree is plain text — `rsync` it
anywhere, treat it as a static asset bucket if you like.

---

## Self-hosting

### Round-trip stub (the script)

```bash
# Defaults: port 7700, store ./registry-store, no auth
bun run scripts/registry-server.ts

# Pick port and storage path
bun run scripts/registry-server.ts --port 8080 --root /var/lib/prime-registry

# Require auth
PRIME_REGISTRY_TOKEN=secret bun run scripts/registry-server.ts
```

The script is the right thing to run when you want to test
`prime publish` / `prime install --remote` end-to-end without standing
up a real database. It boots in <100ms and stores raw `.prime` files
under `--root`. There is no UI. There is no rating system.

### Full registry (the package)

```bash
# From the system repo root
cd packages/registry
bun run src/index.ts
# → +------------------------------------------+
#   |   PRIME Registry — running on :3001      |
#   |   http://localhost:3001                  |
#   +------------------------------------------+
```

`PORT` env var overrides the default 3001. The web UI is served from
`packages/web/public`; with the package built, hitting `/` gives the
search UI.

For production, put it behind a TLS terminator (Caddy / nginx). The
service has no opinions about TLS.

---

## Push / pull from the CLI

The CLI talks to whichever server you point it at via
`--remote <url>` or the `PRIME_REGISTRY` env var.

**Push**:

```bash
$ PRIME_REGISTRY=http://localhost:7700 \
  PRIME_REGISTRY_TOKEN=secret \
  prime publish primes/@community/persona-stripe.prime

═══ Publishing persona-stripe.prime
  ✅  id:      @community/persona-stripe
  ✅  version: 1.0.0
  ✅  kind:    persona

  ⠋ PUT http://localhost:7700/atoms/@community/persona-stripe.prime
  ✅ Published!
```

**Pull**:

```bash
$ prime install @community/persona-stripe \
  --remote http://localhost:7700 \
  --dir /tmp/dest

  fetched  3 from http://localhost:7700
    + @community/persona-stripe
    + @community/rule-contrast-aaa
    + @community/pattern-card-elevated
```

`prime install --remote` recursively walks the dep graph: every
referenced id that's missing locally is fetched, and the new atom's
own deps are queued for fetch. Anything still missing after walking
returns a structured error listing 404s separately from local-missing
ids.

---

## The round-trip smoke test

`scripts/test-registry-roundtrip.sh` is the canonical end-to-end
test. It boots the script server, publishes one atom, lists `/atoms`,
installs into a clean directory with `--remote`, and verifies the
file landed on disk with non-zero bytes.

```bash
bash scripts/test-registry-roundtrip.sh
```

Expected output (last few lines):

```
==> verify file on disk
    OK — 4127 bytes at /tmp/prime-registry-roundtrip-dest/@community/persona-stripe.prime
==> all assertions passed
    (server log: /tmp/prime-registry-roundtrip.log)
```

The test:

1. Boots `bun scripts/registry-server.ts --port 7790 --root /tmp/prime-registry-roundtrip-store`.
2. Polls `/healthz` until ready.
3. `prime publish` of `primes-v3/sources/@community/persona-stripe.prime`.
4. `curl /atoms` and `grep` the id.
5. `prime install @community/persona-stripe --dir /tmp/dest --remote`.
6. The install **intentionally** exits non-zero — the published atom
   is one node in a 6-node sub-graph, so 5 deps return 404. The test
   only asserts that the requested atom landed on disk; the deps-404
   behavior is correct and expected.
7. Server is killed via `EXIT` trap.

If you change the publish/install code paths, run this script. CI runs
it on every push.

---

## Federation: multiple registries

Prime has no central registry. The CLI talks to whichever URL it's
given. Resolution order:

1. `--remote <url>` flag (highest precedence)
2. `PRIME_REGISTRY` env var
3. (no default — local-only mode)

A team can run their own registry, alongside or in place of any
public one. Atom ids are scoped (`@scope/name`); pick a scope your
team owns and there's no collision risk with anyone else's registry.

For mirroring (pulling atoms from one registry and re-publishing to
another):

```bash
# Crude but works
curl -sS http://upstream.example/atoms | jq -r '.atoms[]' | while read id; do
  curl -sS "http://upstream.example/atoms/${id}.prime" \
    | curl -sS -X PUT --data-binary @- \
        -H "Authorization: Bearer $PRIME_REGISTRY_TOKEN" \
        "http://your-registry.example/atoms/${id}.prime"
done
```

A first-class `prime mirror <upstream> <downstream>` verb is on the
roadmap, not built.

---

## What's NOT built yet

To stay honest:

- **Cross-registry search.** `prime search` hits a single endpoint
  (or local files). There is no federated search across multiple
  registries.
- **First-class mirror.** `prime mirror` doesn't exist. Use the
  shell loop above or copy the SQLite file.
- **Telemetry / audit log.** The package server writes nothing to
  describe who fetched what. Add it at the reverse-proxy layer if you
  need it.
- **Atom signing.** `.prime` files are not signed. If you care about
  provenance, run your own registry behind auth and verify against
  your team's private repo.
- **Conflict resolution on PUT.** A `PUT` overwrites the existing
  body. Versioned semantics (`PUT @scope/foo@1.0.0` vs `1.0.1`) are in
  the SQLite schema (`PRIMARY KEY (name, version)`), but the
  `/atoms/<id>.prime` shorthand only carries one slot per id.
- **Rate limiting.** Out of scope for the registry; add it at the
  proxy.
- **Tarball publishing.** Each atom is published individually.
  Bundles are explicitly out of scope for v1 — atom granularity is
  the protocol contract.

---

## Recipes

### Quick local registry, no auth

```bash
bun run scripts/registry-server.ts --port 7700 --root ~/prime-store
# In another terminal:
PRIME_REGISTRY=http://localhost:7700 prime publish primes/foo.prime
PRIME_REGISTRY=http://localhost:7700 prime install @scope/foo
```

### Team registry with auth

```bash
# On your team server
PRIME_REGISTRY_TOKEN=$(openssl rand -hex 32) \
  bun run scripts/registry-server.ts --port 7700 --root /var/lib/prime-store

# Distribute the token to teammates via your secret manager. Each member:
export PRIME_REGISTRY=https://prime.team.example
export PRIME_REGISTRY_TOKEN=...
prime publish primes/whatever.prime
```

### Backup / migrate

```bash
# Script server: it's just files
rsync -av /var/lib/prime-store/ backup-host:/var/lib/prime-store/

# Package server: it's a SQLite file
sqlite3 packages/registry/data/registry.db ".backup '/tmp/registry.db.bak'"
scp /tmp/registry.db.bak backup-host:/var/lib/prime-registry/
```

### Inspect what's on a registry

```bash
$ curl -sS http://localhost:7700/atoms | jq
{
  "count": 3,
  "atoms": [
    "@community/persona-stripe",
    "@community/rule-contrast-aaa",
    "@community/pattern-card-elevated"
  ]
}
```

### Healthcheck (for k8s / monitoring)

```bash
curl -fsS http://localhost:7700/healthz   # exit 0 iff "ok\n"
```

---

## See also

- `docs/cli.md` §Package commands — the `publish`/`install` flag table.
- `scripts/registry-server.ts` — the script server source. ~160 lines,
  worth reading.
- `packages/registry/src/` — the full registry. Hono + SQLite, ~500
  lines of TypeScript.
- `scripts/test-registry-roundtrip.sh` — the end-to-end smoke test.
