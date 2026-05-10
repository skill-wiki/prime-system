import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";

const DB_PATH = join(import.meta.dir, "../data/registry.db");

let db: Database;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initDB(): Database {
  mkdirSync(join(import.meta.dir, "../data"), { recursive: true });

  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS primes (
      name        TEXT NOT NULL,
      version     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'Knowledge',
      description TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '[]',
      author      TEXT NOT NULL DEFAULT '',
      license     TEXT NOT NULL DEFAULT 'MIT',
      source      TEXT NOT NULL DEFAULT '',
      compiled    TEXT NOT NULL DEFAULT '',
      downloads   INTEGER NOT NULL DEFAULT 0,
      rating_sum  INTEGER NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0,
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (name, version)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dependencies (
      prime_name  TEXT NOT NULL,
      dep_name    TEXT NOT NULL,
      dep_version TEXT NOT NULL DEFAULT '*',
      PRIMARY KEY (prime_name, dep_name)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      from_prime TEXT NOT NULL,
      to_prime   TEXT NOT NULL,
      link_type  TEXT NOT NULL DEFAULT 'related',
      PRIMARY KEY (from_prime, to_prime, link_type)
    );
  `);

  return db;
}

export function getDB(): Database {
  if (!db) initDB();
  return db;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrimeRow {
  name: string;
  version: string;
  type: string;
  description: string;
  tags: string;        // JSON array
  author: string;
  license: string;
  source: string;
  compiled: string;
  downloads: number;
  rating_sum: number;
  rating_count: number;
  published_at: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getPrime(name: string, version?: string): PrimeRow | null {
  const d = getDB();
  if (version) {
    return d.query<PrimeRow, [string, string]>(
      "SELECT * FROM primes WHERE name = ? AND version = ? LIMIT 1"
    ).get(name, version);
  }
  // latest version (highest published_at)
  return d.query<PrimeRow, [string]>(
    "SELECT * FROM primes WHERE name = ? ORDER BY published_at DESC LIMIT 1"
  ).get(name);
}

export function searchPrimes(
  q?: string,
  type?: string,
  tag?: string,
  limit = 50,
  offset = 0,
): PrimeRow[] {
  const d = getDB();
  const conditions: string[] = [];
  const params: any[] = [];

  if (q) {
    // Split query into words for multi-term matching
    const words = q.trim().toLowerCase().split(/\s+/);
    for (const word of words) {
      conditions.push("(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(author) LIKE ?)");
      const like = `%${word}%`;
      params.push(like, like, like, like);
    }
  }

  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  if (tag) {
    conditions.push("tags LIKE ?");
    params.push(`%"${tag}"%`);
  }

  let sql = "SELECT * FROM primes";
  if (conditions.length) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY downloads DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return d.query<PrimeRow, any[]>(sql).all(...params);
}

export function publishPrime(data: {
  name: string;
  version: string;
  type?: string;
  description?: string;
  tags?: string[];
  author?: string;
  license: string;
  source: string;
  compiled?: string;
  dependencies?: { name: string; version?: string }[];
  links?: { to: string; type: string }[];
}): PrimeRow {
  const d = getDB();

  d.query(`
    INSERT OR REPLACE INTO primes
      (name, version, type, description, tags, author, license, source, compiled, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    data.name,
    data.version,
    data.type ?? "Knowledge",
    data.description ?? "",
    JSON.stringify(data.tags ?? []),
    data.author ?? "",
    data.license,
    data.source,
    data.compiled ?? "",
  );

  // Dependencies
  if (data.dependencies?.length) {
    const depInsert = d.query(
      "INSERT OR REPLACE INTO dependencies (prime_name, dep_name, dep_version) VALUES (?, ?, ?)"
    );
    for (const dep of data.dependencies) {
      depInsert.run(data.name, dep.name, dep.version ?? "*");
    }
  }

  // Links
  if (data.links?.length) {
    const linkInsert = d.query(
      "INSERT OR REPLACE INTO links (from_prime, to_prime, link_type) VALUES (?, ?, ?)"
    );
    for (const link of data.links) {
      linkInsert.run(data.name, link.to, link.type);
    }
  }

  return getPrime(data.name, data.version)!;
}

export function incrementDownload(name: string): void {
  getDB().query("UPDATE primes SET downloads = downloads + 1 WHERE name = ?").run(name);
}

export function addRating(name: string, rating: number): void {
  if (rating < 1 || rating > 5) throw new Error("Rating must be between 1 and 5");
  getDB().query(
    "UPDATE primes SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE name = ?"
  ).run(rating, name);
}

// ---------------------------------------------------------------------------
// Graph & dependents
// ---------------------------------------------------------------------------

export function getGraph(name: string) {
  const d = getDB();
  const deps = d.query<{ dep_name: string; dep_version: string }, [string]>(
    "SELECT dep_name, dep_version FROM dependencies WHERE prime_name = ?"
  ).all(name);
  const links = d.query<{ to_prime: string; link_type: string }, [string]>(
    "SELECT to_prime, link_type FROM links WHERE from_prime = ?"
  ).all(name);
  const reverseLinks = d.query<{ from_prime: string; link_type: string }, [string]>(
    "SELECT from_prime, link_type FROM links WHERE to_prime = ?"
  ).all(name);
  return { dependencies: deps, links, reverseLinks };
}

export function getDependents(name: string) {
  return getDB().query<{ prime_name: string }, [string]>(
    "SELECT prime_name FROM dependencies WHERE dep_name = ?"
  ).all(name);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function trendingPrimes(limit = 20): PrimeRow[] {
  return getDB().query<PrimeRow, [number]>(
    "SELECT * FROM primes ORDER BY downloads DESC LIMIT ?"
  ).all(limit);
}

export function newPrimes(limit = 20): PrimeRow[] {
  return getDB().query<PrimeRow, [number]>(
    "SELECT * FROM primes ORDER BY published_at DESC LIMIT ?"
  ).all(limit);
}

export function counts() {
  const d = getDB();
  const totalPrimes = d.query<{ c: number }, []>("SELECT COUNT(DISTINCT name) as c FROM primes").get()!.c;
  const totalDownloads = d.query<{ c: number }, []>("SELECT COALESCE(SUM(downloads),0) as c FROM primes").get()!.c;
  const totalAuthors = d.query<{ c: number }, []>("SELECT COUNT(DISTINCT author) as c FROM primes WHERE author != ''").get()!.c;
  return { totalPrimes, totalDownloads, totalAuthors };
}
