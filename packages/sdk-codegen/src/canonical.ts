/**
 * @module canonical
 *
 * Canonical serialisation and the model digest.
 *
 * The digest has to be a function of *meaning*, not of file layout: two Model
 * Packages that declare the same definitions in a different file order, or with
 * their YAML keys in a different order, must produce the same digest, or a
 * generated SDK would be rejected by §14.3's gate after a cosmetic edit. That is
 * why the digest is taken over a canonical rendering of the `SchemaIR` rather than
 * over the source bytes.
 *
 * Key order is lexicographic by UTF-16 code unit (`<`), matching what
 * `Object.keys().sort()` gives, and arrays keep their order because array order in
 * IR is semantic (`ProjectionDefIR.rules` is applied in sequence).
 */

import { createHash } from "node:crypto";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * `undefined` members are dropped rather than encoded, because an optional IR
 * field that is absent and one that is explicitly `undefined` are the same claim.
 * A non-finite number throws: `JSON.stringify` would silently write `null`, which
 * would make two different models digest identically.
 */
export function canonicalize(value: unknown, path = "$"): Json | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot canonicalize non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`) ?? null);
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, Json> = {};
    for (const key of Object.keys(source).sort()) {
      const encoded = canonicalize(source[key], `${path}.${key}`);
      if (encoded !== undefined) out[key] = encoded;
    }
    return out;
  }
  throw new Error(`Cannot canonicalize ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value) ?? null);
}

/** `sha256:<hex>`, the same shape `CorpusManifest` digests already use. */
export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
