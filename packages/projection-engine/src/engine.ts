/**
 * The projection engine: one call turns a request plus a set of units into
 * delivered payloads, a budget plan and an explanation.
 *
 * Order of operations is a security property, not a style choice. Redaction runs
 * before delivery, and the `path` transport is refused for a redacted unit
 * (transport.ts) because the file on disk still holds the secret. Cache lookup
 * happens after the scope is assembled so a key can never be missing its tenant.
 */

import type { DiagnosticIR, SnapshotRef, UnitIR } from "@skill-wiki/ir";
import type { ProjectionCatalog, ProjectionLevel } from "./profile.ts";
import { candidateLevels, resolveProfile, type ProjectionRequest, type PurposeRouting } from "./select.ts";
import { solveBudget, type BudgetPlan } from "./budget.ts";
import { redactText, redactUnitFields, type RedactionPolicy } from "./redact.ts";
import { deliver, negotiateTransport, type ProjectionPayload, type TransportKind } from "./transport.ts";
import { ProjectionCache, type CacheScope, type CacheSubject } from "./cache.ts";
import type { ProjectionUri } from "./uri.ts";

/** How to find a unit's artifact for a given level. Supplied by the adapter. */
export type ArtifactLocator = (unit: UnitIR, level: ProjectionLevel) => string | undefined;

export interface ProjectionEngineOptions {
  readonly catalog: ProjectionCatalog;
  readonly routing: PurposeRouting;
  readonly bundleRoot: string;
  readonly locate: ArtifactLocator;
  readonly redaction?: RedactionPolicy;
  readonly cache?: ProjectionCache<ProjectionPayload>;
}

export interface ProjectionScope {
  readonly tenant: string;
  readonly workspace: string;
  readonly corpus: string;
  readonly release: string;
  readonly snapshot: SnapshotRef;
}

export interface ProjectedUnit {
  readonly unitId: string;
  readonly profile: string;
  readonly level: string;
  readonly payload: ProjectionPayload;
  readonly redactedPaths: readonly string[];
  readonly cacheKeyed: boolean;
}

export interface ProjectionResult {
  readonly profile: string;
  readonly transport: TransportKind;
  readonly units: readonly ProjectedUnit[];
  readonly budget: BudgetPlan;
  readonly diagnostics: readonly DiagnosticIR[];
}

function diagnostic(code: string, message: string, severity: DiagnosticIR["severity"]): DiagnosticIR {
  return { code, message, severity };
}

export class ProjectionEngine {
  private readonly cache: ProjectionCache<ProjectionPayload>;

  constructor(private readonly options: ProjectionEngineOptions) {
    this.cache = options.cache ?? new ProjectionCache<ProjectionPayload>();
  }

