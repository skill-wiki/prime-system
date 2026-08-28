import type { RunScope, RunScopeSource } from "./contracts.ts";

/**
 * `tenant`/`workspace` default to "" to match the runtime's own idempotency
 * tuple (`context.tenant ?? ""`, action-runtime/src/index.ts:26), so a store
 * key and a runtime key agree on what "no tenant" means.
 */
export function toScope(source: RunScopeSource): RunScope {
  return {
    tenant: source.tenant ?? "",
    workspace: source.workspace ?? "",
    snapshot: source.snapshot,
  };
}

/**
 * JSON array encoding, not a delimiter join: `("a|b","c")` and `("a","b|c")`
 * must not collide. action-runtime asserts exactly this for its own key
 * (test/action-runtime.test.ts, "uses an unambiguous multi-tenant idempotency
 * tuple"), and a store that joined on a separator would reintroduce the
 * ambiguity one layer down.
 */
export function scopeKey(scope: RunScope): string {
  return JSON.stringify([scope.tenant, scope.workspace, scope.snapshot]);
}

/** The same unambiguous encoding for the five-part idempotency tuple. */
export function idempotencyKeyOf(scope: RunScope, action: string, idempotencyKey: string): string {
  return JSON.stringify([scope.tenant, scope.workspace, scope.snapshot, action, idempotencyKey]);
}

export function sameScope(left: RunScope, right: RunScope): boolean {
  return (
    left.tenant === right.tenant &&
    left.workspace === right.workspace &&
    left.snapshot === right.snapshot
  );
}
