/**
 * Transport semantics (plan §9.5).
 *
 * Pointer-first stays the default for a local agent, but §9.5 is explicit that it
 * cannot be the only semantics: a remote MCP client cannot read a server-local
 * path, so handing it one is a silent failure rather than an optimisation.
 *
 *   path    → controlled absolute path/handle, content never read (local agent)
 *   inline  → content, path withheld (remote MCP)
 *   uri     → aoe:// resource URI, resolvable by a local adapter (§11.3)
 *
 * The `path` variant deliberately reuses the same containment check as `inline`:
 * returning an unvalidated path is as much an escape as reading one.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ProjectionArtifactIR } from "@skill-wiki/ir";
import { resolveBundlePath, type PathRejectionCode } from "./paths.ts";
import { formatProjectionUri, type ProjectionUri } from "./uri.ts";

export type TransportKind = "path" | "inline" | "uri";

export interface TransportTarget {
  readonly bundleRoot: string;
  /** Bundle-relative path of the artifact. Comes from data; always validated. */
  readonly artifactPath: string;
  readonly uri: ProjectionUri;
}

export type ProjectionPayload =
  | { readonly transport: "path"; readonly path: string; readonly bytes: number; readonly digest: string; readonly tokens: number }
  | { readonly transport: "inline"; readonly content: string; readonly bytes: number; readonly digest: string; readonly tokens: number }
  | { readonly transport: "uri"; readonly uri: string; readonly bytes: number; readonly digest: string; readonly tokens: number };

export type TransportResult =
  | { readonly ok: true; readonly payload: ProjectionPayload }
  | { readonly ok: false; readonly code: PathRejectionCode | "TRANSPORT_UNSUPPORTED"; readonly reason: string };

/**
 * Digest and token accounting deliberately match the landed compiler:
 * `compiler/src/atom-dir-emitter.ts` prefixes `sha256:`, and
 * `compiler/src/chunker.ts:93` estimates `ceil(chars / 4)`. Diverging here would
 * make an artifact's recomputed digest disagree with the one in its metadata.
 */
export function contentDigest(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export interface TransportOptions {
  /** Metadata from the compiler, trusted for `tokens` but re-verified for size. */
  readonly artifact?: Pick<ProjectionArtifactIR, "tokens" | "bytes" | "digest">;
  /** Post-redaction content. When present it replaces the on-disk bytes. */
  readonly overrideContent?: string;
}

export function deliver(
  transport: TransportKind,
  target: TransportTarget,
  options: TransportOptions = {},
): TransportResult {
  const resolved = resolveBundlePath(target.bundleRoot, target.artifactPath);
  if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason };

  // A redacted body has different bytes and a different digest than the file, so
  // accounting is recomputed rather than copied from artifact metadata.
  const redacted = options.overrideContent;

  if (transport === "path") {
    if (redacted !== undefined) {
      return {
        ok: false,
        code: "TRANSPORT_UNSUPPORTED",
        reason: "Redacted content cannot be delivered as a path: the file on disk is unredacted",
      };
    }
    const bytes = options.artifact?.bytes ?? Buffer.byteLength(readFileSync(resolved.absolutePath));
    const digest = options.artifact?.digest ?? contentDigest(readFileSync(resolved.absolutePath, "utf8"));
    const tokens = options.artifact?.tokens ?? estimateTokens(readFileSync(resolved.absolutePath, "utf8"));
    return { ok: true, payload: { transport: "path", path: resolved.absolutePath, bytes, digest, tokens } };
  }

  if (transport === "inline") {
    const content = redacted ?? readFileSync(resolved.absolutePath, "utf8");
    return {
      ok: true,
      payload: {
        transport: "inline",
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        digest: contentDigest(content),
        tokens: estimateTokens(content),
      },
    };
  }

  // `uri`: the identity is returned, not the body. Accounting still comes from
  // the real artifact so a client can size the fetch before making it.
  const content = redacted ?? readFileSync(resolved.absolutePath, "utf8");
  return {
    ok: true,
    payload: {
      transport: "uri",
      uri: formatProjectionUri(target.uri),
      bytes: Buffer.byteLength(content, "utf8"),
      digest: contentDigest(content),
      tokens: options.artifact?.tokens ?? estimateTokens(content),
    },
  };
}

/**
 * Turn a URI back into a validated local path. Only a local adapter may do this
 * (§11.3); the containment check is what makes a data-supplied URI safe to honour.
 */
export function resolveUriToPath(
  bundleRoot: string,
  uri: ProjectionUri,
  artifactPathFor: (uri: ProjectionUri) => string,
): TransportResult {
  const relPath = artifactPathFor(uri);
  const resolved = resolveBundlePath(bundleRoot, relPath);
  if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason };
  const content = readFileSync(resolved.absolutePath, "utf8");
  return {
    ok: true,
    payload: {
      transport: "path",
      path: resolved.absolutePath,
      bytes: Buffer.byteLength(content, "utf8"),
      digest: contentDigest(content),
      tokens: estimateTokens(content),
    },
  };
}

/** Pick the first transport the consumer supports; order expresses preference. */
export function negotiateTransport(
  supported: readonly TransportKind[],
): TransportKind | undefined {
  return supported[0];
}
