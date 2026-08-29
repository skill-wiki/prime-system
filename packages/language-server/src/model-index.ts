/**
 * @module model-index
 * §14.2 `ModelResolver` + `SemanticIndex`, for the model side.
 *
 * The Language Server knows no type names and no field names of its own — every
 * one comes from a Model Package loaded through `@skill-wiki/model-schema`
 * (plan §3.1 / ADR-1). Nothing in this file may name a domain concept.
 */

import { loadModel, type Diagnostic as ModelDiagnostic, type LoadedModel, type TypeDefinition } from "@skill-wiki/model-schema";

export type ModelState =
  | { readonly kind: "none" }
  | { readonly kind: "loaded"; readonly index: ModelIndex }
  | { readonly kind: "invalid"; readonly root: string; readonly diagnostics: readonly ModelDiagnostic[] };

/** A field of a type, flattened for completion and field checking. */
export interface FieldInfo {
  readonly name: string;
  readonly typeRef: string;
  readonly required: boolean;
  readonly description?: string;
}

/**
 * Lookup tables over one loaded Model Package.
 *
 * Built once per load: a type/field completion is a keystroke-latency operation
 * and a linear scan of every definition per request is what makes an LSP feel slow.
 */
export class ModelIndex {
  readonly model: LoadedModel;
  private readonly typesByName: ReadonlyMap<string, TypeDefinition>;
  readonly typeNames: readonly string[];

  constructor(model: LoadedModel) {
    this.model = model;
    const types = new Map<string, TypeDefinition>();
    for (const definition of model.definitions) {
      if (definition.kind === "type") types.set(definition.name, definition);
    }
    this.typesByName = types;
    this.typeNames = [...types.keys()].sort();
  }

  get modelName(): string {
    return this.model.manifest.name;
  }

  /**
   * Resolve a possibly model-qualified reference.
   *
   * `@<model>/<type>` is the qualified spelling the v1 syntax macro emits
   * (`qualifyTypeRef` in `packages/compiler/src/normalizer.ts`). A reference
   * qualified with some *other* model resolves to nothing rather than falling
   * through to the bare name: a Runtime loads one model package, and a silent
   * fallthrough would let a foreign type name look valid.
   */
  resolveType(reference: string): TypeDefinition | undefined {
    if (reference.startsWith("@")) {
      const separator = reference.indexOf("/");
      if (separator < 0) return undefined;
      if (reference.slice(1, separator) !== this.modelName) return undefined;
      return this.typesByName.get(reference.slice(separator + 1));
    }
    return this.typesByName.get(reference);
  }

  fieldsOf(type: TypeDefinition): readonly FieldInfo[] {
    return type.fields.map(field => ({
      name: field.name,
      typeRef: field.typeRef,
      required: field.required === true,
      ...(field.description === undefined ? {} : { description: field.description }),
    }));
  }
}

/** Load a Model Package for editor use, keeping load failures as diagnostics. */
export function loadModelState(root: string | undefined): ModelState {
  if (root === undefined) return { kind: "none" };
  const result = loadModel(root);
  if (!result.ok) return { kind: "invalid", root, diagnostics: result.diagnostics };
  return { kind: "loaded", index: new ModelIndex(result.value) };
}
