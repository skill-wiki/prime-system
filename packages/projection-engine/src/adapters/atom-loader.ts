/**
 * Adapter over the landed pointer-first loader.
 *
 * `packages/runtime/src/atom-loader.ts` already resolves a unit's projection map
 * from `atom.yaml`. The work order keeps that file untouched, so this adapter
 * consumes it *structurally*: the loader function is injected rather than
 * imported. That keeps the dependency arrow pointing away from `runtime`
 * (plan §15.4) and lets a test drive the adapter with no filesystem at all.
 *
 * The loader's declared `projection` type is the legacy three-key record, but
 * this adapter indexes it by whatever level name the Model Package declares, so
 * a custom profile works against the same on-disk layout. That is the one reason
 * the lookup goes through a `Record<string, string>` view.
 */

import type { UnitIR } from "@skill-wiki/ir";
import type { ArtifactLocator } from "../engine.ts";
import type { ProjectionLevel } from "../profile.ts";

/** The shape `runtime`'s `loadAtomMeta` already returns, narrowed to what we need. */
export interface AtomProjectionMeta {
  readonly projection: Readonly<Record<string, string>>;
}

export interface AtomLoaderAdapterOptions {
  /** Injected `loadAtomMeta(primeDir, atomId)`. May throw for an unknown unit. */
  readonly loadMeta: (unitId: string) => AtomProjectionMeta | undefined;
  /**
   * Where the returned path is relative to. `atom-loader` joins the unit id as a
   * directory under the prime dir, so artifact paths are `<unitId>/<relPath>`.
   */
  readonly unitDirPrefix?: (unitId: string) => string;
}

function defaultPrefix(unitId: string): string {
  return unitId;
}

/**
 * Build an `ArtifactLocator` that reads the projection map the compiler emitted.
 * Returns `undefined` rather than throwing when a level is absent, so the engine
 * can record a diagnostic instead of failing the whole request.
 */
export function atomLoaderAdapter(options: AtomLoaderAdapterOptions): ArtifactLocator {
  const prefix = options.unitDirPrefix ?? defaultPrefix;
  return (unit: UnitIR, level: ProjectionLevel): string | undefined => {
    let meta: AtomProjectionMeta | undefined;
    try {
      meta = options.loadMeta(unit.identity.id);
    } catch {
      return undefined;
    }
    if (meta === undefined) return undefined;
    const relative = meta.projection[level.level];
    if (typeof relative !== "string" || relative === "") return undefined;
    // Path validation is not done here on purpose: `paths.ts` is the single
    // chokepoint, and duplicating the check would invite the two copies to drift.
    return `${prefix(unit.identity.id)}/${relative}`;
  };
}
