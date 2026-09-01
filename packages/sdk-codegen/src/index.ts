/**
 * @module @aoe/sdk-codegen
 *
 * Layer 3 of plan §10.1 — the Model-generated SDK — produced from `SchemaIR` per
 * §14.3, never by re-parsing YAML. `buildCodegenSchema` is the single place a
 * `LoadedModel` is read; every emitter downstream sees only IR.
 *
 * Zero domain vocabulary: every identifier, tool name and JSON Schema property in
 * the output is derived from a name that arrived in the Model Package.
 */

export { canonicalJson, canonicalize, sha256 } from "./canonical.ts";
export { emitMcpTools, type JsonSchema, type McpToolDocument, type McpToolSchema } from "./emit-mcp.ts";
export {
  GENERATOR_ID,
  emitClient,
  emitTypes,
  typeScriptNames,
  type TypeScriptNames,
} from "./emit-typescript.ts";
export {
  assertSchemaDigestSelfConsistent,
  generateSdk,
  type GeneratedFile,
  type GeneratedSdk,
} from "./generate.ts";
export { CodegenError, camelCase, pascalCase, snakeCase, uniqueIdentifiers } from "./identifiers.ts";
export {
  BUILTIN_TYPE_REFS,
  buildCodegenSchema,
  isBuiltinTypeRef,
  parseTypeRef,
  recomputeModelDigest,
  type CodegenSchema,
  type DeclaredActionTraits,
  type DeclaredField,
} from "./schema-ir.ts";
