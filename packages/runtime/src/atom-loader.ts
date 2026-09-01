/**
 * atom-loader.ts
 *
 * Projection-based runtime loader for AOE v3 atom directories.
 *
 * Responsibilities:
 *  - loadIndex(primeDir)              → parse _index.xml into GlobalIndex
 *  - loadAtomMeta(primeDir, atomId)   → read atom.yaml as AtomMeta
 *  - resolveProjection(...)           → return absolute path for a chunk
 *  - resolveCollection(...)           → return atom list + orchestration id
 *
 * IMPORTANT: This module NEVER reads chunks/*.md content.
 * It only reads _index.xml and atom.yaml (metadata).
 * Chunk content is exclusively for the agent to pull via the Read tool.
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single atom entry from _index.xml */
export interface GlobalIndexAtom {
  id: string;
  kind: string;
  tokens: number;
  quality: number;
  /** Short description text (inline content of the <atom> element) */
  description: string;
  /** ISO date when atom was deprecated. Undefined for active atoms. */
  deprecated_at?: string;
  /** Atom id that supersedes this one. */
  superseded_by?: string;
}

/** A cluster of related atoms in the global index */
export interface GlobalIndexCluster {
  name: string;
  density: number;
  atoms: GlobalIndexAtom[];
}

/** The parsed _index.xml */
export interface GlobalIndex {
  version: string;
  total: number;
  totalTokens: number;
  clusters: GlobalIndexCluster[];
  /** Flat list of *active* atoms (deprecated atoms are excluded). */
  atoms: GlobalIndexAtom[];
  /** Deprecated atoms (kept separate so callers can surface "use X instead" messages). */
  deprecated: GlobalIndexAtom[];
}

/** atom.yaml content */
export interface AtomMeta {
  id: string;
  kind: string;
  version: string;
  description: string;
  tags: string[];
  contentHash: string;
  tokens: { summary: number; core: number; full: number };
  projection: { summary: string; core: string; full: string };
  relations: Array<{ type: string; target: string }>;
  quality: Record<string, number>;
  /** Protocol-level redistribution terms emitted from UnitIR provenance. */
  license?: string;
  /** Additional JSON-compatible provenance attributes. */
  provenance?: Record<string, unknown>;
  /** ISO date when atom was deprecated. Undefined for active atoms. */
  deprecated_at?: string;
  /** Atom id that supersedes this one. */
  superseded_by?: string;
}

/** Result of resolveCollection */
export interface CollectionResolution {
  atomIds: string[];
  orchestration: string;
}

// ---------------------------------------------------------------------------
// Projection levels
// ---------------------------------------------------------------------------

export type ProjectionLevel = "summary" | "core" | "full";

// ---------------------------------------------------------------------------
// Internal: tiny XML parser for _index.xml
// ---------------------------------------------------------------------------
//
// We deliberately avoid pulling in an XML library dependency — the _index.xml
// schema is simple and self-contained. This parser handles exactly the schema
// defined in PRIME.md §6.3 and the task spec.