  project(
    units: readonly UnitIR[],
    request: ProjectionRequest,
    scope: ProjectionScope,
  ): ProjectionResult {
    const diagnostics: DiagnosticIR[] = [];
    const transport = negotiateTransport(request.consumer.transports);
    if (transport === undefined) {
      throw new Error("Consumer declares no supported transport");
    }

    const resolution = resolveProfile(this.options.catalog, this.options.routing, request.purpose);
    if (!resolution.ok) {
      return {
        profile: "",
        transport,
        units: [],
        budget: { maxTokens: request.budget.maxTokens, consumedTokens: 0, assignments: [], degraded: [], dropped: [] },
        diagnostics: [diagnostic("PROJECTION_PROFILE_UNRESOLVED", resolution.reason, "error")],
      };
    }

    // Narrow per unit first: the budget solver needs to know what is even
    // applicable before it can decide what to sacrifice.
    const perUnit = units.map((unit) => {
      const candidates = candidateLevels(resolution.levels, unit, request, resolution.profile);
      for (const rejection of candidates.rejected) {
        diagnostics.push(
          diagnostic(
            "PROJECTION_LEVEL_REJECTED",
            `${unit.identity.id} / ${rejection.level.definitionName}: ${rejection.reason}`,
            "info",
          ),
        );
      }
      return { unit, levels: candidates.levels };
    });

    const budget = solveBudget(
      perUnit.map((entry, index) => ({
        unitId: entry.unit.identity.id,
        levels: entry.levels,
        // Absent an external score, earlier units rank higher; the caller can
        // override by ordering the input.
        priority: units.length - index,
      })),
      request.budget.maxTokens,
    );

    for (const drop of budget.dropped) {
      diagnostics.push(diagnostic("PROJECTION_UNIT_DROPPED", `${drop.unitId}: ${drop.reason}`, "warning"));
    }
    for (const degradation of budget.degraded) {
      diagnostics.push(
        diagnostic(
          "PROJECTION_UNIT_DEGRADED",
          `${degradation.unitId}: ${degradation.from.level} → ${degradation.to.level}: ${degradation.reason}`,
          "info",
        ),
      );
    }

    const byId = new Map(units.map((unit) => [unit.identity.id, unit]));
    const cacheScope: CacheScope = {
      tenant: scope.tenant,
      workspace: scope.workspace,
      corpus: scope.corpus,
      release: scope.release,
      policyRefs: request.policy.refs,
      snapshot: scope.snapshot,
    };

    const projected: ProjectedUnit[] = [];
    for (const assignment of budget.assignments) {
      const unit = byId.get(assignment.unitId);
      if (unit === undefined) continue;
      const level = assignment.level;
      const artifactPath = this.options.locate(unit, level);
      if (artifactPath === undefined) {
        diagnostics.push(
          diagnostic(
            "PROJECTION_ARTIFACT_MISSING",
            `${unit.identity.id}: no artifact for level ${level.definitionName}`,
            "error",
          ),
        );
        continue;
      }

      const subject: CacheSubject = {
        unitId: unit.identity.id,
        unitVersion: unit.identity.version,
        unitDigest: unit.identity.digest,
        profile: level.profile,
        level: level.level,
        levelVersion: level.version,
        transport,
      };

      const cached = this.cache.get(cacheScope, subject);
      if (cached !== undefined) {
        projected.push({
          unitId: unit.identity.id,
          profile: level.profile,
          level: level.level,
          payload: cached,
          redactedPaths: [],
          cacheKeyed: true,
        });
        continue;
      }

      const uri: ProjectionUri = {
        tenant: scope.tenant,
        corpus: scope.corpus,
        release: scope.release,
        unitId: unit.identity.id,
        profile: level.profile,
        level: level.level,
      };

      const policy = this.options.redaction;
      let overrideContent: string | undefined;
      let redactedPaths: readonly string[] = [];
      if (policy !== undefined) {
        const fieldOutcome = redactUnitFields(unit, policy);
        redactedPaths = fieldOutcome.redactedPaths;
        if (redactedPaths.length > 0) {
          // Read once here so the rendered body is scrubbed with the same rules
          // that scrubbed the structured fields.
          const raw = this.readArtifact(uri, artifactPath);
          if (raw === undefined) {
            diagnostics.push(
              diagnostic("PROJECTION_ARTIFACT_UNREADABLE", `${unit.identity.id}: ${artifactPath}`, "error"),
            );
            continue;
          }
          overrideContent = redactText(raw, unit, policy).value;
        }
      }

      const result = deliver(
        transport,
        { bundleRoot: this.options.bundleRoot, artifactPath, uri },
        overrideContent === undefined ? {} : { overrideContent },
      );
      if (!result.ok) {
        diagnostics.push(
          diagnostic("PROJECTION_DELIVERY_REFUSED", `${unit.identity.id}: ${result.code}: ${result.reason}`, "error"),
        );
        continue;
      }
      this.cache.set(cacheScope, subject, result.payload);
      projected.push({
        unitId: unit.identity.id,
        profile: level.profile,
        level: level.level,
        payload: result.payload,
        redactedPaths,
        cacheKeyed: false,
      });
    }

    return { profile: resolution.profile, transport, units: projected, budget, diagnostics };
  }

  /** Reads through the containment check; `undefined` means refused or absent. */
  private readArtifact(uri: ProjectionUri, artifactPath: string): string | undefined {
    const result = deliver("inline", { bundleRoot: this.options.bundleRoot, artifactPath, uri });
    if (!result.ok) return undefined;
    return result.payload.transport === "inline" ? result.payload.content : undefined;
  }
}
