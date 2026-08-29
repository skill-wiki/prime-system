/**
 * The trust boundary (plan §12.3, §3.5).
 *
 * Three of §12.3's invariants live here because they are all the same question
 * asked at different moments: *what earned the right to execute?*
 *
 * 1. **Model/Corpus data cannot implicitly gain code execution.** This is not
 *    enforced by scanning data for dangerous shapes — that is a blocklist and it
 *    loses. It is enforced by *provenance*: code runs only when it was found
 *    under a directory the operator declared as a plugin root, and a directory
 *    that lives under a declared model/corpus data root is refused even when it
 *    carries a perfectly valid manifest and a real entry file. A corpus author
 *    who ships `prime-plugin.yaml` inside their corpus gets a refusal naming the
 *    data root, not a loaded plugin. Both sides are compared after `realpath`,
 *    so a symlink from a plugin root into a corpus does not launder provenance.
 *
 * 2. **Registry: same version, different digest must be rejected.** Two builds
 *    that claim `name@1.0.0` and hash differently cannot both be that version;
 *    accepting the second silently swaps executing code under a pinned version.
 *
 * 3. **Signature verification precedes everything.** §12.2 puts `verify
 *    signature` second, before dependency resolution and before authorization,
 *    so an unsigned plugin under a signature-requiring policy never reaches the
 *    step that would grant it anything.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, realpathSync, existsSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { PluginManifest } from "./manifest.ts";
import { MANIFEST_FILENAME } from "./manifest.ts";

export type TrustRefusalCode =
  | "PROVENANCE_INSIDE_DATA_ROOT"
  | "PROVENANCE_NOT_IN_PLUGIN_ROOT"
  | "SIGNATURE_MISSING"
  | "SIGNATURE_DIGEST_MISMATCH"
  | "SIGNATURE_ALGORITHM_UNSUPPORTED"
  | "REGISTRY_DIGEST_CONFLICT";

export interface TrustRefusal {
  readonly code: TrustRefusalCode;
  readonly reason: string;
}

export type TrustResult = { readonly ok: true } | { readonly ok: false } & TrustRefusal;

function contains(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  const rel = relative(outer, inner);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`.${sep}.`) && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel);
}

function realIfPossible(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined;
}

export interface ProvenancePolicy {
  /** Directories whose subdirectories may be loaded as plugins. */
  readonly pluginRoots: readonly string[];
  /**
   * Directories holding Model/Corpus *data*. A candidate under one of these is
   * refused even if it is also under a plugin root — the more restrictive claim
   * wins, because an operator who nests the two has made a mistake and the safe
   * reading of that mistake is "this is data".
   */
  readonly dataRoots: readonly string[];
}

/**
 * Decide whether a candidate directory is allowed to contribute *code*.
 *
 * Ordering matters: the data-root check runs first, so overlapping roots resolve
 * towards refusal rather than towards whichever list was consulted first.
 */
export function checkProvenance(candidateDir: string, policy: ProvenancePolicy): TrustResult {
  const candidate = realIfPossible(candidateDir);
  if (candidate === undefined) {
    return { ok: false, code: "PROVENANCE_NOT_IN_PLUGIN_ROOT", reason: `Candidate does not exist: ${candidateDir}` };
  }
  for (const dataRoot of policy.dataRoots) {
    const real = realIfPossible(dataRoot);
    if (real !== undefined && contains(real, candidate)) {
      return {
        ok: false,
        code: "PROVENANCE_INSIDE_DATA_ROOT",
        reason: `Refusing to load code from a Model/Corpus data root (§12.3): ${dataRoot}`,
      };
    }
  }
  const allowed = policy.pluginRoots.some(root => {
    const real = realIfPossible(root);
    return real !== undefined && contains(real, candidate);
  });
  if (!allowed) {
    return {
      ok: false,
      code: "PROVENANCE_NOT_IN_PLUGIN_ROOT",
      reason: `Candidate is not under any declared plugin root: ${candidateDir}`,
    };
  }
  return { ok: true };
}

