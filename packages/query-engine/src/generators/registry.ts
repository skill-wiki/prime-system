/**
 * @module generators/registry
 *
 * Generators are registered by the host under the names a `RetrievalProfile`
 * uses. Nothing is registered by default: an engine that ships a default
 * generator set also ships default axis names, and the profile stops being the
 * single source of retrieval configuration.
 */

import { compareStrings } from "../deterministic.ts";
import { diagnostic, fail, QueryEngineError, type CandidateGenerator } from "../types.ts";

export class CandidateGeneratorRegistry {
  private readonly byName = new Map<string, CandidateGenerator>();

  register(generator: CandidateGenerator): this {
    if (generator.name.length === 0) fail("GENERATOR_NAME_EMPTY", "Generator name must be non-empty");
    if (generator.featureAxes.length === 0) {
      fail(
        "GENERATOR_NO_AXES",
        `Generator '${generator.name}' declares no feature axis, so its output could never be weighted`,
      );
    }
    if (this.byName.has(generator.name)) {
      fail("GENERATOR_DUPLICATE", `Generator '${generator.name}' is already registered`);
    }
    this.byName.set(generator.name, generator);
    return this;
  }

  get(name: string): CandidateGenerator | undefined {
    return this.byName.get(name);
  }

  names(): readonly string[] {
    return [...this.byName.keys()].sort(compareStrings);
  }

  /**
   * Resolve the profile's generator list, reporting *all* unknown names at once
   * so a mis-wired model does not need one round-trip per typo.
   */
  resolve(names: readonly string[]): readonly CandidateGenerator[] {
    const unknown = names.filter(name => !this.byName.has(name));
    if (unknown.length > 0) {
      throw new QueryEngineError(
        unknown.map(name =>
          diagnostic(
            "GENERATOR_NOT_REGISTERED",
            `Retrieval profile requests generator '${name}', registered: [${this.names().join(", ")}]`,
            "error",
          ),
        ),
      );
    }
    return names.map(name => this.byName.get(name)!);
  }
}

/**
 * A registered but deliberately inert generator. This is how a retrieval axis is
 * *reserved* without being implemented — the plan (§18.3) is explicit that vector
 * retrieval is a later plugin, not an engine concept, and a loud throw is better
 * than silently returning zero candidates and letting recall quietly degrade.
 */
export function createUnimplementedGenerator(config: {
  readonly name: string;
  readonly featureAxes: readonly string[];
  readonly reason: string;
}): CandidateGenerator {
  return {
    name: config.name,
    featureAxes: config.featureAxes,
    generate() {
      return fail(
        "GENERATOR_NOT_IMPLEMENTED",
        `Generator '${config.name}' is a reserved slot and has no implementation: ${config.reason}`,
      );
    },
  };
}
