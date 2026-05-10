import { Hono } from "hono";
import { cors } from "hono/cors";
import { initDB } from "./db";
import primesRoutes from "./routes/primes";
import statsRoutes from "./routes/stats";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

// Initialize database on startup
initDB();

const app = new Hono();

// Static file directory (absolute path)
const WEB_ROOT = join(import.meta.dir, "../../web/public");

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use("*", cors());

// ---------------------------------------------------------------------------
// API routes (must be before static files)
// ---------------------------------------------------------------------------
app.route("/", primesRoutes);
app.route("/", statsRoutes);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Static file serving — web frontend
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

function serveFile(filePath: string): Response | null {
  if (!existsSync(filePath)) return null;
  try {
    const stats = require("fs").statSync(filePath);
    if (stats.isDirectory()) return null;
  } catch { return null; }
  const ext = filePath.substring(filePath.lastIndexOf("."));
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);
  return new Response(content, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=60" },
  });
}

// Serve static files, fallback to index.html
app.get("*", (c) => {
  const urlPath = new URL(c.req.url).pathname;

  // Try exact file match
  const filePath = join(WEB_ROOT, urlPath);
  const fileRes = serveFile(filePath);
  if (fileRes) return fileRes;

  // Fallback to index.html for SPA-like routes
  const indexPath = join(WEB_ROOT, "index.html");
  const indexRes = serveFile(indexPath);
  if (indexRes) return indexRes;

  return c.text("Not Found", 404);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT ?? 3001);

console.log(`
+------------------------------------------+
|   PRIME Registry — running on :${port}      |
|   http://localhost:${port}                  |
|   Static files: ${WEB_ROOT}  |
+------------------------------------------+
`);

export default {
  port,
  fetch: app.fetch,
};
