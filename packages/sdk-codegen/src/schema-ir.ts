/**
 * @module schema-ir
 *
 * Model Package -> `SchemaIR`. Plan §14.3 requires codegen to consume SchemaIR
 * rather than re-parse YAML, and nothing in this repo produced a `SchemaIR` yet
 * (`grep -rln SchemaIR packages/` finds only the declaration in `@aoe/ir`
 * and `projection-engine`'s consumer of its `projections` slice). This module is
 * that producer, and it is the *only* place in this package that reads a
 * `LoadedModel`: every emitter downstream takes `CodegenSchema` and cannot reach
 * the YAML even by accident.
 *
 * ── Where SchemaIR is lossy, and why there is a sidecar ──────────────────────
 *
 * Three things a generator needs are declared by `@aoe/model-schema` and
 * *absent* from the IR contract:
 *
 *  - `TypeDefIR.fields` is `Record<string, TypeRef>` — a field's `required` flag is
 *    gone, so a generator working from SchemaIR alone cannot tell `name: string`
 *    from `name?: string`.
 *  - `TypeDefinition.additionalFields` (`reject` | `unknown`) is gone, so a JSON
 *    Schema generator cannot decide `additionalProperties`.
 *  - `ActionDefIR` carries `capabilities` and `sideEffects` but not `idempotency`
 *    or `approval`, which are exactly what an MCP tool annotation reports to a
 *    client deciding whether a call is safe to retry or needs confirmation.
 *  - a field's declared `enum` values have nowhere to live: `TypeDefIR.fields` is
 *    `Record<string, TypeRef>` and `TypeRef` is an opaque string. The array arity
 *    *does* survive (it is part of the ref: `string[]`), the value set does not.
 *
 * Guessing any of them is worse than not emitting them: `additionalProperties:
 * true` on a `reject` type turns a schema violation into an accepted call. So the
 * sidecar carries them, declared locally per lane brief §2.8, and the report lists
 * them as proposed IR additions. The digest is computed over the `SchemaIR` alone,
 * so it stays stable if and when those fields move into the IR.
 */

import type {
  ActionDefIR,
  CardinalityIR,
  FunctionDefIR,
  ProjectionDefIR,
  RelationDefIR,
  RetrievalProfileDefIR,
  SchemaIR,
  TypeDefIR,
  ValueIR,
} from "@aoe/ir";
import type { LoadedModel, ModelDefinition } from "@aoe/model-schema";
import { BUILTIN_TYPE_REFS as MODEL_BUILTIN_TYPE_REFS, isBuiltinTypeRef as modelIsBuiltinTypeRef, parseTypeRef } from "@aoe/model-schema";
import { canonicalJson, sha256 } from "./canonical.ts";

/** A field as the Model Package declares it, before SchemaIR flattens it. */
export interface DeclaredField {
  readonly name: string;
  /** The declared ref verbatim, array suffix included (`string`, `string[]`, `Foo[][]`). */
  readonly typeRef: string;
  readonly required: boolean;
  readonly description?: string;
  /**
   * The declared value set, when the field declares one. SchemaIR's `TypeRef` is an
   * opaque string, so the array *arity* survives inside the ref while the enum
   * *values* cannot — they ride the sidecar next to `required` and
   * `additionalFields`, for the same reason and with the same consequence: the
   * digest is over the IR, so it does not move when a value set is corrected.
   */
  readonly enumValues?: readonly string[];
}

export interface DeclaredActionTraits {
  readonly idempotency: "idempotent" | "non-idempotent" | "unknown";
  readonly approval: "never" | "always" | "conditional";
  readonly sideEffects: "none" | "read" | "write";
}

export interface CodegenSchema {
  /** The digest-bearing authority. Every emitter reads names and refs from here. */
  readonly schema: SchemaIR;
  /** Type name -> declared fields, in declaration order. */
  readonly typeFields: Readonly<Record<string, readonly DeclaredField[]>>;
  /** Type name -> whether undeclared properties are accepted. */
  readonly typeAdditionalFields: Readonly<Record<string, "reject" | "unknown">>;
  readonly actionInputs: Readonly<Record<string, readonly DeclaredField[]>>;
  readonly functionInputs: Readonly<Record<string, readonly DeclaredField[]>>;
  readonly actionTraits: Readonly<Record<string, DeclaredActionTraits>>;
}

/**
 * The builtin refs, re-exported from `model-schema` rather than re-listed: the two
 * lists drifting apart is exactly how a generator ends up emitting a `$ref` to a
 * `$defs` entry the loader considers a builtin.
 */
export const BUILTIN_TYPE_REFS = MODEL_BUILTIN_TYPE_REFS;

/** True for a builtin *element* ref. Array arity is not part of this question — parse the ref first. */
export function isBuiltinTypeRef(ref: string): boolean {
  return modelIsBuiltinTypeRef(ref);
}

/** `T[][]` -> `{ element: "T", arrayDepth: 2 }`. Re-exported so an emitter never re-implements the grammar. */
export { parseTypeRef };

function fieldsOf(fields: readonly DeclaredField[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const field of fields) out[field.name] = field.typeRef;
  return out;
}

