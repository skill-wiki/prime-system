import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { applyMigration, loadModelOrThrow, rollbackMigration, type MigrationDefinition } from "../src/index.ts";

const model = loadModelOrThrow(join(import.meta.dir, "fixtures", "ticket-model"));
const migration = model.definitions.find((definition): definition is MigrationDefinition => definition.kind === "migration")!;

describe("explicit model migration", () => {
  it("applies rename, relation mapping and default without mutating its input", () => {
    const input = { id: "T-1", typeRef: "Ticket", fields: { subject: "Outage" }, relations: [{ relationRef: "assigned-to", target: "owner/a" }] };
    const result = applyMigration(input, migration);
    expect(result.ok).toBe(true);
    expect(result.affectedSteps).toBe(3);
    expect(result.value).toEqual({ id: "T-1", typeRef: "Ticket", fields: { title: "Outage", active: true }, relations: [{ relationRef: "owned-by", target: "owner/a" }] });
    expect(input.fields).toEqual({ subject: "Outage" });
  });

  it("round-trips exactly through the recorded pre-image", () => {
    const input = { id: "T-2", typeRef: "Ticket", fields: { subject: "Latency", priority: 1 }, relations: [] };
    expect(rollbackMigration(applyMigration(input, migration))).toEqual(input);
  });

  it("fails closed rather than overwriting a target field", () => {
    const input = { id: "T-3", typeRef: "Ticket", fields: { subject: "old", title: "new" }, relations: [] };
    const result = applyMigration(input, migration);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("MIGRATION_FIELD_CONFLICT");
  });
});
