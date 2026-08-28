/**
 * Cache keys (plan §12.3 and §12.4).
 *
 * §12.3 requires a key to contain tenant, snapshot, policy and projection;
 * §12.4 adds that the core key is at least
 * `tenant / workspace / corpus / release / unit-id / version / digest`.
 * A unit id alone is therefore never a key: two tenants reading the same unit
 * under different policies must not share an entry.
 *
 * The key is a canonical JSON array rather than a joined string because unit ids
 * and policy refs contain `/` and `@`; a separator-joined key would be
 * ambiguous, and an ambiguous key is a cross-tenant collision.
 */

import type { SnapshotRef } from "@skill-wiki/ir";

export interface CacheScope {
  readonly tenant: string;
  readonly workspace: string;
  readonly corpus: string;
  readonly release: string;
  /** Ordered policy identifiers in effect. Order-insensitive by construction. */
  readonly policyRefs: readonly string[];
  readonly snapshot: SnapshotRef;
}

export interface CacheSubject {
  readonly unitId: string;
  readonly unitVersion: string;
  readonly unitDigest: string;
  readonly profile: string;
  readonly level: string;
  readonly levelVersion: string;
  readonly transport: string;
}

/** Stable snapshot identity: all four digests/releases, not just one. */
function snapshotKey(snapshot: SnapshotRef): readonly string[] {
  return [
    snapshot.modelRelease,
    snapshot.modelDigest,
    snapshot.corpusRelease,
    snapshot.corpusDigest,
  ];
}

/** Sorted so that policy set equality, not argument order, decides identity. */
function policyKey(policyRefs: readonly string[]): readonly string[] {
  return [...policyRefs].sort();
}

export function projectionCacheKey(scope: CacheScope, subject: CacheSubject): string {
  return JSON.stringify([
    "projection/v1",
    scope.tenant,
    scope.workspace,
    scope.corpus,
    scope.release,
    snapshotKey(scope.snapshot),
    policyKey(scope.policyRefs),
    subject.unitId,
    subject.unitVersion,
    subject.unitDigest,
    subject.profile,
    subject.level,
    subject.levelVersion,
    subject.transport,
  ]);
}

/**
 * A cache that cannot be keyed by unit id by construction: `get`/`set` take the
 * scope and subject, so a caller has no way to omit the tenant.
 */
export class ProjectionCache<T> {
  private readonly entries = new Map<string, T>();

  get(scope: CacheScope, subject: CacheSubject): T | undefined {
    return this.entries.get(projectionCacheKey(scope, subject));
  }

  set(scope: CacheScope, subject: CacheSubject, value: T): void {
    this.entries.set(projectionCacheKey(scope, subject), value);
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): readonly string[] {
    return [...this.entries.keys()];
  }
}
