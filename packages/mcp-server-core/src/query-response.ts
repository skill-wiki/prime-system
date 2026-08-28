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

export interface PrimeQueryResponse {
  results: QueryResult[];
  total_index_tokens: number;
  snapshot: SnapshotRef;
}

/** Pure response formatter: suitable for transport-independent tests. */
export function createPrimeQueryResponse(
  snapshot: SnapshotRef,
  results: QueryResult[],
  totalIndexTokens: number,
): PrimeQueryResponse {
  return { results, total_index_tokens: totalIndexTokens, snapshot };
}
