import type { SnapshotRef } from "@skill-wiki/runtime";
import { formatProjectionUri } from "@skill-wiki/projection-engine";

/**
 * One delivered projection.
 *
 * `path` and `content` are mutually exclusive and both optional because §9.5 is
 * explicit that pointer-first cannot be the only transport: a remote consumer
 * receives `content` or the `resource_uri`, never a server-local path. `level`
 * and `profile` are strings rather than a union — the level names are Model
 * Package data, and a union here would re-close the set the model owns.
 */
export interface QueryResult {
  id: string;
  kind: string;
  description: string;
  /** Token cost of the delivered payload at this level, not of the whole unit. */
  tokens: number;
  level: string;
  profile: string;
  transport: "path" | "inline" | "uri";
  bytes: number;
  digest: string;
  /** Local-adapter transport only. */
  path?: string;
  /** Inline transport only. */
  content?: string;
}

export interface QueryResponseResult extends QueryResult {
  resource_uri: string;
}

export interface PrimeQueryResponse {
  results: QueryResponseResult[];
  total_index_tokens: number;
  snapshot: SnapshotRef;
  /** Non-fatal findings; a silent drop is unexplainable (§3.6). */
  diagnostics: readonly { code: string; message: string; severity: string }[];
}

export interface ResourceIdentity {
  readonly tenant: string;
  readonly corpus: string;
  readonly release: string;
}

/** Pure response formatter: suitable for transport-independent tests. */
export function createPrimeQueryResponse(
  snapshot: SnapshotRef,
  identity: ResourceIdentity,
  results: readonly QueryResult[],
  totalIndexTokens: number,
  diagnostics: readonly { code: string; message: string; severity: string }[] = [],
): PrimeQueryResponse {
  return {
    results: results.map((result) => ({
      ...result,
      resource_uri: createPrimeResourceUri(identity, result.id, result.profile, result.level),
    })),
    total_index_tokens: totalIndexTokens,
    snapshot,
    diagnostics,
  };
}

/**
 * The §11.3 resource URI, produced by `@skill-wiki/projection-engine` so that the
 * server's identities and the engine's parser cannot drift apart.
 *
 * This replaces a locally-built grammar that had six segments and neither a
 * tenant nor a profile; nothing in the repo could parse it. See the lane report.
 */
export function createPrimeResourceUri(
  identity: ResourceIdentity,
  unitId: string,
  profile: string,
  level: string,
): string {
  return formatProjectionUri({
    tenant: identity.tenant,
    corpus: identity.corpus,
    release: identity.release,
    unitId,
    profile,
    level,
  });
}