/** Files that make up a plugin's identity, root-relative and sorted. */
function pluginFiles(root: string): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      // A symlink is not hashed as its target: following it would let a plugin's
      // digest depend on a file it does not ship, so the same bytes could hash
      // two ways. The link's own text is hashed instead, below.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
        continue;
      }
      out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Content digest over every file in the plugin, path included, so that moving a
 * file changes the digest. The manifest's own `signature` block is excluded
 * because it cannot contain a hash of itself.
 */
export function computePluginDigest(root: string, algorithm: string = "sha256"): string {
  const hash = createHash(algorithm);
  for (const rel of pluginFiles(root)) {
    const full = join(root, rel);
    hash.update(rel.split(sep).join("/"));
    hash.update("\0");
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      // The link's own text, not its target's bytes: following it would make a
      // plugin's digest depend on a file it does not ship, so identical shipped
      // bytes could hash two ways on two machines.
      hash.update("symlink\0");
      hash.update(readlinkSync(full));
    } else if (rel === MANIFEST_FILENAME) {
      hash.update(stripSignatureBlock(readFileSync(full, "utf8")));
    } else {
      hash.update(readFileSync(full));
    }
    hash.update("\0");
  }
  return `${algorithm}:${hash.digest("hex")}`;
}

/**
 * Remove the `signature:` block from a manifest before hashing. Line-based on
 * purpose: re-serializing the YAML would change bytes that the signer hashed.
 */
function stripSignatureBlock(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^signature\s*:/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s+/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out.join("\n");
}

export interface SignaturePolicy {
  /** When true, an unsigned plugin is refused rather than merely unverified. */
  readonly requireSignature: boolean;
  /** Digest algorithms the host will compute. Anything else is refused. */
  readonly algorithms: readonly string[];
}

export const DEFAULT_SIGNATURE_POLICY: SignaturePolicy = { requireSignature: true, algorithms: ["sha256", "sha512"] };

/**
 * §12.2 step 2. This verifies the *digest binding* — that the manifest describes
 * the bytes actually on disk. It does not check a public-key signature, because
 * there is no key distribution in this repo yet; `signature.value` is carried and
 * compared as an opaque token by the registry check below. A host that needs
 * cryptographic authorship must supply a verifier — and until it does,
 * `requireSignature: true` is still meaningful: it refuses a plugin whose files
 * do not match its own published digest.
 */
export function verifyPluginSignature(root: string, manifest: PluginManifest, policy: SignaturePolicy = DEFAULT_SIGNATURE_POLICY): TrustResult {
  const signature = manifest.signature;
  if (signature === undefined) {
    return policy.requireSignature
      ? { ok: false, code: "SIGNATURE_MISSING", reason: `${manifest.name} carries no signature and the host requires one` }
      : { ok: true };
  }
  const algorithm = signature.digest.split(":", 1)[0]!;
  if (!policy.algorithms.includes(algorithm)) {
    return { ok: false, code: "SIGNATURE_ALGORITHM_UNSUPPORTED", reason: `Unsupported digest algorithm: ${algorithm}` };
  }
  const actual = computePluginDigest(root, algorithm);
  if (actual !== signature.digest) {
    return { ok: false, code: "SIGNATURE_DIGEST_MISMATCH", reason: `Digest mismatch: manifest claims ${signature.digest}, files hash to ${actual}` };
  }
  return { ok: true };
}

/**
 * §12.3: "Registry 同版本不同 digest 必须拒绝".
 *
 * Keyed by `name@version` rather than by name, because two versions differing is
 * the normal case and only a *collision* on one version is the attack.
 */
export class PluginDigestRegistry {
  private readonly seen = new Map<string, string>();

  record(name: string, version: string, digest: string): TrustResult {
    const key = `${name}@${version}`;
    const known = this.seen.get(key);
    if (known !== undefined && known !== digest) {
      return {
        ok: false,
        code: "REGISTRY_DIGEST_CONFLICT",
        reason: `${key} was already registered with digest ${known}; refusing a second digest ${digest}`,
      };
    }
    this.seen.set(key, digest);
    return { ok: true };
  }

  digestOf(name: string, version: string): string | undefined {
    return this.seen.get(`${name}@${version}`);
  }
}
