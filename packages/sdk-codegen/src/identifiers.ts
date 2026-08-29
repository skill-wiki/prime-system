/**
 * @module identifiers
 *
 * Model names -> language identifiers.
 *
 * The mapping is purely mechanical (split on non-alphanumerics, re-case) so that
 * no model vocabulary is encoded here: `depends-on` becomes `DependsOn` for the
 * same reason `evaluate_artifact` would become `EvaluateArtifact`, and this file
 * contains no list of names it recognises.
 *
 * Collisions are an error, never a silent overwrite. Two model names can map to
 * one identifier (`audit-control` and `audit_control` both give `AuditControl`),
 * and generating one of them over the other would produce an SDK that is missing a
 * declaration while still compiling — the worst possible outcome, because it looks
 * like the model simply did not declare it.
 */

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodegenError";
  }
}

function segments(name: string): readonly string[] {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(part => part.length > 0);
  if (parts.length === 0) throw new CodegenError(`Model name '${name}' has no identifier-safe characters`);
  return parts;
}

/** A leading digit is prefixed rather than dropped: dropping it would collide `2fa` with `fa`. */
function guardLeadingDigit(identifier: string): string {
  return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
}

export function pascalCase(name: string): string {
  return guardLeadingDigit(
    segments(name)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(""),
  );
}

export function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return guardLeadingDigit(pascal.charAt(0).toLowerCase() + pascal.slice(1));
}

export function snakeCase(name: string): string {
  return guardLeadingDigit(
    segments(name)
      // A camelCase model name has to be split too, or `evaluateArtifact` and
      // `evaluate-artifact` would produce different tool names for the same shape.
      .flatMap(part => part.split(/(?=[A-Z])/))
      .map(part => part.toLowerCase())
      .filter(part => part.length > 0)
      .join("_"),
  );
}

/**
 * Apply a naming function across a set of model names, failing on any collision.
 * Returns model name -> identifier.
 */
export function uniqueIdentifiers(
  names: readonly string[],
  transform: (name: string) => string,
  label: string,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const name of [...names].sort()) {
    const identifier = transform(name);
    const owner = owners.get(identifier);
    if (owner !== undefined) {
      throw new CodegenError(
        `${label} names '${owner}' and '${name}' both map to the identifier '${identifier}'; rename one in the Model Package`,
      );
    }
    owners.set(identifier, name);
    out.set(name, identifier);
  }
  return out;
}
