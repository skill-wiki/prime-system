/**
 * @module emit-mcp
 *
 * `CodegenSchema` -> MCP tool schemas (plan §11.2, §14.3).
 *
 * §11.2 is explicit that a domain tool "只是 ActionDef/QueryProfile 的投影，不在 Core
 * 手写". So every tool here is a projection of one `ActionDefIR` (plus, for the
 * `annotations`, the two declared traits SchemaIR drops — see `schema-ir.ts`), and
 * the tool name is derived from the model name and the action name rather than
 * chosen: `security-controls` + `AuditControl` -> `security_controls_audit_control`.
 *
 * Declared types become `$defs` entries and are referenced with `$ref`, not
 * inlined. Inlining would not terminate on a self-referential type, and a model is
 * allowed to declare one — a type-to-type field is legal in `model-schema`, so the
 * cycle is a shape the emitter must survive rather than a hypothetical.
 */

import { snakeCase, uniqueIdentifiers } from "./identifiers.ts";
import { isBuiltinTypeRef, type CodegenSchema, type DeclaredField } from "./schema-ir.ts";

export type JsonSchema = { readonly [key: string]: JsonSchemaValue };
type JsonSchemaValue = null | boolean | number | string | readonly JsonSchemaValue[] | JsonSchema;

export interface McpToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  /**
   * The three hints an MCP client uses to decide whether it may call without
   * asking. Every one is read from a model declaration; none is inferred.
   */
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly requiredCapabilities: readonly string[];
    readonly approval: string;
  };
}

export interface McpToolDocument {
  readonly protocol: string;
  readonly generator: string;
  readonly model: { readonly name: string; readonly version: string; readonly digest: string };
  readonly tools: readonly McpToolSchema[];
  readonly $defs: JsonSchema;
}

function scalarSchema(ref: string): JsonSchema | undefined {
  switch (ref) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    default:
      // `unknown`, `*` and `generic*` constrain nothing, and an empty schema is
      // JSON Schema's own way of saying that — `{"type":"object"}` would be a
      // constraint the model never declared.
      return isBuiltinTypeRef(ref) ? {} : undefined;
  }
}

function refSchema(ref: string): JsonSchema {
  return scalarSchema(ref) ?? { $ref: `#/$defs/${ref}` };
}

function objectSchema(
  fields: readonly DeclaredField[],
  additionalProperties: boolean,
  title: string,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    const schema = refSchema(field.typeRef);
    properties[field.name] = field.description === undefined ? schema : { ...schema, description: field.description };
    if (field.required) required.push(field.name);
  }
  const base: Record<string, JsonSchemaValue> = { title, type: "object", properties, additionalProperties };
  if (required.length > 0) base.required = required;
  return base;
}

export function emitMcpTools(input: CodegenSchema, generator: string): McpToolDocument {
  const { schema } = input;
  const prefix = snakeCase(schema.model.name);
  const toolNames = uniqueIdentifiers(
    Object.keys(schema.actions),
    name => `${prefix}_${snakeCase(name)}`,
    "Action tool",
  );

  const $defs: Record<string, JsonSchema> = {};
  for (const typeName of Object.keys(schema.types).sort()) {
    $defs[typeName] = objectSchema(
      input.typeFields[typeName] ?? [],
      input.typeAdditionalFields[typeName] === "unknown",
      typeName,
    );
  }

  const tools: McpToolSchema[] = [];
  for (const [actionName, toolName] of toolNames) {
    const action = schema.actions[actionName]!;
    const traits = input.actionTraits[actionName]!;
    tools.push({
      name: toolName,
      description: `Action ${actionName} v${action.version} of model ${schema.model.name}`,
      // An action's input object is closed: `model-schema` rejects an undeclared
      // input key at runtime, so a schema that allowed one would promise a call
      // that the runtime is going to refuse.
      inputSchema: objectSchema(input.actionInputs[actionName] ?? [], false, `${actionName}Input`),
      outputSchema: refSchema(action.output),
      annotations: {
        readOnlyHint: traits.sideEffects !== "write",
        // Only a write action can destroy state, and among writes only a
        // non-idempotent one cannot be safely repeated. Both facts are declared.
        destructiveHint: traits.sideEffects === "write" && traits.idempotency !== "idempotent",
        idempotentHint: traits.idempotency === "idempotent",
        requiredCapabilities: action.capabilities,
        approval: traits.approval,
      },
    });
  }

  return {
    protocol: schema.protocolVersion,
    generator,
    model: { ...schema.model },
    tools,
    $defs,
  };
}
