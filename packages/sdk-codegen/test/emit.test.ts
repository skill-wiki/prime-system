/**
 * Naming and MCP projection, including the error paths. A generator's error paths
 * matter more than most: it is a batch process nobody watches, so anything it
 * decides silently ships.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import {
  buildCodegenSchema,
  camelCase,
  CodegenError,
  emitMcpTools,
  emitTypes,
  isBuiltinTypeRef,
  pascalCase,
  snakeCase,
  typeScriptNames,
  uniqueIdentifiers,
  BUILTIN_TYPE_REFS,
} from "../src/index.ts";

const model = loadModelOrThrow(resolve(import.meta.dir, "../../..", "packages/testkit/fixtures/security-model"));
const schema = buildCodegenSchema(model);

describe("model name -> identifier is mechanical", () => {
  test.each([
    ["depends-on", "DependsOn", "dependsOn", "depends_on"],
    ["AuditControl", "AuditControl", "auditControl", "audit_control"],
    ["security-controls", "SecurityControls", "securityControls", "security_controls"],
    ["anti-pattern", "AntiPattern", "antiPattern", "anti_pattern"],
    ["2fa-policy", "_2faPolicy", "_2faPolicy", "_2fa_policy"],
  ])("%s", (input, pascal, camel, snake) => {
    expect(pascalCase(input)).toBe(pascal);
    expect(camelCase(input)).toBe(camel);
    expect(snakeCase(input)).toBe(snake);
  });

  test("a name with no identifier-safe character is an error, not an empty identifier", () => {
    expect(() => pascalCase("---")).toThrow(CodegenError);
  });

  test("two model names collapsing to one identifier is an error, not a silent overwrite", () => {
    expect(() => uniqueIdentifiers(["audit-control", "audit_control"], pascalCase, "Action")).toThrow(
      /both map to the identifier 'AuditControl'/,
    );
  });

  test("the builtin ref set matches what model-schema accepts", () => {
    expect([...BUILTIN_TYPE_REFS]).toEqual(["string", "number", "boolean", "integer", "unknown", "*", "generic"]);
    expect(isBuiltinTypeRef("generic:list")).toBe(true);
    expect(isBuiltinTypeRef("Control")).toBe(false);
  });
});

describe("emitted TypeScript reflects declarations, not guesses", () => {
  const types = emitTypes(schema, typeScriptNames(schema.schema));

  test("a required field is required and an optional one is optional", () => {
    // types.yaml: Asset.classification is required, Asset.custodian is not.
    expect(types).toContain("readonly classification: string;");
    expect(types).toContain("readonly custodian?: string;");
  });

  test("a type-to-type field becomes the generated interface, not `unknown`", () => {
    expect(types).toContain("readonly assessedControl: Control;");
  });

  test("`integer` narrows to number and a declared description becomes a doc comment", () => {
    expect(types).toContain("readonly severity: number;");
    expect(types).toContain("/** 1 (low) to 5 (critical) */");
  });

  test("no `any` and no ts-ignore reaches the output", () => {
    expect(types).not.toContain(": any");
    expect(types).not.toContain("@ts-ignore");
  });
});

describe("MCP tools are projections of ActionDef", () => {
  const document = emitMcpTools(schema, "test");
  const byName = new Map(document.tools.map(tool => [tool.name, tool]));

  test("tool names are model-derived", () => {
    expect([...byName.keys()].sort()).toEqual([
      "security_controls_audit_control",
      "security_controls_record_evidence",
      "security_controls_retire_control",
    ]);
  });

  test("annotations come from declared sideEffects/idempotency, never inferred", () => {
    // behaviour.yaml: AuditControl read+idempotent, RecordEvidence write+idempotent,
    // RetireControl write+non-idempotent.
    expect(byName.get("security_controls_audit_control")!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      approval: "never",
    });
    expect(byName.get("security_controls_record_evidence")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      approval: "conditional",
    });
    expect(byName.get("security_controls_retire_control")!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      approval: "always",
    });
  });

  test("declared capabilities are carried through verbatim", () => {
    expect(byName.get("security_controls_record_evidence")!.annotations.requiredCapabilities).toEqual([
      "corpus.write",
      "evidence.append",
    ]);
  });

  test("an action input object is closed, matching what the runtime enforces", () => {
    const input = byName.get("security_controls_audit_control")!.inputSchema;
    expect(input.additionalProperties).toBe(false);
    expect(input.required).toEqual(["control"]);
    expect(input.properties).toEqual({ control: { $ref: "#/$defs/Control" } });
  });

  test("`additionalFields: reject` becomes additionalProperties:false in $defs", () => {
    expect((document.$defs.Control as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  test("a type-to-type field is a $ref, so a self-referential model still terminates", () => {
    const control = document.$defs.Control as { properties: Record<string, unknown> };
    expect(control.properties.guardedAsset).toEqual({ $ref: "#/$defs/Asset" });
  });

  test("output schema points at the action's declared output type", () => {
    expect(byName.get("security_controls_audit_control")!.outputSchema).toEqual({ $ref: "#/$defs/Assessment" });
    expect(byName.get("security_controls_retire_control")!.outputSchema).toEqual({ type: "boolean" });
  });
});