function declared(
  fields: readonly { readonly name: string; readonly typeRef: string; readonly required?: boolean; readonly description?: string; readonly enum?: readonly string[] }[],
): readonly DeclaredField[] {
  return fields.map(field => ({
    name: field.name,
    typeRef: field.typeRef,
    required: field.required === true,
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.enum === undefined ? {} : { enumValues: [...field.enum] }),
  }));
}

/** `ProjectionDefIR.rules` is `Record<string, ValueIR>[]`, so an absent optional rule key is dropped rather than nulled. */
function projectionRule(rule: {
  readonly layer?: string;
  readonly typeRef?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}): Readonly<Record<string, ValueIR>> {
  const out: Record<string, ValueIR> = {};
  if (rule.layer !== undefined) out.layer = rule.layer;
  if (rule.typeRef !== undefined) out.typeRef = rule.typeRef;
  if (rule.include !== undefined) out.include = [...rule.include];
  if (rule.exclude !== undefined) out.exclude = [...rule.exclude];
  return out;
}

function sorted<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [key, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[key] = value;
  return out;
}

/**
 * Build the IR and stamp it with its own digest.
 *
 * The digest is taken over the schema with `model.digest` blanked, which is the
 * only way a self-describing digest can be verified: a consumer recomputes it the
 * same way and compares. Including the field in its own input would make it
 * unverifiable.
 */
export function buildCodegenSchema(model: LoadedModel): CodegenSchema {
  const types: (readonly [string, TypeDefIR])[] = [];
  const relations: (readonly [string, RelationDefIR])[] = [];
  const functions: (readonly [string, FunctionDefIR])[] = [];
  const actions: (readonly [string, ActionDefIR])[] = [];
  const projections: (readonly [string, ProjectionDefIR])[] = [];
  const retrievalProfiles: (readonly [string, RetrievalProfileDefIR])[] = [];

  const typeFields: Record<string, readonly DeclaredField[]> = {};
  const typeAdditionalFields: Record<string, "reject" | "unknown"> = {};
  const actionInputs: Record<string, readonly DeclaredField[]> = {};
  const functionInputs: Record<string, readonly DeclaredField[]> = {};
  const actionTraits: Record<string, DeclaredActionTraits> = {};

  for (const definition of model.definitions as readonly ModelDefinition[]) {
    switch (definition.kind) {
      case "type": {
        const fields = declared(definition.fields);
        typeFields[definition.name] = fields;
        typeAdditionalFields[definition.name] = definition.additionalFields;
        types.push([definition.name, { name: definition.name, version: definition.version, fields: fieldsOf(fields) }]);
        break;
      }
      case "relation": {
        const base = {
          name: definition.name,
          version: definition.version,
          from: definition.from,
          to: definition.to,
          cardinality: definition.cardinality as CardinalityIR,
          directional: definition.directional,
          semantics: definition.semantics,
        };
        relations.push([
          definition.name,
          definition.inverse === undefined ? base : { ...base, inverse: definition.inverse },
        ]);
        break;
      }
      case "function": {
        const inputs = declared(definition.inputs);
        functionInputs[definition.name] = inputs;
        functions.push([
          definition.name,
          {
            name: definition.name,
            version: definition.version,
            inputs: fieldsOf(inputs),
            output: definition.output,
            provider: definition.provider,
          },
        ]);
        break;
      }
      case "action": {
        const inputs = declared(definition.inputs);
        actionInputs[definition.name] = inputs;
        actionTraits[definition.name] = {
          idempotency: definition.idempotency,
          approval: definition.approval,
          sideEffects: definition.sideEffects,
        };
        actions.push([
          definition.name,
          {
            name: definition.name,
            version: definition.version,
            inputs: fieldsOf(inputs),
            output: definition.output,
            capabilities: [...definition.capabilities],
            sideEffects: definition.sideEffects,
          },
        ]);
        break;
      }
      case "projection": {
        projections.push([
          definition.name,
          {
            name: definition.name,
            version: definition.version,
            targetTokens: definition.targetTokens,
            rules: definition.rules.map(projectionRule),
          },
        ]);
        break;
      }
      case "retrieval-profile": {
        retrievalProfiles.push([
          definition.name,
          {
            name: definition.name,
            version: definition.version,
            projectionRef: definition.projection,
            featureWeights: sorted(Object.entries(definition.features)),
          },
        ]);
        break;
      }
    }
  }

  const unstamped: SchemaIR = {
    protocolVersion: model.manifest.protocol,
    model: { name: model.manifest.name, version: model.manifest.version, digest: "" },
    types: sorted(types),
    relations: sorted(relations),
    functions: sorted(functions),
    actions: sorted(actions),
    projections: sorted(projections),
    retrievalProfiles: sorted(retrievalProfiles),
  };

  return {
    schema: { ...unstamped, model: { ...unstamped.model, digest: sha256(canonicalJson(unstamped)) } },
    typeFields,
    typeAdditionalFields,
    actionInputs,
    functionInputs,
    actionTraits,
  };
}

/** Recompute a schema's digest the way `buildCodegenSchema` stamped it. */
export function recomputeModelDigest(schema: SchemaIR): string {
  return sha256(canonicalJson({ ...schema, model: { ...schema.model, digest: "" } }));
}
