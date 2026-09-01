/**
 * Test fixtures.
 *
 * Every name here is deliberately synthetic (`tA`, `pf-one`, `lv-wide`) so that
 * no test can accidentally encode a domain vocabulary the engine is forbidden to
 * know. If a test needed a real domain name to pass, that would itself be the bug.
 */

import type { ProjectionDefinition } from "@aoe/model-schema";
import type { SnapshotRef, TypedValueIR, UnitIR } from "@aoe/ir";
import type { ProjectionScope } from "../src/engine.ts";

export const loc = { line: 1, column: 1, offset: 0 } as const;
export const source = { loc } as const;

export function str(value: string): TypedValueIR {
  return { kind: "string", value, source };
}

export function obj(fields: Record<string, TypedValueIR>): TypedValueIR {
  return { kind: "object", fields, source };
}

export const snapshot: SnapshotRef = {
  modelRelease: "m-1",
  modelDigest: "sha256:mmm",
  corpusRelease: "c-1",
  corpusDigest: "sha256:ccc",
};

export function unit(overrides: Partial<UnitIR> = {}): UnitIR {
  return {
    identity: { id: "u-1", version: "1.0.0", digest: "sha256:u1", corpus: "cx" },
    typeRef: "tA",
    implements: [],
    fields: {},
    relations: [],
    citations: [],
    policyLabels: [],
    lifecycle: "active",
    visibility: "shared",
    provenance: { source },
    projections: {},
    ...overrides,
  };
}

/** A projection level expressed the way a Model Package would spell it. */
export function projectionDef(
  name: string,
  targetTokens: number,
  extra: Partial<ProjectionDefinition> = {},
): ProjectionDefinition {
  return {
    kind: "projection",
    name,
    version: "1.0.0",
    targetTokens,
    include: [],
    exclude: [],
    typeGroups: {},
    rules: [],
    ...extra,
  };
}

export const scope: ProjectionScope = {
  tenant: "tenant-a",
  workspace: "ws-a",
  corpus: "cx",
  release: "r-1",
  snapshot,
};
