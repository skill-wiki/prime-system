/**
 * Resource URI (plan §11.3):
 *
 *   aoe://<tenant>/<corpus>@<release>/units/<id>/projections/<profile>/<level>
 *
 * A server-local absolute path is not a cross-environment protocol, so this is
 * the identity a remote consumer receives. Parse and format are exact inverses
 * over the fields; unit ids like `@community/fact-x` contain both `@` and `/`,
 * so the grammar is anchored on the fixed `units` / `projections` markers and
 * the id is percent-encoded rather than split on delimiters.
 */

export const AOE_URI_SCHEME = "prime:";

export interface ProjectionUri {
  readonly tenant: string;
  readonly corpus: string;
  readonly release: string;
  readonly unitId: string;
  readonly profile: string;
  readonly level: string;
}

export type UriParseResult =
  | { readonly ok: true; readonly value: ProjectionUri }
  | { readonly ok: false; readonly reason: string };

/** Segments must survive a round-trip, so a raw `/` or `@` is never emitted. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodeSegment(value: string): string {
  return decodeURIComponent(value);
}

function assertNonEmpty(label: string, value: string): void {
  if (value === "") throw new Error(`Projection URI ${label} must not be empty`);
  if (value.includes("\0")) throw new Error(`Projection URI ${label} must not contain a NUL byte`);
}

export function formatProjectionUri(uri: ProjectionUri): string {
  assertNonEmpty("tenant", uri.tenant);
  assertNonEmpty("corpus", uri.corpus);
  assertNonEmpty("release", uri.release);
  assertNonEmpty("unitId", uri.unitId);
  assertNonEmpty("profile", uri.profile);
  assertNonEmpty("level", uri.level);
  const corpusAtRelease = `${encodeSegment(uri.corpus)}@${encodeSegment(uri.release)}`;
  return [
    `aoe://${encodeSegment(uri.tenant)}`,
    corpusAtRelease,
    "units",
    encodeSegment(uri.unitId),
    "projections",
    encodeSegment(uri.profile),
    encodeSegment(uri.level),
  ].join("/");
}

export function parseProjectionUri(raw: string): UriParseResult {
  if (raw.includes("\0")) return { ok: false, reason: "Projection URI contains a NUL byte" };
  if (!raw.startsWith("aoe://")) return { ok: false, reason: "Projection URI must use the aoe:// scheme" };

  const segments = raw.slice("aoe://".length).split("/");
  if (segments.length !== 7) {
    return { ok: false, reason: `Projection URI must have 7 segments, found ${segments.length}` };
  }
  const [tenantRaw, corpusRelease, unitsMarker, unitRaw, projectionsMarker, profileRaw, levelRaw] =
    segments as [string, string, string, string, string, string, string];

  if (unitsMarker !== "units") return { ok: false, reason: "Projection URI is missing the 'units' segment" };
  if (projectionsMarker !== "projections") {
    return { ok: false, reason: "Projection URI is missing the 'projections' segment" };
  }
  // `@` separates corpus from release; a corpus name may itself be scoped, so
  // the *last* `@` wins and encoding guarantees there is exactly one.
  const at = corpusRelease.lastIndexOf("@");
  if (at <= 0 || at === corpusRelease.length - 1) {
    return { ok: false, reason: "Projection URI must spell the corpus as <corpus>@<release>" };
  }

  let value: ProjectionUri;
  try {
    value = {
      tenant: decodeSegment(tenantRaw),
      corpus: decodeSegment(corpusRelease.slice(0, at)),
      release: decodeSegment(corpusRelease.slice(at + 1)),
      unitId: decodeSegment(unitRaw),
      profile: decodeSegment(profileRaw),
      level: decodeSegment(levelRaw),
    };
  } catch {
    return { ok: false, reason: "Projection URI contains invalid percent-encoding" };
  }
  for (const [label, field] of Object.entries(value)) {
    if (field === "") return { ok: false, reason: `Projection URI ${label} must not be empty` };
  }
  return { ok: true, value };
}
