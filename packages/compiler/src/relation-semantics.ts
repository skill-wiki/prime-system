/**
 * @module relation-semantics
 *
 * The compiler's single read path for what a relation *means*.
 *
 * Plan §3.1 — the core may not know "whether `requires` should be a transitive
 * closure" or "whether `contradicts` should block a composition". Before this
 * module the compiler answered both questions from `switch` tables in
 * `resolver.ts`, which is why `supplies_to` kept its own load direction after
 * the model package changed it (coordinator decision D-7).
 *
 * There is deliberately no narrowing code here: `RelationDefinitionSchema` in
 * `@skill-wiki/model-schema` is a zod schema, so `semantics.loadOrder` and
 * friends arrive already typed as their enums. D-3 forbids a third hand-written
 * narrowing implementation and this module does not add one — it only builds a
 * spelling-to-definition lookup and names the three questions the compiler asks.
 */

import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import type { LoadedModel, RelationDefinition } from "@skill-wiki/model-schema";

/** Temporal direction as the dependency graph records it. */
export type LoadDirection = "before" | "after" | "during" | "any";

export interface RelationIndex {
  /** Canonical relation names, exactly as the model declares them. */
  readonly names: readonly string[];
  /**
   * Every spelling a source file may legally use: canonical names plus declared
   * `aliases`. This is what replaces hand-maintained field-key allow-lists.
   */
  readonly keys: readonly string[];
  /** The definition behind a spelling, or `undefined` for a verb the model does not declare. */
  definition(verb: string): RelationDefinition | undefined;
  /** The model's canonical name for a spelling; an undeclared verb passes through unchanged. */
  canonical(verb: string): string;
  /**
   * Load direction, from `semantics.loadOrder`.
   *
   * D-7: `before` means the edge's target (`to`) loads before its source
   * (`from`). The model has no `during`; that value can only arrive from an
   * explicit `direction:` field written in a source file.
   */
  direction(verb: string): LoadDirection;
  /**
   * Whether the relation excludes rather than depends — `semantics.selection`
   * of `exclude`. This is what `dep.type === "CONTRADICTS"` used to test, and
   * reading it from the model is why `conflicts` is now handled too: it
   * declares the same `exclude` selection and the switch table never listed it.
   */
  excludes(verb: string): boolean;
  /**
   * Whether the target is a mandatory part of the selection — `semantics.selection`
   * of `closure` (plan §5.3's `hard-closure`).
   *
   * The switch table this replaces answered `true` for `validates_with`,
   * `contradicts` and `supplies_to` as well. No single model field reproduces
   * that set (`validates-with` and `specializes` are both
   * `informational`/`none` yet the table disagreed about them), so it encoded a
   * judgement the model never declared. See the lane report §5.
   */
  required(verb: string): boolean;
  /**
   * Whether selecting the source also pulls the target in — `semantics.selection`
   * of `expand`. Weaker than `required`: the target belongs to the selection but
   * its absence is not fatal, which is the distinction `checker-l1` used to draw
   * by testing the two verb spellings `requires` and `enhances` by hand.
   */
  expands(verb: string): boolean;
  /**
   * Whether the relation points at a single ancestor: `cardinality: many-to-one`
   * on a `directional: true` relation. "Many instances, one target" *is* the
   * parent-pointer shape, so this reads a declaration rather than guessing.
   *
   * `checker-l3-cross` used it to suppress near-duplicate reports between two
   * atoms that share a parent, by hardcoding the single verb `specializes`. In
   * the v1 model `extends` and `derived-from` declare the same shape and were
   * silently excluded.
   */
  parentward(verb: string): boolean;
  /**
   * The relation the model declares as the hard-dependency closure, i.e. the
   * unique relation with `semantics.selection: closure`, or `undefined` when the
   * model declares none — or more than one, in which case the choice is the
   * model author's to disambiguate and not ours to guess.
   *
   * This is what a v1 `use[]` field desugars to. `RelationDefinition` has no
   * field that says "this is the `use` shorthand's relation", so the closure
   * selection is the closest thing the model actually declares; the alternative
   * was to keep the literal `"requires"` in `resolver.ts`.
   */
  readonly closureRelation: string | undefined;
}

function spellingsOf(definition: RelationDefinition): readonly string[] {
  return [definition.name, ...(definition.aliases ?? [])];
}

export function buildRelationIndex(model: LoadedModel): RelationIndex {
  const definitions = model.definitions.filter(
    (definition): definition is RelationDefinition => definition.kind === "relation",
  );
  const bySpelling = new Map<string, RelationDefinition>();
  for (const definition of definitions) {
    for (const spelling of spellingsOf(definition)) bySpelling.set(spelling, definition);
  }

  const definition = (verb: string): RelationDefinition | undefined => bySpelling.get(verb);

  const closures = definitions.filter(d => d.semantics.selection === "closure");

  return {
    names: definitions.map(d => d.name),
    keys: [...bySpelling.keys()],
    definition,
    canonical: verb => definition(verb)?.name ?? verb,
    direction: verb => {
      const loadOrder = definition(verb)?.semantics.loadOrder;
      return loadOrder === "before" || loadOrder === "after" ? loadOrder : "any";
    },
    excludes: verb => definition(verb)?.semantics.selection === "exclude",
    required: verb => definition(verb)?.semantics.selection === "closure",
    expands: verb => definition(verb)?.semantics.selection === "expand",
    parentward: verb => {
      const d = definition(verb);
      return d?.directional === true && d.cardinality === "many-to-one";
    },
    closureRelation: closures.length === 1 ? closures[0]!.name : undefined,
  };
}

/**
 * The v1 compatibility model's relations, loaded once from disk.
 *
 * Same shape as `defaultProjectionRules()` in `chunker.ts`: the relation set is
 * data in `compat/prime-v1-model/`, not a constant in the engine. The path is
 * still an engine-side default — §8.1's "resolve model packages" stage is what
 * should eventually supply it.
 */
let cached: RelationIndex | undefined;

export function defaultRelationIndex(): RelationIndex {
  if (!cached) {
    const here = dirname(fileURLToPath(import.meta.url));
    cached = buildRelationIndex(loadModelOrThrow(resolvePath(here, "../../../compat/prime-v1-model")));
  }
  return cached;
}
