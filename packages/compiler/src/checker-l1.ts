/**
 * @module checker-l1
 * Level 1: Structural checker — deterministic, no AI, runs offline.
 *
 * Performs all checks that can be done with pure code analysis:
 * - Step error handlers
 * - Threshold ordering
 * - Reference existence
 * - Decorator constraints (@sealed, @abstract)
 * - Inheritance depth limits
 *
 * Required-field checking is deliberately NOT here. It used to be three
 * hardcoded `extends`-base-class branches (`Knowledge`/`Method`/`Rule`), which
 * made the engine own a piece of the domain ontology and — measurably — assert
 * the opposite of the external model: `compat/prime-v1-model/types.yaml`
 * declares `method`'s `input`/`output`/`steps` and `rule`'s `checks` as
 * `required: false`, so a model author could not relax a rule the engine
 * enforced. The model-driven implementation of the same capability already
 * exists and is the one on the production compile path:
 * `normalizer.ts` emits `MISSING_REQUIRED_FIELD` from
 * `TypeDefinition.fields[].required`. Two implementations of one rule, one of
 * them hardcoded, is what plan §3.1 forbids.
 */

import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  ValueNode,
  StepNode,
  ThresholdNode,
  ArrayNode,
  ObjectNode,
  StringNode,
  ReferenceNode,
  LinkShorthandNode,
  DecoratorNode,
} from "@aoe/types";
import type { Diagnostic, InstalledPrime } from "./types";
import { defaultRelationIndex, type RelationIndex } from "./relation-semantics";

// ─── Helpers ───────────────────────────────────────────────────────────────

type AnyAST = PrimeAST | AtomDeclaration;

/** True when the node is a legacy PrimeDeclaration (has .extends). */
function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

/**
 * Find a top-level field in the AST body by key name.
 */
function findField(ast: AnyAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

/**
 * Check if a decorator is present on the AST.
 */
function hasDecorator(ast: AnyAST, name: string): boolean {
  return ast.decorators.some((d) => d.name === name);
}

/**
 * Extract all step nodes from the steps array field.
 */
function getSteps(ast: AnyAST): StepNode[] {
  const stepsField = findField(ast, "steps");
  if (!stepsField || stepsField.value.type !== "Array") return [];
  return (stepsField.value as ArrayNode).items.filter(
    (item): item is StepNode => item.type === "Step"
  );
}

/**
 * Extract threshold nodes from the thresholds array field.
 */
function getThresholds(ast: AnyAST): ThresholdNode[] {
  const field = findField(ast, "thresholds");
  if (!field || field.value.type !== "Array") return [];
  return (field.value as ArrayNode).items.filter(
    (item): item is ThresholdNode => item.type === "Threshold"
  );
}

/**
 * Extract all referenced AOE identifiers from use[] field.
 */
function getUseReferences(ast: AnyAST): Array<{ name: string; line: number }> {
  const useField = findField(ast, "use");
  if (!useField || useField.value.type !== "Array") return [];
  const refs: Array<{ name: string; line: number }> = [];
  for (const item of (useField.value as ArrayNode).items) {
    if (item.type === "Reference") {
      refs.push({ name: (item as ReferenceNode).path[0], line: item.loc.line });
    } else if (item.type === "String") {
      refs.push({ name: (item as StringNode).value, line: item.loc.line });
    }
  }
  return refs;
}

/**
 * Extract all link targets from links[] field.
 */
function getLinkTargets(ast: AnyAST): Array<{ type: string; to: string; line: number }> {
  const linksField = findField(ast, "links");
  if (!linksField || linksField.value.type !== "Array") return [];
  const targets: Array<{ type: string; to: string; line: number }> = [];
  for (const item of (linksField.value as ArrayNode).items) {
    if (item.type === "LinkShorthand") {
      const link = item as LinkShorthandNode;
      targets.push({ type: link.verb, to: link.target, line: item.loc.line });
    } else if (item.type === "Object") {
      const obj = item as ObjectNode;
      const typeField = obj.fields.find((f) => f.key === "type");
      const toField = obj.fields.find((f) => f.key === "to");
      if (typeField && toField) {
        const linkType =
          typeField.value.type === "Ident"
            ? typeField.value.value
            : typeField.value.type === "String"
              ? (typeField.value as StringNode).value
              : "";
        const linkTo =
          toField.value.type === "String"
            ? (toField.value as StringNode).value
            : "";
        targets.push({ type: linkType, to: linkTo, line: item.loc.line });
      }
    }
  }
  return targets;
}

/**
 * Extract the numeric value from a threshold level, normalizing
 * both direct NumberNode values and comparison objects.
 */
function getThresholdNumericValue(
  level: { level: string; operator: string; value: number; unit?: string }
): number {
  return level.value;
}

/**
 * Check if a step has an error handler or @safe decorator.
 */
function stepHasErrorHandler(step: StepNode): boolean {
  for (const entry of step.body) {
    if (entry.type === "Field") {
      const field = entry as FieldNode;
      // error_handler or error field
      if (field.key === "error_handler" || field.key === "error") {
        return true;
      }
    }
    if (entry.type === "String") {
      const str = entry as StringNode;
      if (str.value === "@safe") return true;
    }
  }
  // Check for @safe in step body fields that are Ident nodes
  for (const entry of step.body) {
    if (entry.type === "Field") {
      const field = entry as FieldNode;
      if (field.value.type === "Ident" && field.value.value === "@safe") return true;
      if (field.value.type === "String" && (field.value as StringNode).value === "@safe") return true;
    }
  }
  return false;
}

/**
 * Compute inheritance depth by walking the extends chain.
 */
function getInheritanceDepth(
  ast: AnyAST,
  installedPrimes: Map<string, InstalledPrime>
): number {
  let depth = 0;
  let current: string | undefined = isPrimeAST(ast) ? ast.extends : undefined;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    depth++;
    const parent = installedPrimes.get(current);
    // We look at the parent's AST or just stop if not available
    current = undefined;
    if (parent?.ast) {
      const parentAst = parent.ast as PrimeAST;
      current = parentAst.extends;
    }
  }
  return depth;
}

