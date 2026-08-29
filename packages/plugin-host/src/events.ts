/**
 * Host events (plan §12.3 "Secret 不进入 event payload", §12.4 multi-tenant keys).
 *
 * Two decisions here that are easy to get backwards:
 *
 * 1. **Redaction is a constructor, not a reviewer.** There is no
 *    `emit(payload)` that a later pass sanitises — `hostEvent()` is the only way
 *    to build an event, and it takes the secret-bearing values separately from
 *    the payload so a secret has no route into the payload to begin with. A
 *    scrubber that walks a finished payload has to *recognise* secrets, and
 *    recognition fails on the first secret that looks like a URL.
 *
 * 2. **The scope key is the whole §12.4 tuple or nothing.** `tenant / workspace /
 *    corpus / release / unit-id / version / digest` — all required, no defaults.
 *    A default like `tenant: "default"` is how two tenants come to share one
 *    cache entry, and it fails silently and identically to working.
 */

/** §12.4: the full key. Every field required — a partial key is not a key. */
export interface Scope {
  readonly tenant: string;
  readonly workspace: string;
  readonly corpus: string;
  readonly release: string;
  readonly unitId: string;
  readonly version: string;
  readonly digest: string;
}

const SCOPE_FIELDS: readonly (keyof Scope)[] = ["tenant", "workspace", "corpus", "release", "unitId", "version", "digest"];

export class ScopeError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Incomplete scope (§12.4): missing ${missing.join(", ")}`);
    this.name = "ScopeError";
  }
}

/**
 * Build a scope, refusing an incomplete one. `/` is the separator and every
 * component is escaped, because a tenant literally named `a/b` would otherwise
 * collide with tenant `a`, workspace `b`.
 */
export function scopeKey(scope: Scope): string {
  const missing = SCOPE_FIELDS.filter(f => scope[f] === undefined || scope[f].trim() === "");
  if (missing.length > 0) throw new ScopeError(missing);
  return SCOPE_FIELDS.map(f => encodeURIComponent(scope[f])).join("/");
}

export const REDACTED = "[redacted]";

export type HostEventKind =
  | "plugin.discovered"
  | "plugin.rejected"
  | "plugin.authorized"
  | "plugin.state"
  | "plugin.call"
  | "plugin.effect.granted"
  | "plugin.effect.refused"
  | "plugin.failed";

export interface HostEvent {
  readonly kind: HostEventKind;
  readonly plugin: string;
  readonly scopeKey: string;
  readonly at: number;
  /** Free-form, secret-free by construction — see `hostEvent`. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Names of values withheld, so an auditor sees that something was withheld. */
  readonly withheld: readonly string[];
}

export interface HostEventInput {
  readonly kind: HostEventKind;
  readonly plugin: string;
  readonly scope: Scope;
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * Values that are secret. Passed separately and never merged into `payload`:
   * only their *keys* reach the event, under `withheld`. The value is not even
   * hashed — a hash of a low-entropy secret is a secret.
   */
  readonly secrets?: Readonly<Record<string, unknown>>;
  readonly at?: number;
}

/**
 * The only constructor. A caller that has a secret in hand can only put it in
 * `secrets`, where it is dropped; there is no parameter that would carry it into
 * `payload`.
 */
export function hostEvent(input: HostEventInput): HostEvent {
  const secretKeys = Object.keys(input.secrets ?? {}).sort();
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.payload ?? {})) {
    // A caller that puts a key in both places is telling us it is secret, and
    // the secret reading wins. This is the case a scrubber gets wrong when the
    // payload copy has already been serialised somewhere else.
    payload[key] = secretKeys.includes(key) ? REDACTED : value;
  }
  for (const key of secretKeys) if (!(key in payload)) payload[key] = REDACTED;
  return {
    kind: input.kind,
    plugin: input.plugin,
    scopeKey: scopeKey(input.scope),
    at: input.at ?? Date.now(),
    payload,
    withheld: secretKeys,
  };
}

export type HostEventSink = (event: HostEvent) => void;

/** Collecting sink, for tests and for a host that has no event store wired yet. */
export function collectingSink(): { readonly sink: HostEventSink; readonly events: readonly HostEvent[] } {
  const events: HostEvent[] = [];
  return { sink: event => { events.push(event); }, events };
}
