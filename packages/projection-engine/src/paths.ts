/**
 * Path containment for projection artifacts (plan §12.3).
 *
 * Projection paths arrive from Model/Corpus *data* (`ProjectionArtifactIR.path`,
 * `atom.yaml`'s `projection:` map). Data must never be able to name a file
 * outside the bundle, so every path crosses this module before any fs call.
 *
 * The order of the checks matters: syntactic rejections happen before we touch
 * the filesystem, so a hostile path cannot make us stat an attacker-chosen
 * location just to be told it is illegal. Containment is then re-proven on the
 * *realpath*, because a symlink is invisible to string analysis.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Why a path was refused. Stable codes so callers can assert on them. */
export type PathRejectionCode =
  | "PATH_NUL_BYTE"
  | "PATH_ABSOLUTE"
  | "PATH_TRAVERSAL"
  | "PATH_EMPTY"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_A_FILE"
  | "PATH_ESCAPES_ROOT"
  | "ROOT_NOT_FOUND";

export class ProjectionPathError extends Error {
  constructor(
    readonly code: PathRejectionCode,
    readonly requestedPath: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectionPathError";
  }
}

export type PathResolution =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly code: PathRejectionCode; readonly reason: string };

/**
 * A `..` check has to run on segments, not on a substring: `"..data/x"` is a
 * legitimate file name while `"a/../../x"` is an escape. Windows separators are
 * included because bundle data can be authored on either platform.
 */
function hasTraversalSegment(candidate: string): boolean {
  return candidate.split(/[\\/]+/).includes("..");
}

/** `relative()` answers "outside" with a leading `..` or by staying absolute. */
function escapes(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  if (rel === "") return false;
  if (isAbsolute(rel)) return true;
  return rel === ".." || rel.startsWith(`..${sep}`);
}

/**
 * Resolve a bundle-relative projection path to an absolute path, or explain the
 * refusal. Never throws for hostile input — the caller decides whether a
 * rejection is fatal.
 */
export function resolveBundlePath(bundleRoot: string, relPath: string): PathResolution {
  // A NUL byte truncates the path inside libc, so `"ok.md\0../../etc"` would be
  // validated as one path and opened as another. Refuse before anything else.
  if (relPath.includes("\0")) {
    return { ok: false, code: "PATH_NUL_BYTE", reason: "Projection path contains a NUL byte" };
  }
  if (bundleRoot.includes("\0")) {
    return { ok: false, code: "PATH_NUL_BYTE", reason: "Bundle root contains a NUL byte" };
  }
  if (relPath.trim() === "") {
    return { ok: false, code: "PATH_EMPTY", reason: "Projection path is empty" };
  }
  // An absolute projection path is a cross-environment protocol violation
  // (§11.3) as well as an escape vector, so it is refused on sight.
  if (isAbsolute(relPath)) {
    return { ok: false, code: "PATH_ABSOLUTE", reason: "Projection path must be bundle-relative" };
  }
  if (hasTraversalSegment(relPath)) {
    return { ok: false, code: "PATH_TRAVERSAL", reason: "Projection path must not contain '..'" };
  }

  if (!existsSync(bundleRoot)) {
    return { ok: false, code: "ROOT_NOT_FOUND", reason: `Bundle root does not exist: ${bundleRoot}` };
  }
  const rootReal = realpathSync(bundleRoot);
  const candidate = resolve(rootReal, relPath);

  // `existsSync` follows symlinks, so a dangling link reports "not found" here
  // rather than surfacing as an opaque read error later.
  if (!existsSync(candidate)) {
    return { ok: false, code: "PATH_NOT_FOUND", reason: `Projection artifact not found: ${relPath}` };
  }

  const targetReal = realpathSync(candidate);
  // The decisive check: containment is asserted after symlink resolution, so a
  // link inside the bundle pointing outside it is caught even though every
  // string segment looked innocent.
  if (escapes(rootReal, targetReal)) {
    return {
      ok: false,
      code: "PATH_ESCAPES_ROOT",
      reason: `Projection path resolves outside the bundle root: ${relPath}`,
    };
  }
  if (!lstatSync(targetReal).isFile()) {
    return { ok: false, code: "PATH_NOT_A_FILE", reason: `Projection path is not a regular file: ${relPath}` };
  }
  return { ok: true, absolutePath: targetReal };
}

/** Throwing variant for call sites where a rejection is a programming error. */
export function requireBundlePath(bundleRoot: string, relPath: string): string {
  const result = resolveBundlePath(bundleRoot, relPath);
  if (!result.ok) throw new ProjectionPathError(result.code, relPath, result.reason);
  return result.absolutePath;
}