function parseIndexXml(xml: string): GlobalIndex {
  // Extract root attributes
  const rootMatch = xml.match(/<prime_index([^>]*)>/);
  const rootAttrs = rootMatch?.[1] ?? "";
  const version = attrVal(rootAttrs, "version") ?? "1.0";
  const total = parseInt(attrVal(rootAttrs, "total") ?? "0", 10);
  const totalTokens = parseInt(attrVal(rootAttrs, "total_tokens") ?? "0", 10);

  const clusters: GlobalIndexCluster[] = [];
  const allAtoms: GlobalIndexAtom[] = [];
  const deprecated: GlobalIndexAtom[] = [];

  // Extract cluster blocks
  const clusterRe = /<cluster([^>]*)>([\s\S]*?)<\/cluster>/g;
  let clusterMatch: RegExpExecArray | null;

  while ((clusterMatch = clusterRe.exec(xml)) !== null) {
    const clusterAttrStr = clusterMatch[1];
    const clusterBody = clusterMatch[2];

    const clusterName = attrVal(clusterAttrStr, "name") ?? "unnamed";
    const density = parseFloat(attrVal(clusterAttrStr, "density") ?? "0");

    const clusterAtoms: GlobalIndexAtom[] = [];

    // Extract atom elements inside cluster
    const atomRe = /<atom([^>]*)>([\s\S]*?)<\/atom>/g;
    let atomMatch: RegExpExecArray | null;

    while ((atomMatch = atomRe.exec(clusterBody)) !== null) {
      const atomAttrStr = atomMatch[1];
      const atomBody = atomMatch[2].trim();

      const id = attrVal(atomAttrStr, "id") ?? "";
      const kind = attrVal(atomAttrStr, "kind") ?? "unknown";
      const tokens = parseInt(attrVal(atomAttrStr, "tokens") ?? "0", 10);
      const quality = parseFloat(attrVal(atomAttrStr, "q") ?? "0");
      const depAt = attrVal(atomAttrStr, "deprecated_at");
      const supBy = attrVal(atomAttrStr, "superseded_by");

      if (!id) continue;

      const entry: GlobalIndexAtom = {
        id,
        kind,
        tokens,
        quality,
        description: atomBody,
        ...(depAt ? { deprecated_at: depAt } : {}),
        ...(supBy ? { superseded_by: supBy } : {}),
      };

      // Defensive: even if XML accidentally puts a deprecated atom inside a cluster,
      // route it to the deprecated bucket so retrieval never sees it.
      if (depAt) {
        deprecated.push(entry);
      } else {
        clusterAtoms.push(entry);
        allAtoms.push(entry);
      }
    }

    clusters.push({ name: clusterName, density, atoms: clusterAtoms });
  }

  // Extract <deprecated_atoms> block — these are emitted as self-closing
  // <atom id="..." deprecated_at="..." superseded_by="..."/>
  const depBlockMatch = xml.match(/<deprecated_atoms[^>]*>([\s\S]*?)<\/deprecated_atoms>/);
  if (depBlockMatch) {
    const depBody = depBlockMatch[1];
    const depAtomRe = /<atom\s+([\s\S]*?)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = depAtomRe.exec(depBody)) !== null) {
      const attrs = m[1];
      const id = attrVal(attrs, "id") ?? "";
      if (!id) continue;
      const depAt = attrVal(attrs, "deprecated_at") ?? "";
      const supBy = attrVal(attrs, "superseded_by");
      deprecated.push({
        id,
        kind: attrVal(attrs, "kind") ?? "unknown",
        tokens: 0,
        quality: 0,
        description: "",
        deprecated_at: depAt,
        ...(supBy ? { superseded_by: supBy } : {}),
      });
    }
  }

  return { version, total, totalTokens, clusters, atoms: allAtoms, deprecated };
}

/** Extract attribute value from an XML attribute string like `id="foo" kind="bar"` */
function attrVal(attrStr: string, name: string): string | undefined {
  // Match both single and double quotes
  const re = new RegExp(`${name}=["']([^"']*)["']`);
  const m = attrStr.match(re);
  return m?.[1];
}

// ---------------------------------------------------------------------------
// atom-id → filesystem path
// ---------------------------------------------------------------------------

/**
 * Resolve an atom id like "@community/method-modal-focus" to its directory path.
 * Atom ids are used directly as subdirectory paths under ${AOE_CORPUS_DIR}.
 */
