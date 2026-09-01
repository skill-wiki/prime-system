/**
 * Model Package resolution and engine-context assembly.
 *
 * Everything the two engines need as *policy* — which generators run, which
 * feature axes exist and what they weigh, what a relation does to a selection,
 * which projections exist and what they cost — is read from a Model Package here.
 * The server contributes no defaults for any of it.
 *
 * Resolution order follows the convention already landed in this repo
 * (`compiler/src/chunker.ts:142`, `compiler/src/relation-semantics.ts:109`,
 * `testkit/src/cli.ts:54`): an explicit root wins, then the environment, then a
 * model shipped inside the bundle, then the v1 compatibility model that legacy
 * corpora are compiled against.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadModelOrThrow,
  type LoadedModel,
  type ProjectionDefinition,
  type RelationDefinition,
  type RetrievalProfile,
} from "@skill-wiki/model-schema";
import { ProjectionCatalog, type PurposeRouting } from "@skill-wiki/projection-engine";

const MODEL_MANIFEST = "prime-model.yaml";
/** Directory a bundle may carry its own model in, relative to the corpus root. */
const IN_BUNDLE_MODEL_DIR = "_model";
const MODEL_DIR_ENV = "AOE_MODEL_DIR";

const here = dirname(fileURLToPath(import.meta.url));

export interface ModelResolution {
  readonly root: string;
  /** Which rule produced `root`; surfaced on stderr so a wrong model is visible. */
  readonly origin: "explicit" | "environment" | "bundle" | "compatibility-default";
}

export function resolveModelRoot(
  corpusDir: string,
  environment: Record<string, string | undefined>,
  explicit?: string,
): ModelResolution {
  if (explicit !== undefined && explicit !== "") {
    return { root: isAbsolute(explicit) ? explicit : resolve(explicit), origin: "explicit" };
  }
  const fromEnv = environment[MODEL_DIR_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    return { root: isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv), origin: "environment" };
  }
  const inBundle = join(corpusDir, IN_BUNDLE_MODEL_DIR);
  if (existsSync(join(inBundle, MODEL_MANIFEST))) {
    return { root: resolve(inBundle), origin: "bundle" };
  }
  return {
    root: resolve(here, "../../../compat/prime-v1-model"),
    origin: "compatibility-default",
  };
}

export interface ServeModel {
  readonly resolution: ModelResolution;
  readonly model: LoadedModel;
  readonly profiles: Readonly<Record<string, RetrievalProfile>>;
  readonly relations: Readonly<Record<string, RelationDefinition>>;
  readonly projections: Readonly<Record<string, ProjectionDefinition>>;
  readonly catalog: ProjectionCatalog;
  /** Purpose → profile routing, derived from each retrieval profile's own `projection`. */
  readonly routing: PurposeRouting;
}

export class ModelContextError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ModelContextError";
  }
}

/**
 * Load a Model Package and index its definitions by name.
 *
 * A relation carrying `aliases` is indexed under every alias as well, because a
 * corpus is free to spell an edge with any of them and an unresolvable
 * `relationRef` would silently lose the edge's semantics.
 */
export function loadServeModel(resolution: ModelResolution): ServeModel {
  const model = loadModelOrThrow(resolution.root);
  const profiles: Record<string, RetrievalProfile> = {};
  const relations: Record<string, RelationDefinition> = {};
  const projections: Record<string, ProjectionDefinition> = {};

  for (const definition of model.definitions) {
    if (definition.kind === "retrieval-profile") profiles[definition.name] = definition;
    else if (definition.kind === "projection") projections[definition.name] = definition;
    else if (definition.kind === "relation") {
      relations[definition.name] = definition;
      for (const alias of definition.aliases ?? []) relations[alias] = definition;
    }
  }

  if (Object.keys(profiles).length === 0) {
    throw new ModelContextError(
      "MODEL_NO_RETRIEVAL_PROFILE",
      `Model package at ${resolution.root} declares no retrieval profile, so no query could be planned`,
    );
  }
  if (Object.keys(projections).length === 0) {
    throw new ModelContextError(
      "MODEL_NO_PROJECTION",
      `Model package at ${resolution.root} declares no projection, so no result could be rendered`,
    );
  }

  const catalog = ProjectionCatalog.fromDefinitions(model.definitions);
  // A retrieval profile already names the projection it wants; reusing that as the
  // purpose routing keeps the mapping in model data instead of in this file.
  const byPurpose: Record<string, readonly string[]> = {};
  for (const profile of Object.values(profiles)) {
    byPurpose[profile.name] = [profile.projection];
  }

  return { resolution, model, profiles, relations, projections, catalog, routing: { byPurpose } };
}

/**
 * The declared projections that are strictly cheaper than `primary`, cheapest
 * last so the budget walk tries the most faithful rendering first.
 *
 * Derived from `targetTokens` rather than from a hand-written chain: a chain
 * spelled out here would be three level names, which is exactly the closed set
 * this refactor exists to delete.
 */
export function cheaperProjections(
  primary: string,
  projections: Readonly<Record<string, ProjectionDefinition>>,
): readonly string[] {
  const primaryDefinition = projections[primary];
  if (primaryDefinition === undefined) return [];
  return Object.values(projections)
    .filter((candidate) => candidate.targetTokens < primaryDefinition.targetTokens)
    .sort((a, b) => b.targetTokens - a.targetTokens || a.name.localeCompare(b.name))
    .map((candidate) => candidate.name);
}
