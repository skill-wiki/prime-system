import { Hono } from "hono";
import { trendingPrimes, newPrimes, counts } from "../db";

const stats = new Hono();

// GET /api/stats/trending — Top 20 by downloads
stats.get("/api/stats/trending", (c) => {
  const limit = Number(c.req.query("limit") ?? 20);
  return c.json({ results: trendingPrimes(limit) });
});

// GET /api/stats/new — Latest 20 published
stats.get("/api/stats/new", (c) => {
  const limit = Number(c.req.query("limit") ?? 20);
  return c.json({ results: newPrimes(limit) });
});

// GET /api/stats/counts — Totals
stats.get("/api/stats/counts", (c) => {
  return c.json(counts());
});

export default stats;