function atomDir(primeDir: string, atomId: string): string {
  // @community/method-modal-focus → ${primeDir}/@community/method-modal-focus
  return join(primeDir, atomId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and parse _index.xml from the given AOE directory.
 * Returns a structured GlobalIndex object.
 * Throws if _index.xml is missing or unparseable.
 */
export function loadIndex(primeDir: string): GlobalIndex {
  const indexPath = join(primeDir, "_index.xml");
  if (!existsSync(indexPath)) {
    throw new Error(`_index.xml not found at ${indexPath}`);
  }
  const xml = readFileSync(indexPath, "utf-8");
  return parseIndexXml(xml);
}

/**
 * Load atom.yaml metadata for a single atom.
 * Returns a normalised AtomMeta object.
 * Throws if atom directory or atom.yaml is missing.
 *
 * NOTE: This intentionally NEVER reads chunks/*.md files.
 */
export function loadAtomMeta(primeDir: string, atomId: string): AtomMeta {
  const dir = atomDir(primeDir, atomId);
  const yamlPath = join(dir, "atom.yaml");

  if (!existsSync(yamlPath)) {
    throw new Error(`atom.yaml not found for atom "${atomId}" at ${yamlPath}`);
  }

  const raw = readFileSync(yamlPath, "utf-8");
  let data: Record<string, any>;
  try {
    data = parseYaml(raw) as Record<string, any>;
  } catch (err) {
    throw new Error(`Failed to parse atom.yaml for "${atomId}": ${err}`);
  }

  const lifecycle = (data.lifecycle && typeof data.lifecycle === "object") ? data.lifecycle : {};
  const deprecated_at = lifecycle.deprecated_at ?? data.deprecated_at;
  const superseded_by = lifecycle.superseded_by ?? data.superseded_by;

  // Normalise and return
  return {
    id: data.id ?? atomId,
    kind: data.kind ?? "unknown",
    version: data.version ?? "0.0.0",
    description: data.description ?? "",
    tags: Array.isArray(data.tags) ? data.tags : [],
    contentHash: data.content_hash ?? "",
    tokens: {
      summary: data.tokens?.summary ?? 0,
      core: data.tokens?.core ?? 0,
      full: data.tokens?.full ?? 0,
    },
    projection: {
      summary: data.projection?.summary ?? "chunks/summary.md",
      core: data.projection?.core ?? "chunks/core.md",
      full: data.projection?.full ?? "chunks/full.md",
    },
    relations: Array.isArray(data.relations)
      ? data.relations.map((r: any) => ({ type: r.type ?? "", target: r.target ?? "" }))
      : [],
    quality: typeof data.quality === "object" && data.quality !== null ? data.quality : {},
    ...(typeof data.license === "string" ? { license: data.license } : {}),
    ...(typeof data.provenance === "object" && data.provenance !== null ? { provenance: data.provenance as Record<string, unknown> } : {}),
    ...(deprecated_at ? { deprecated_at: String(deprecated_at) } : {}),
    ...(superseded_by ? { superseded_by: String(superseded_by) } : {}),
  };
}

/**
 * Resolve the absolute filesystem path for a chunk at the given projection level.
 *
 * The agent should use this path with the Read tool.
 * This function DOES NOT read the file.
 *
 * @param primeDir  - Root AOE directory (${AOE_CORPUS_DIR})
 * @param atomId    - Atom identifier, e.g. "@community/method-modal-focus"
 * @param level     - Projection level: "summary" | "core" | "full"
 * @returns Absolute path to the chunk file
 */
export function resolveProjection(
  primeDir: string,
  atomId: string,
  level: ProjectionLevel,
): string {
  const dir = atomDir(primeDir, atomId);
  const meta = loadAtomMeta(primeDir, atomId);
  const relativePath = meta.projection[level];
  return resolve(join(dir, relativePath));
}

/**
 * Resolve a collection: returns the list of atom IDs and the orchestration entry point.
 *
 * Collections can be stored as:
 *   ${AOE_CORPUS_DIR}/collections/<collection-slug>.yaml
 * or as an atom directory:
 *   ${AOE_CORPUS_DIR}/<collection-id>/atom.yaml  (where kind === "collection")
 *
 * @returns { atomIds, orchestration }
 */
export function resolveCollection(
  primeDir: string,
  collectionId: string,
): CollectionResolution {
  // Strategy 1: look for collections/<slug>.yaml
  // e.g. collectionId = "@community/collection-accessible-modal" → slug = "accessible-modal"
  const slug = collectionId.replace(/^@[^/]+\/collection-/, "").replace(/^@[^/]+\//, "");
  const yamlPath1 = join(primeDir, "collections", `${slug}.yaml`);

  // Strategy 2: look in atom directory (collection stored as atom.yaml)
  const yamlPath2 = join(primeDir, collectionId, "atom.yaml");

  let data: Record<string, any> | null = null;

  if (existsSync(yamlPath1)) {
    const raw = readFileSync(yamlPath1, "utf-8");
    data = parseYaml(raw) as Record<string, any>;
  } else if (existsSync(yamlPath2)) {
    const raw = readFileSync(yamlPath2, "utf-8");
    data = parseYaml(raw) as Record<string, any>;
  } else {
    throw new Error(
      `Collection "${collectionId}" not found. Tried:\n  ${yamlPath1}\n  ${yamlPath2}`,
    );
  }

  const includes: string[] = Array.isArray(data.includes) ? data.includes : [];
  const orchestration: string = data.orchestration ?? includes[0] ?? "";

  return { atomIds: includes, orchestration };
}
