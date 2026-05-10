import { Hono } from "hono";
import {
  getPrime,
  searchPrimes,
  publishPrime,
  incrementDownload,
  addRating,
  getGraph,
  getDependents,
} from "../db";

const primes = new Hono();

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
primes.get("/api/search", (c) => {
  const q = c.req.query("q");
  const type = c.req.query("type");
  const tag = c.req.query("tag");
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);

  const results = searchPrimes(q, type, tag, limit, offset);
  return c.json({ results, count: results.length });
});

// ---------------------------------------------------------------------------
// Publish (POST must be before GET routes)
// ---------------------------------------------------------------------------
primes.post("/api/primes", async (c) => {
  const body = await c.req.json();

  // Validate required fields
  const missing: string[] = [];
  if (!body.name) missing.push("name");
  if (!body.version) missing.push("version");
  if (!body.source) missing.push("source");
  if (!body.license) missing.push("license");
  if (missing.length) {
    return c.json({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
  }

  // Validate name format
  if (!/^[a-z0-9][a-z0-9\-]*$/.test(body.name)) {
    return c.json({ error: "Name must be lowercase alphanumeric with hyphens" }, 400);
  }

  const prime = publishPrime(body);
  return c.json(prime, 201);
});

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------
primes.post("/api/primes/:name/rate", async (c) => {
  const name = c.req.param("name");
  const prime = getPrime(name);
  if (!prime) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json();
  const rating = Number(body.rating);
  if (!rating || rating < 1 || rating > 5) {
    return c.json({ error: "Rating must be between 1 and 5" }, 400);
  }

  addRating(name, rating);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Download — MUST be before /:name/:version
// ---------------------------------------------------------------------------
primes.get("/api/primes/:name/download", (c) => {
  const name = c.req.param("name");
  const prime = getPrime(name);
  if (!prime) return c.json({ error: "Not found" }, 404);

  incrementDownload(name);
  return c.json({
    name: prime.name,
    version: prime.version,
    source: prime.source,
    compiled: prime.compiled,
  });
});

// ---------------------------------------------------------------------------
// Graph — MUST be before /:name/:version
// ---------------------------------------------------------------------------
primes.get("/api/primes/:name/graph", (c) => {
  const name = c.req.param("name");
  const prime = getPrime(name);
  if (!prime) return c.json({ error: "Not found" }, 404);
  const graph = getGraph(name);
  return c.json({ prime: prime.name, ...graph });
});

// ---------------------------------------------------------------------------
// Dependents — MUST be before /:name/:version
// ---------------------------------------------------------------------------
primes.get("/api/primes/:name/dependents", (c) => {
  const name = c.req.param("name");
  const prime = getPrime(name);
  if (!prime) return c.json({ error: "Not found" }, 404);
  const dependents = getDependents(name);
  return c.json({ prime: prime.name, dependents });
});

// ---------------------------------------------------------------------------
// Get prime (specific version) — after specific sub-routes
// ---------------------------------------------------------------------------
primes.get("/api/primes/:name/:version", (c) => {
  const { name, version } = c.req.param();
  const prime = getPrime(name, version);
  if (!prime) return c.json({ error: "Not found" }, 404);
  return c.json(prime);
});

// ---------------------------------------------------------------------------
// Get prime (latest) — must be last
// ---------------------------------------------------------------------------
primes.get("/api/primes/:name", (c) => {
  const name = c.req.param("name");
  const prime = getPrime(name);
  if (!prime) return c.json({ error: "Not found" }, 404);
  return c.json(prime);
});

export default primes;
