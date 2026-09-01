/**
 * Step 2 of the plan §16 Phase 4 audit pipeline: **load evidence**.
 *
 * The evidence an audit reads is a *compiled* corpus bundle, never source — ADR-3
 * says Runtime only loads compiled bundles, and an audit that re-derived the
 * corpus from source would be auditing its own derivation rather than the
 * artifact that ships.
 *
 * `@aoe/runtime` already owns bundle reading (`loadIndex`, `loadAtomMeta`,
 * `loadCorpusSnapshot`). This module only re-shapes what it returns into a view
 * whose field names carry no corpus schema: `type` is whatever string the atom
 * declares as its kind, `relation` is whatever string the edge declares. Nothing
 * here enumerates a kind or a verb, so a corpus declaring names this CLI has
 * never seen audits exactly as well as one it has.
 */

import type { SnapshotRef } from '@aoe/ir';
import type { Manifest } from '@aoe/model-schema';
import {
  loadAtomMeta,
  loadCorpusSnapshot,
  loadIndex,
  type SnapshotRef as BundleSnapshotRef,
} from '@aoe/runtime';

/** One edge as the corpus declares it. `relation` is data, not a known verb. */
export interface AuditedEdge {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
}

/** One unit as the corpus declares it. `type` is the atom's own kind string. */
export interface AuditedUnit {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly contentHash: string;
  /** Projection name -> bundle-relative artifact path, exactly as declared. */
  readonly projections: Readonly<Record<string, string>>;
  readonly deprecated: boolean;
}

export interface AuditedCorpus {
  /** Absolute path of the bundle root that was read. */
  readonly root: string;
  readonly units: readonly AuditedUnit[];
  readonly edges: readonly AuditedEdge[];
  /**
   * Runtime's bundle-level snapshot. Deliberately NOT re-typed as `ir`'s
   * `SnapshotRef`: the two are same-name/different-shape (see `toSnapshotRef`),
   * and collapsing them here is how a digest ends up compared against the wrong
   * field.
   */
  readonly bundleSnapshot: BundleSnapshotRef;
  /** Bundle-level diagnostics Runtime reported while loading (e.g. no manifest). */
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

/**
 * Read a compiled bundle into the neutral view above.
 *
 * Deprecated atoms are kept: an audit that silently skipped them would report a
 * clean corpus while the deprecated half rotted. `loadIndex` splits them out, so
 * they are folded back in and flagged instead.
 */
export function loadAuditedCorpus(root: string): AuditedCorpus {
  const index = loadIndex(root);
  const loaded = loadCorpusSnapshot(root);
  const units: AuditedUnit[] = [];
  const edges: AuditedEdge[] = [];
  const entries = [
    ...index.atoms.map((atom) => ({ atom, deprecated: false })),
    ...index.deprecated.map((atom) => ({ atom, deprecated: true })),
  ];
  for (const { atom, deprecated } of entries) {
    const meta = loadAtomMeta(root, atom.id);
    // Object.entries rather than a named level list: which projections a bundle
    // carries is the model's to declare, not this module's to know.
    const projections: Record<string, string> = {};
    for (const [name, path] of Object.entries(meta.projection)) {
      if (typeof path === 'string' && path.length > 0) projections[name] = path;
    }
    units.push({
      id: meta.id,
      type: meta.kind,
      version: meta.version,
      contentHash: meta.contentHash,
      projections,
      deprecated,
    });
    for (const relation of meta.relations) {
      edges.push({ relation: relation.type, from: meta.id, to: relation.target });
    }
  }
  return {
    root,
    units,
    edges,
    bundleSnapshot: loaded.snapshot,
    diagnostics: loaded.diagnostics.map((d) => ({ code: d.code, message: d.message })),
  };
}

/**
 * Build the §8.4/§8.5 `SnapshotRef` the Action Runtime pins itself to.
 *
 * This is the first code in the repo that constructs one: `action-runtime` can
 * only be *given* a snapshot (a `LoadedModel` carries no digest at all), so until
 * something loaded a bundle and a model together, the digest checks were an
 * unreachable capability. Every one of the four fields is copied from an artifact
 * that already recorded it — nothing is synthesised, because a synthesised digest
 * makes every later comparison pass by accident.
 *
 * `modelDigest` comes from the bundle's `schemaDigest`: that is the compiler's
 * record of *which schema this corpus was compiled against*, which is precisely
 * what a run must not be allowed to drift from. `modelRelease` prefers the
 * version the bundle pinned for this model over the version on disk, so a bundle
 * compiled against 1.0.0 does not silently read as 2.0.0 once the model is
 * upgraded.
 */
export function toSnapshotRef(bundle: BundleSnapshotRef, model: Manifest): SnapshotRef {
  return {
    modelRelease: bundle.models[model.name] ?? model.version,
    modelDigest: bundle.schemaDigest,
    corpusRelease: bundle.release,
    corpusDigest: bundle.contentDigest,
  };
}
