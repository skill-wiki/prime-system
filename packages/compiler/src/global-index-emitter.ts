/**
 * @module global-index-emitter
 *
 * Emits the global `_index.xml` — the always-in-context L0 index that
 * agents load at boot (~200-500 tok for a 50-atom corpus).
 *
 * Format (PRIME.md §6.3):
 *
 *   <prime_index version="1.0" total="50" total_tokens="412">
 *     <cluster name="frontend-design" density="0.73">
 *       <atom id="@community/fact-wcag" kind="fact" tokens="142" q="4.7">
 *         Focus ring contrast must be ≥ 3:1 against adjacent colors
 *       </atom>
 *       ...
 *     </cluster>
 *     ...
 *   </prime_index>
 *
 * Each atom entry ≤ 50 tokens. Total should fit in 500 tokens for 50 atoms.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Minimal atom metadata for the global index.
 * Populated from atom.yaml after emitting each atom directory.
 */
export interface AtomMeta {
  id: string;
  kind: string;
  version: string;
  description: string;
  domain: string;
  tags: string[];
  tokens: {
    summary: number;
    core: number;
    full: number;
  };
  quality: string;
  /** atom-to-atom relations (compatible / conflicts / related / extends / etc.) */
  edges?: Array<{ type: string; target: string }>;
  /** ISO date when this atom was deprecated (PRIME-SPEC v1 §6) */
  deprecated_at?: string;
  /** ID of the atom that supersedes this one */
  superseded_by?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
const stableCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Truncate description to ~80 chars for index line */
function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Group atoms by domain, falling back to first tag, then "general" */
function groupByDomain(atoms: AtomMeta[]): Map<string, AtomMeta[]> {
  const map = new Map<string, AtomMeta[]>();
  for (const atom of atoms) {
    const key = atom.domain || atom.tags[0] || "general";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(atom);
  }
  return map;
}

/**
 * Compute cluster density: ratio of atoms in cluster that share ≥1 tag
 * with the cluster's most common tag. Simple heuristic.
 */
function computeDensity(atoms: AtomMeta[]): string {
  if (atoms.length <= 1) return "1.0";
  // Count tag co-occurrence
  const tagCount: Record<string, number> = {};
  for (const atom of atoms) {
    for (const tag of atom.tags) {
      tagCount[tag] = (tagCount[tag] || 0) + 1;
    }
  }
  const maxCount = Math.max(...Object.values(tagCount), 0);
  const density = maxCount / atoms.length;
  return Math.min(density, 1).toFixed(2);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the `_index.xml` corpus index.
 *
 * The writer that used to sit here (`emitGlobalIndex`) was removed with the
 * legacy atom-dir chain: a corpus index is one of the two artifacts a corpus
 * bundle commits atomically, so writing it belongs to
 * `bundle.finalizeCorpusBundle`, which is this builder's only caller.
 */
export function buildGlobalIndexXml(atoms: AtomMeta[]): string {
  // Split active vs deprecated atoms (PRIME-SPEC v1 §6)
  const activeAtoms = atoms.filter(a => !a.deprecated_at);
  const deprecatedAtoms = atoms.filter(a => !!a.deprecated_at);

  // Sort atoms deterministically by id
  const sorted = [...activeAtoms].sort((a, b) => stableCompare(a.id, b.id));

  const clusters = groupByDomain(sorted);
  // Sort cluster names deterministically
  const clusterNames = [...clusters.keys()].sort(stableCompare);

  const totalTokens = sorted.reduce((sum, a) => sum + (a.tokens.core || 0), 0);

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<prime_index version="1.0" total="${sorted.length}" total_tokens="${totalTokens}">`
  );

  for (const clusterName of clusterNames) {
    const clusterAtoms = clusters.get(clusterName)!;
    const density = computeDensity(clusterAtoms);
    // Sort atoms within cluster by id
    const sortedClusterAtoms = [...clusterAtoms].sort((a, b) => stableCompare(a.id, b.id));

    lines.push(`  <cluster name="${xmlEscape(clusterName)}" density="${density}">`);

    for (const atom of sortedClusterAtoms) {
      const desc = truncate(atom.description || atom.id);
      const hasEdges = atom.edges && atom.edges.length > 0;
      lines.push(
        `    <atom id="${xmlEscape(atom.id)}" kind="${xmlEscape(atom.kind)}" tokens="${atom.tokens.core}" q="${atom.quality}">`
      );
      lines.push(`      ${xmlEscape(desc)}`);
      if (hasEdges) {
        // Sort edges deterministically: by type, then target
        const sortedEdges = [...atom.edges!].sort((a, b) =>
          stableCompare(a.type, b.type) || stableCompare(a.target, b.target)
        );
        for (const e of sortedEdges) {
          lines.push(
            `      <edge type="${xmlEscape(e.type)}" target="${xmlEscape(e.target)}"/>`
          );
        }
      }
      lines.push(`    </atom>`);
    }

    lines.push(`  </cluster>`);
  }

  // Emit deprecated atoms section so agents know they exist but are stale
  if (deprecatedAtoms.length > 0) {
    const sortedDeprecated = [...deprecatedAtoms].sort((a, b) => stableCompare(a.id, b.id));
    lines.push(`  <deprecated_atoms count="${sortedDeprecated.length}">`);
    for (const atom of sortedDeprecated) {
      const supersede = atom.superseded_by ? ` superseded_by="${xmlEscape(atom.superseded_by)}"` : "";
      lines.push(
        `    <atom id="${xmlEscape(atom.id)}" deprecated_at="${xmlEscape(atom.deprecated_at!)}"${supersede}/>`
      );
    }
    lines.push(`  </deprecated_atoms>`);
  }

  lines.push(`</prime_index>`);

  return lines.join("\n") + "\n";
}
