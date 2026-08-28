import type { SnapshotRef } from "@skill-wiki/runtime";

export interface QueryResult {
  id: string;
  kind: string;
  description: string;
  tokens: number;
  level: "summary" | "core" | "full";
  /** Existing local-adapter compatibility field. */
  path: string;
}
export interface QueryResponseResult extends QueryResult { resource_uri: string; }

export interface PrimeQueryResponse {
  results: QueryResponseResult[];
  total_index_tokens: number;
  snapshot: SnapshotRef;
}

/** Pure response formatter: suitable for transport-independent tests. */
export function createPrimeQueryResponse(
  snapshot: SnapshotRef,
  results: QueryResult[],
  totalIndexTokens: number,
): PrimeQueryResponse {
  return { results: results.map((result) => ({ ...result, resource_uri: createPrimeResourceUri(snapshot, result.id, result.level) })), total_index_tokens: totalIndexTokens, snapshot };
}

function encodeSegment(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
export function createPrimeResourceUri(snapshot: SnapshotRef, unitId: string, level: QueryResult["level"]): string {
  return `prime://corpus/${encodeSegment(snapshot.corpus)}/releases/${encodeSegment(snapshot.release)}/units/${encodeSegment(unitId)}/projections/${encodeSegment(level)}`;
}
