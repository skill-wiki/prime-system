/**
 * Path containment for everything a plugin can name (plan §12.3).
 *
 * A plugin is the one component whose *input* is attacker-shaped by design: its
 * manifest, its entry path and every path it asks the host to read arrive from
 * outside the engine. So no path from a plugin ever reaches an fs call without
 * crossing this module first.
 *
 * The check order is deliberate. Syntactic refusals happen before any fs call,
 * so a hostile path cannot make the host stat an attacker-chosen location merely
 * to be told the path was illegal. Containment is then re-proven on the
 * *realpath*, because a symlink is invisible to string analysis: `data/x` can be
 * a link to `/etc/passwd` and every segment of it looks innocent.
 *
 * Deliberately NOT "reject all symlinks": that is not containment, it is a ban,
 * and it breaks a bundle whose files are legitimately linked inside itself. The
 * test suite therefore asserts an *inside* link is accepted, so this cannot
 * degrade into a ban without the suite going red.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Why a path was refused. Stable codes so callers and tests assert on them. */
export type PathRejectionCode =
  | "PATH_NUL_BYTE"
  | "PATH_ABSOLUTE"
  | "PATH_TRAVERSAL"
  | "PATH_EMPTY"
  | "PATH_NOT_FOUND"
  | "PATH_WRONG_KIND"
  | "PATH_ESCAPES_ROOT"
  | "ROOT_NOT_FOUND";

/** What the caller expects to find. `any` still forbids devices and sockets. */
export type PathKind = "file" | "directory" | "any";

export class PluginPathError extends Error {
  constructor(
    readonly code: PathRejectionCode,
    readonly requestedPath: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginPathError";
  }
}

export type PathResolution =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly code: PathRejectionCode; readonly reason: string };

/**
 * `..` has to be checked per segment, not as a substring: `..data/x` is a legal
 * file name while `a/../../x` is an escape. Both separators are considered
 * because a plugin bundle can be authored on either platform.
 */
function hasTraversalSegment(candidate: string): boolean {
  return candidate.split(/[\\/]+/).includes("..");
}

/** `relative()` answers "outside" with a leading `..`, or by staying absolute. */
function escapes(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  if (rel === "") return false;
  if (isAbsolute(rel)) return true;
  return rel === ".." || rel.startsWith(`..${sep}`);
}

/**
 * Resolve a root-relative path to an absolute one, or explain the refusal.
 * Never throws on hostile input — the caller decides whether a refusal is fatal,
 * because during discovery a bad plugin is skipped while during execution the
 * same refusal aborts the call.
 */
export function resolveInRoot(root: string, relPath: string, kind: PathKind = "any"): PathResolution {
  // A NUL byte truncates the path inside libc, so `ok.md\0../../etc` would be
  // validated as one path and opened as another. Refuse before anything else.
  if (relPath.includes("\0")) {
    return { ok: false, code: "PATH_NUL_BYTE", reason: "Path contains a NUL byte" };
  }
  if (root.includes("\0")) {
    return { ok: false, code: "PATH_NUL_BYTE", reason: "Root contains a NUL byte" };
  }
  if (relPath.trim() === "") {
    return { ok: false, code: "PATH_EMPTY", reason: "Path is empty" };
  }
  // An absolute path from a plugin is a protocol violation as well as an escape
  // vector: a plugin names things relative to its own bundle, never absolutely.
  if (isAbsolute(relPath)) {
    return { ok: false, code: "PATH_ABSOLUTE", reason: "Path must be root-relative" };
  }
  if (hasTraversalSegment(relPath)) {
    return { ok: false, code: "PATH_TRAVERSAL", reason: "Path must not contain '..'" };
  }

  if (!existsSync(root)) {
    return { ok: false, code: "ROOT_NOT_FOUND", reason: `Root does not exist: ${root}` };
  }
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, relPath);
  // `existsSync` follows links, so a dangling link reports "not found" here
  // instead of surfacing later as an opaque read error.
  if (!existsSync(candidate)) {
    return { ok: false, code: "PATH_NOT_FOUND", reason: `Path not found under root: ${relPath}` };
  }

  const targetReal = realpathSync(candidate);
  // The decisive check: containment is asserted on the realpath, so a link that
  // lives inside the root but points outside it is caught even though every
  // string segment looked innocent.
  if (escapes(rootReal, targetReal)) {
    return { ok: false, code: "PATH_ESCAPES_ROOT", reason: `Path resolves outside the root: ${relPath}` };
  }

  const stat = lstatSync(targetReal);
  const kindOk = kind === "file" ? stat.isFile() : kind === "directory" ? stat.isDirectory() : stat.isFile() || stat.isDirectory();
  if (!kindOk) {
    return { ok: false, code: "PATH_WRONG_KIND", reason: `Path is not a ${kind === "any" ? "regular file or directory" : kind}: ${relPath}` };
  }
  return { ok: true, absolutePath: targetReal };
}

/** Throwing variant for call sites where a refusal is a programming error. */
export function requireInRoot(root: string, relPath: string, kind: PathKind = "any"): string {
  const result = resolveInRoot(root, relPath, kind);
  if (!result.ok) throw new PluginPathError(result.code, relPath, result.reason);
  return result.absolutePath;
}
