import type { MigrationDefinition } from "./index.ts";

export interface MigratableRelation { readonly relationRef: string; readonly target: string }
export interface MigratableUnit {
  readonly id: string;
  readonly typeRef: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly relations: readonly MigratableRelation[];
}
export interface MigrationDiagnostic { readonly code: string; readonly message: string; readonly step: number }
export interface MigrationApplyResult {
  readonly ok: boolean;
  readonly value: MigratableUnit;
  readonly before: MigratableUnit;
  readonly affectedSteps: number;
  readonly diagnostics: readonly MigrationDiagnostic[];
}

const clone = <T>(value: T): T => structuredClone(value);

/** Deterministic, side-effect-free application suitable for dry-run and build tooling. */
export function applyMigration(unit: MigratableUnit, migration: MigrationDefinition): MigrationApplyResult {
  const before = clone(unit); const fields: Record<string, unknown> = clone(unit.fields); let relations = clone(unit.relations) as MigratableRelation[];
  const diagnostics: MigrationDiagnostic[] = []; let affectedSteps = 0;
  migration.steps.forEach((step, index) => {
    if ("renameField" in step) {
      const rule = step.renameField; if (unit.typeRef !== rule.type || !(rule.from in fields)) return;
      if (rule.to in fields) { diagnostics.push({ code: "MIGRATION_FIELD_CONFLICT", message: `${unit.id} already carries ${rule.to}`, step: index }); return; }
      fields[rule.to] = fields[rule.from]; delete fields[rule.from]; affectedSteps += 1; return;
    }
    if ("mapRelation" in step) {
      let changed = false; relations = relations.map(relation => relation.relationRef === step.mapRelation.from ? (changed = true, { ...relation, relationRef: step.mapRelation.to }) : relation);
      if (changed) affectedSteps += 1; return;
    }
    const rule = step.setDefault; if (unit.typeRef === rule.type && !(rule.field in fields)) { fields[rule.field] = clone(rule.value); affectedSteps += 1; }
  });
  return { ok: diagnostics.length === 0, value: { id: unit.id, typeRef: unit.typeRef, fields, relations }, before, affectedSteps, diagnostics };
}

/** Rollback is exact because an apply result carries the immutable pre-image. */
export function rollbackMigration(result: MigrationApplyResult): MigratableUnit { return clone(result.before); }
