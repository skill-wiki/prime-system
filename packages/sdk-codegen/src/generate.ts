/**
 * @module generate
 *
 * The one entry point. It returns files in memory rather than writing them,
 * because the two callers want different things: a CLI writes them to disk, and a
 * conformance check (`MC-SDK-COMPILE`) wants to compile them in a scratch directory
 * and throw them away. A generator that only knew how to write to disk would force
 * the check to invent a cleanup protocol.
 */

import type { LoadedModel } from "@aoe/model-schema";
import { canonicalJson } from "./canonical.ts";
import { emitMcpTools, type McpToolDocument } from "./emit-mcp.ts";
import { emitClient, emitTypes, typeScriptNames, GENERATOR_ID } from "./emit-typescript.ts";
import { buildCodegenSchema, recomputeModelDigest, type CodegenSchema } from "./schema-ir.ts";

export interface GeneratedFile {
  /** Path relative to the output directory, POSIX-separated. */
  readonly path: string;
  readonly content: string;
}

export interface GeneratedSdk {
  readonly schema: CodegenSchema;
  readonly modelDigest: string;
  readonly files: readonly GeneratedFile[];
  readonly mcp: McpToolDocument;
}

/**
 * `schema.json` is emitted alongside the code on purpose: it is the exact input the
 * other artifacts were generated from, so a mismatch investigation does not have to
 * reconstruct the model as it was at generation time.
 */
export function generateSdk(model: LoadedModel): GeneratedSdk {
  const schema = buildCodegenSchema(model);
  const names = typeScriptNames(schema.schema);
  const mcp = emitMcpTools(schema, GENERATOR_ID);
  return {
    schema,
    modelDigest: schema.schema.model.digest,
    mcp,
    files: [
      { path: "types.ts", content: emitTypes(schema, names) },
      { path: "client.ts", content: emitClient(schema, names) },
      { path: "mcp-tools.json", content: `${canonicalJson(mcp)}\n` },
      { path: "schema.json", content: `${canonicalJson(schema.schema)}\n` },
    ],
  };
}

/**
 * Verify a `schema.json` emitted next to a generated SDK still hashes to the digest
 * it claims. This is the *generator* side of the §14.3 contract — the client side
 * lives in `@aoe/sdk` (`assertGeneratedArtifactUsable`) — and it catches the
 * one case the client gate cannot: a generated artifact whose stamped digest was
 * edited to match a snapshot it was never generated from.
 */
export function assertSchemaDigestSelfConsistent(schema: CodegenSchema["schema"]): void {
  const recomputed = recomputeModelDigest(schema);
  if (recomputed !== schema.model.digest) {
    throw new Error(
      `Schema claims model digest ${schema.model.digest} but its own content hashes to ${recomputed}`,
    );
  }
}