/**
 * Convert PascalCase or camelCase to kebab-case.
 * TestCoverageStandard → test-coverage-standard
 */
function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// ─── Main Checker ──────────────────────────────────────────────────────────

/**
 * Run Level 1 structural checks on a parsed AOE AST.
 *
 * @param ast - The parsed AST from the parser
 * @param installedPrimes - Map of installed AOE names for reference checking
 * @returns Array of diagnostics (errors and warnings)
 */
export function checkL1(
  ast: AnyAST,
  installedPrimes: Map<string, InstalledPrime> = new Map(),
  relations: RelationIndex = defaultRelationIndex()
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const push = (
    level: Diagnostic["level"],
    line: number,
    message: string,
    suggestion?: string
  ) => {
    diagnostics.push({ level, line, message, suggestion, source: "L1:structure" });
  };

  // ── 1. Validate name is a legal identifier ────────────────────────────
  const nameField = findField(ast, "name");
  if (nameField) {
    const nameVal =
      nameField.value.type === "String"
        ? (nameField.value as StringNode).value
        : "";
    if (nameVal && !/^[a-z][a-z0-9-]*$/.test(nameVal)) {
      push(
        "error",
        nameField.loc.line,
        `Invalid identifier "${nameVal}": must be kebab-case [a-z][a-z0-9-]*`,
        "Rename to a valid kebab-case identifier"
      );
    }
  }

  // ── 2. Validate version is semver ─────────────────────────────────────
  const versionField = findField(ast, "version");
  if (versionField) {
    const verVal =
      versionField.value.type === "String"
        ? (versionField.value as StringNode).value
        : "";
    if (verVal && !/^\d+\.\d+\.\d+$/.test(verVal)) {
      push(
        "error",
        versionField.loc.line,
        `Invalid version "${verVal}": must be semver (major.minor.patch)`,
        'Use format "X.Y.Z" e.g. "1.0.0"'
      );
    }
  }

  // ── 3. Every Step must have error_handler or @safe ────────────────────
  const steps = getSteps(ast);
  for (const step of steps) {
    if (!stepHasErrorHandler(step)) {
      push(
        "error",
        step.loc.line,
        `Step "${step.name}" is missing error_handler or @safe`,
        `Add error: "..." or @safe to step ${step.name}`
      );
    }
  }

  // ── 4. Threshold values must be strictly increasing: block < warn < pass
  const thresholds = getThresholds(ast);
  for (const threshold of thresholds) {
    const levels = threshold.levels;
    const blockLevel = levels.find((l) => l.level === "block");
    const warnLevel = levels.find((l) => l.level === "warn");
    const passLevel = levels.find((l) => l.level === "pass");

    if (blockLevel && warnLevel && passLevel) {
      const blockVal = getThresholdNumericValue(blockLevel);
      const warnVal = getThresholdNumericValue(warnLevel);
      const passVal = getThresholdNumericValue(passLevel);

      if (!(blockVal < warnVal && warnVal < passVal)) {
        push(
          "error",
          threshold.loc.line,
          `Threshold "${threshold.metric}" values are not strictly increasing: block(${blockVal}) < warn(${warnVal}) < pass(${passVal})`,
          "Ensure block < warn < pass values"
        );
      }
    }
  }

  // ── 5. Check references exist in installed primes ─────────────────────
  const useRefs = getUseReferences(ast);
  for (const ref of useRefs) {
    // Normalize: PascalCase → kebab-case for lookup (TestCoverageStandard → test-coverage-standard)
    const kebabName = toKebabCase(ref.name);
    if (!installedPrimes.has(ref.name) && !installedPrimes.has(kebabName)) {
      push(
        "error",
        ref.line,
        `Referenced AOE "${ref.name}" not found in installed primes`,
        `Install "${kebabName}" or remove the reference`
      );
    }
  }

  const linkTargets = getLinkTargets(ast);
  for (const link of linkTargets) {
    const linkKebab = toKebabCase(link.to);
    const missing =
      !installedPrimes.has(link.to) &&
      !installedPrimes.has(linkKebab) &&
      !installedPrimes.has(link.to.toLowerCase());
    if (!missing) continue;

    // Whether a missing target is fatal is `semantics.selection` in the model,
    // not a verb spelling. `closure` means the target is a mandatory part of the
    // selection, so its absence is an error; `expand` means it would be pulled
    // in if present, so its absence is a warning; `informational` and `exclude`
    // relations do not need their target to exist at all.
    //
    // This replaces `link.type === "requires" || link.type === "REQUIRES"` and
    // the matching `enhances` branch. Case is normalised because v1 sources
    // wrote link verbs in both cases — that is a spelling question, and the
    // model's own `aliases` cover the rest.
    const verb = relations.definition(link.type) ? link.type : link.type.toLowerCase();
    const canonical = relations.canonical(verb);

    if (relations.required(verb)) {
      push(
        "error",
        link.line,
        `Required dependency "${link.to}" not found in installed primes`,
        `Install "${link.to}" or remove the ${canonical} link`
      );
    } else if (relations.expands(verb)) {
      push(
        "warn",
        link.line,
        `${canonical} target "${link.to}" not installed — optional but recommended`,
        `Install "${link.to}" so the ${canonical} relation can be expanded`
      );
    }
  }

  // ── 6. @sealed must not be inherited ──────────────────────────────────
  if (isPrimeAST(ast) && ast.extends) {
    const parent = installedPrimes.get(ast.extends);
    if (parent?.decorators?.includes("@sealed")) {
      push(
        "error",
        ast.loc.line,
        `Cannot extend "${ast.extends}": it is marked @sealed`,
        `Remove "extends ${ast.extends}" or use a reference instead`
      );
    }
  }

  // ── 7. @abstract must not be directly instantiated ────────────────────
  // Check if any use[] reference targets an @abstract AOE directly
  for (const ref of useRefs) {
    const target = installedPrimes.get(ref.name);
    if (target?.decorators?.includes("@abstract")) {
      push(
        "error",
        ref.line,
        `Cannot use "${ref.name}" directly: it is marked @abstract`,
        `Use a concrete subclass of "${ref.name}" instead`
      );
    }
  }

  // ── 8. Inheritance depth must not exceed 3 ────────────────────────────
  if (isPrimeAST(ast) && ast.extends) {
    const depth = getInheritanceDepth(ast, installedPrimes);
    if (depth > 3) {
      push(
        "error",
        ast.loc.line,
        `Inheritance depth ${depth} exceeds maximum of 3`,
        "Flatten the inheritance hierarchy or use composition (use/links) instead"
      );
    }
  }

  return diagnostics;
}
