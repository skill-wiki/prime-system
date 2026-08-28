/**
 * Projection profiles, built from model *data*.
 *
 * Plan §5.5 writes a profile as `levels: {summary, core, full}`, but the landed
 * `ProjectionDefinitionSchema` (model-schema/src/index.ts:15) is flat: one
 * definition carries exactly one `targetTokens`. So a multi-level profile is a
 * *set* of definitions, and this module is the only place that decides how they
 * group. Both groupings come from data:
 *
 *   1. `extensions.profile` / `extensions.level` — explicit, preferred.
 *   2. the definition name spelled `<profile>/<level>` — conventional fallback.
 *   3. neither — a single-level profile whose level name is the definition name.
 *
 * `summary`/`core`/`full` are therefore never mentioned in this package: they are
 * whatever a Model Package happens to call its levels. Likewise the field lists
 * (`include`/`exclude`/`typeGroups`/`rules`) are read, never authored here.
 */

import type { ProjectionDefinition } from "@skill-wiki/model-schema";
import type { ProjectionDefIR, ValueIR } from "@skill-wiki/ir";

/** One resolved level: the selector program for a single token budget. */
export interface ProjectionLevel {
  readonly profile: string;
  readonly level: string;
  readonly definitionName: string;
  readonly version: string;
  readonly targetTokens: number;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly typeGroups: Readonly<Record<string, readonly string[]>>;
  readonly rules: readonly ProjectionRule[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface ProjectionRule {
  readonly layer?: string;
  readonly typeRef?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ProjectionProfile {
  readonly name: string;
  /** Levels ordered by ascending `targetTokens` — cheapest first. */
  readonly levels: readonly ProjectionLevel[];
}

/** Separator between profile and level inside a definition name. */
const NAME_SEPARATOR = "/";

function readStringExtension(
  extensions: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const raw = extensions?.[key];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function splitName(name: string): { profile: string; level: string } {
  const at = name.lastIndexOf(NAME_SEPARATOR);
  if (at <= 0 || at === name.length - 1) return { profile: name, level: name };
  return { profile: name.slice(0, at), level: name.slice(at + 1) };
}

/** Normalise one `ProjectionDefinition` into a level. */
export function levelFromDefinition(definition: ProjectionDefinition): ProjectionLevel {
  const fallback = splitName(definition.name);
  const profile = readStringExtension(definition.extensions, "profile") ?? fallback.profile;
  const level = readStringExtension(definition.extensions, "level") ?? fallback.level;
  return {
    profile,
    level,
    definitionName: definition.name,
    version: definition.version,
    targetTokens: definition.targetTokens,
    include: definition.include,
    exclude: definition.exclude,
    typeGroups: definition.typeGroups,
    rules: definition.rules,
    extensions: definition.extensions ?? {},
  };
}

function stringArray(value: ValueIR | undefined): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : undefined;
}

function optionalString(value: ValueIR | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Normalise a `ProjectionDefIR` into a level.
 *
 * `ProjectionDefIR` (ir/src/index.ts:21) carries only `rules`, so a definition
 * that came through the IR has lost its top-level `include`/`exclude`/
 * `typeGroups`. We recover an equivalent selector program by reading rules that
 * name neither a layer nor a typeRef as the definition-wide include/exclude —
 * which is the same thing the flat fields mean. See the lane report for the
 * proposed IR fix; this is a lossy read, not a shim.
 */
export function levelFromIR(definition: ProjectionDefIR): ProjectionLevel {
  const fallback = splitName(definition.name);
  const rules: ProjectionRule[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  let profile = fallback.profile;
  let level = fallback.level;

  for (const raw of definition.rules) {
    const layer = optionalString(raw["layer"]);
    const typeRef = optionalString(raw["typeRef"]);
    const ruleInclude = stringArray(raw["include"]);
    const ruleExclude = stringArray(raw["exclude"]);
    const ruleProfile = optionalString(raw["profile"]);
    const ruleLevel = optionalString(raw["level"]);
    if (ruleProfile) profile = ruleProfile;
    if (ruleLevel) level = ruleLevel;
    if (layer === undefined && typeRef === undefined) {
      if (ruleInclude) include.push(...ruleInclude);
      if (ruleExclude) exclude.push(...ruleExclude);
      continue;
    }
    rules.push({
      ...(layer === undefined ? {} : { layer }),
      ...(typeRef === undefined ? {} : { typeRef }),
      ...(ruleInclude === undefined ? {} : { include: ruleInclude }),
      ...(ruleExclude === undefined ? {} : { exclude: ruleExclude }),
    });
  }

  return {
    profile,
    level,
    definitionName: definition.name,
    version: definition.version,
    targetTokens: definition.targetTokens,
    include,
    exclude,
    typeGroups: {},
    rules,
    extensions: {},
  };
}

export class ProjectionCatalog {
  private readonly byProfile: ReadonlyMap<string, ProjectionProfile>;

  private constructor(byProfile: ReadonlyMap<string, ProjectionProfile>) {
    this.byProfile = byProfile;
  }

  static fromLevels(levels: readonly ProjectionLevel[]): ProjectionCatalog {
    const grouped = new Map<string, ProjectionLevel[]>();
    for (const level of levels) {
      const bucket = grouped.get(level.profile);
      if (bucket) bucket.push(level);
      else grouped.set(level.profile, [level]);
    }
    const byProfile = new Map<string, ProjectionProfile>();
    for (const [name, bucket] of grouped) {
      // Ascending budget is the order the budget solver degrades along, so it is
      // established once here instead of at every call site.
      const ordered = [...bucket].sort(
        (a, b) => a.targetTokens - b.targetTokens || a.level.localeCompare(b.level),
      );
      byProfile.set(name, { name, levels: ordered });
    }
    return new ProjectionCatalog(byProfile);
  }

  /** Accepts any definition list; non-projection definitions are ignored. */
  static fromDefinitions(definitions: readonly { readonly kind: string }[]): ProjectionCatalog {
    const projections = definitions.filter(
      (d): d is ProjectionDefinition => d.kind === "projection",
    );
    return ProjectionCatalog.fromLevels(projections.map(levelFromDefinition));
  }

  static fromSchemaIR(projections: Readonly<Record<string, ProjectionDefIR>>): ProjectionCatalog {
    return ProjectionCatalog.fromLevels(Object.values(projections).map(levelFromIR));
  }

  profiles(): readonly string[] {
    return [...this.byProfile.keys()].sort();
  }

  profile(name: string): ProjectionProfile | undefined {
    return this.byProfile.get(name);
  }

  level(profile: string, level: string): ProjectionLevel | undefined {
    return this.byProfile.get(profile)?.levels.find((candidate) => candidate.level === level);
  }

  /** Levels of `profile`, cheapest first. Empty when the profile is unknown. */
  levels(profile: string): readonly ProjectionLevel[] {
    return this.byProfile.get(profile)?.levels ?? [];
  }
}
