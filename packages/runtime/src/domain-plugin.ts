/**
 * @module domain-plugin
 * Domain plugins describe how a corpus should be retrieved. The system has
 * no built-in domains; all domains are loaded from `domain.yaml` files via
 * `discoverDomains()` in `./domain-config.ts`.
 *
 * A DomainPlugin supplies:
 *   - `name`    the domain identifier used in tags/scope filters
 *   - `tags`    the canonical tag vocabulary for the domain; used by
 *               CorpusIndex to bias ranking toward in-domain atoms
 *   - `scopeCheck(ast)` — does this prime belong to this domain?
 *   - `extraHeuristics(ast)` — optional domain-specific L2 heuristics
 *     that augment the generic checker-l2-heuristic pass
 *
 * Plugins register once into a DomainRegistry. Queries / bundles may scope
 * to one or more domains; atoms that don't pass any registered scopeCheck
 * remain queryable but unbiased.
 *
 * The system ships ZERO built-in (code-defined) domains. All domains are
 * loaded from `domain.yaml` files via `discoverDomains()` in
 * `./domain-config.ts`. Bundled corpora may include their own `domain.yaml`
 * files; users can edit, disable, or replace them.
 */

import type { PrimeAST, AtomDeclaration, FieldNode, ArrayNode, StringNode } from "@prime-lang/types";

type AnyAST = PrimeAST | AtomDeclaration;

/** A single domain-scoped diagnostic emitted by a plugin heuristic. */
export interface DomainDiagnostic {
  level: "error" | "warn" | "suggestion";
  code: string;
  message: string;
  suggestion?: string;
}

export interface DomainPlugin {
  /** Stable domain identifier, kebab-case (e.g. "frontend-design"). */
  readonly name: string;
  /** Canonical tag vocabulary — used for ranking and scope checks. */
  readonly tags: ReadonlyArray<string>;
  /** True if this prime belongs to the domain. */
  scopeCheck(ast: AnyAST): boolean;
  /** Optional domain-specific L2 heuristics. */
  extraHeuristics?(ast: AnyAST): DomainDiagnostic[];
}

function astTags(ast: AnyAST): Set<string> {
  const f = ast.body.find((x): x is FieldNode => x.key === "tags");
  if (!f || f.value.type !== "Array") return new Set();
  const out = new Set<string>();
  for (const v of (f.value as ArrayNode).items) {
    if (v.type === "String") out.add((v as StringNode).value.toLowerCase());
  }
  return out;
}

export class DomainRegistry {
  private readonly plugins: Map<string, DomainPlugin> = new Map();

  register(plugin: DomainPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`domain "${plugin.name}" is already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): DomainPlugin | undefined {
    return this.plugins.get(name);
  }

  names(): string[] {
    return [...this.plugins.keys()];
  }

  /** All registered plugins whose scopeCheck returns true for this AST. */
  matching(ast: AnyAST): DomainPlugin[] {
    const out: DomainPlugin[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.scopeCheck(ast)) out.push(plugin);
    }
    return out;
  }

  /** Run every matching plugin's extra heuristics, flatten results. */
  runHeuristics(ast: AnyAST): DomainDiagnostic[] {
    const out: DomainDiagnostic[] = [];
    for (const plugin of this.matching(ast)) {
      if (plugin.extraHeuristics) out.push(...plugin.extraHeuristics(ast));
    }
    return out;
  }
}
