/**
 * @module chunker
 *
 * Splits a parsed PrimeAST into the projection levels **the Model Package
 * declares** — for the v1 compatibility model that is summary/core/full.
 *
 * The chunker knows how to *render* a section (facts, checks, steps, …) but not
 * which sections a given kind gets, nor which kinds exist: that is read from
 * the model's ProjectionDefinitions (ADR-1). Adding a domain type is a YAML
 * edit, not a `switch (kind)` edit.
 *
 * Works with both the legacy `prime X extends Base {}` form and the kind form
 * (`fact X {}`). The `kind` is derived from the `extends` value or the atom
 * kind field and is an opaque string throughout.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  ArrayNode,
  StringNode,
  NumberNode,
  IdentNode,
  ObjectNode,
  StepNode,
  ArrowNode,
  ParameterShorthandNode,
  ThresholdNode,
  ValueNode,
} from "@skill-wiki/types";
import type { ProjectionDefinition } from "@skill-wiki/model-schema";
import { loadModelOrThrow } from "@skill-wiki/model-schema";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

// ─── Public types ──────────────────────────────────────────────────────────

export interface ChunkLevels {
  /** Level 1 — ~30 tok: description + tags + 1-line claim */
  summary: string;
  /** Level 2 — ~150 tok: + core body fields */
  core: string;
  /** Level 3 — ~380 tok: + sources + examples + relations + notes */
  full: string;
}

// ─── Model-driven projection rules ─────────────────────────────────────────

/** Ordered extraction strategies for the one-line claim, keyed by type. */
interface OneLinerRules {
  readonly byType: Readonly<Record<string, readonly string[]>>;
  readonly fallback: readonly string[];
}

/**
 * Everything the chunker needs to know that is NOT in its own code: which
 * types belong to which group, which sections each group gets per layer, and
 * how to extract the one-line claim. All of it comes from the model's
 * ProjectionDefinitions.
 */
export interface ChunkProjectionRules {
  /** typeRef (lowercased kind) → group name. */
  readonly groupOfType: Readonly<Record<string, string>>;
  /** Group used when a kind belongs to no declared group. */
  readonly defaultGroup: string;
  /** layer name → group name → ordered section selectors. */
  readonly sections: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly oneLiner: OneLinerRules;
}

const GROUP_PREFIX = "group:";

function readStringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function readOneLiner(definitions: readonly ProjectionDefinition[]): OneLinerRules {
  const byType: Record<string, readonly string[]> = {};
  let fallback: readonly string[] = [];
  for (const definition of definitions) {
    const spec = definition.extensions?.["oneLiner"];
    if (spec === null || typeof spec !== "object") continue;
    const record = spec as Record<string, unknown>;
    const declared = record["byType"];
    if (declared !== null && typeof declared === "object") {
      for (const [type, strategies] of Object.entries(declared as Record<string, unknown>)) {
        byType[type.toLowerCase()] = readStringList(strategies);
      }
    }
    const declaredFallback = readStringList(record["fallback"]);
    if (declaredFallback.length > 0) fallback = declaredFallback;
  }
  return { byType, fallback };
}

/** Fold a model's ProjectionDefinitions into the rules the chunker consumes. */
export function buildChunkProjectionRules(
  definitions: readonly ProjectionDefinition[],
): ChunkProjectionRules {
  const groupOfType: Record<string, string> = {};
  const sections: Record<string, Record<string, readonly string[]>> = {};
  let defaultGroup = "";

  for (const definition of definitions) {
    for (const [group, types] of Object.entries(definition.typeGroups)) {
      for (const type of types) groupOfType[type.toLowerCase()] = group;
    }
    const declaredDefault = definition.extensions?.["defaultGroup"];
    if (typeof declaredDefault === "string" && declaredDefault.length > 0) defaultGroup = declaredDefault;

    const perGroup: Record<string, readonly string[]> = sections[definition.name] ?? {};
    for (const rule of definition.rules) {
      if (!rule.typeRef?.startsWith(GROUP_PREFIX)) continue;
      perGroup[rule.typeRef.slice(GROUP_PREFIX.length)] = rule.include ?? [];
    }
    sections[definition.name] = perGroup;
  }

  return { groupOfType, defaultGroup, sections, oneLiner: readOneLiner(definitions) };
}

/**
 * The v1 compatibility model, loaded once.
 *
 * Reading it from disk rather than embedding it is the point: the 28 kinds are
 * data in `compat/prime-v1-model/`, not a constant in the engine.
 */
let cachedDefaultRules: ChunkProjectionRules | undefined;

function defaultProjectionRules(): ChunkProjectionRules {
  if (!cachedDefaultRules) {
    const here = dirname(fileURLToPath(import.meta.url));
    const model = loadModelOrThrow(resolve(here, "../../../compat/prime-v1-model"));
    const projections = model.definitions.filter(
      (definition): definition is ProjectionDefinition => definition.kind === "projection",
    );
    cachedDefaultRules = buildChunkProjectionRules(projections);
  }
  return cachedDefaultRules;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findField(ast: AnyAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

function str(ast: AnyAST, key: string): string {
  const f = findField(ast, key);
  if (!f) return "";
  if (f.value.type === "String") return (f.value as StringNode).value;
  if (f.value.type === "Ident") return (f.value as IdentNode).value;
  return "";
}

function strArr(ast: AnyAST, key: string): string[] {
  const f = findField(ast, key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items
    .filter((i): i is StringNode => i.type === "String")
    .map((i) => i.value);
}

function objStrField(obj: ObjectNode, key: string): string {
  const f = obj.fields.find((x) => x.key === key);
  if (!f) return "";
  if (f.value.type === "String") return (f.value as StringNode).value;
  if (f.value.type === "Ident") return (f.value as IdentNode).value;
  return "";
}

/** Derive the unit kind from the AST — kind form, explicit field, or legacy extends */
function deriveKind(ast: AnyAST): string {
  // Kind form: parser returns an AtomDeclaration with `kind` directly.
  if (!isPrimeAST(ast)) {
    return ast.kind.toLowerCase();
  }
  // Check for explicit `kind:` field next (object-literal form)
  const kindField = str(ast, "kind");
  if (kindField) return kindField.toLowerCase();
  // Fall back to extends (legacy form)
  return (ast.extends ?? "knowledge").toLowerCase();
}

/** Resolve a kind to its declared group, or the model's declared default. */
function groupOf(kind: string, rules: ChunkProjectionRules): string {
  return rules.groupOfType[kind] ?? rules.defaultGroup;
}

/** Ordered section selectors for one layer and one kind. */
function sectionsFor(layer: string, kind: string, rules: ChunkProjectionRules): readonly string[] {
  return rules.sections[layer]?.[groupOf(kind, rules)] ?? [];
}

/** Estimate token count (chars / 4) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Level 1 — Summary ────────────────────────────────────────────────────

function buildSummary(ast: AnyAST, kind: string, rules: ChunkProjectionRules): string {
  const name = str(ast, "name") || ast.name;
  const description = str(ast, "description");
  const tags = strArr(ast, "tags");
  const domain = str(ast, "domain");
  const version = str(ast, "version") || "1.0.0";

  const lines: string[] = [];

  // Header: name | kind | version
  lines.push(`# ${name} [${kind}] v${version}`);

  if (description) {
    lines.push(description);
  }

  // 1-line claim / statement
  const claim = extractOneLiner(ast, kind, rules);
  if (claim && claim !== description) {
    lines.push(`> ${claim}`);
  }

  // Tags
  if (tags.length > 0) {
    lines.push(`tags: ${tags.join(", ")}`);
  }
  if (domain) {
    lines.push(`domain: ${domain}`);
  }

  return lines.join("\n");
}

/**
 * Run one declared one-liner extraction strategy.
 *
 * The strategy vocabulary is domain-free — it names a *shape* in the body, never
 * a kind. Which strategies a kind uses is the model's business.
 */
function runOneLinerStrategy(ast: AnyAST, strategy: string): string {
  const separator = strategy.indexOf(":");
  if (separator < 0) return "";
  const verb = strategy.slice(0, separator);
  const argument = strategy.slice(separator + 1);

  if (verb === "field") {
    return str(ast, argument);
  }

  if (verb === "array-object-field") {
    const dot = argument.indexOf(".");
    if (dot < 0) return "";
    const field = findField(ast, argument.slice(0, dot));
    if (!field || field.value.type !== "Array") return "";
    const key = argument.slice(dot + 1);
    for (const item of (field.value as ArrayNode).items) {
      if (item.type !== "Object") continue;
      const found = objStrField(item as ObjectNode, key);
      if (found) return found;
    }
    return "";
  }

  if (verb === "step-array") {
    const field = findField(ast, argument);
    if (!field || field.value.type !== "Array") return "";
    for (const item of (field.value as ArrayNode).items) {
      if (item.type !== "Step") continue;
      const step = item as StepNode;
      const desc = step.body.find((e): e is StringNode => e.type === "String");
      if (desc) return `Step 1: ${step.name} — ${desc.value}`;
    }
    return "";
  }

  return "";
}

function extractOneLiner(ast: AnyAST, kind: string, rules: ChunkProjectionRules): string {
  const strategies = [...(rules.oneLiner.byType[kind] ?? []), ...rules.oneLiner.fallback];
  for (const strategy of strategies) {
    const found = runOneLinerStrategy(ast, strategy);
    if (found) return found;
  }
  return "";
}

// ─── Level 2 — Core ───────────────────────────────────────────────────────

/**
 * Emit one named section.
 *
 * This is the whole kind-dispatch surface of the chunker: a section name in
 * from the model, markdown out. There is no `switch (kind)` — the switch is on
 * the *section*, which is engine vocabulary, and the kind→sections mapping is
 * the model's.
 */
function appendSection(
  section: string,
  ast: AnyAST,
  lines: string[],
  layer: "core" | "full",
  rules: ChunkProjectionRules,
): void {
  switch (section) {
    case "facts":
      return appendFacts(ast, lines);
    case "definitions":
      return appendDefinitions(ast, lines);
    case "categories":
      return appendCategories(ast, lines, false);
    case "checks":
      return appendChecks(ast, lines);
    case "steps":
      return appendSteps(ast, lines, false);
    case "signature": {
      const sig = buildSignature(ast);
      if (sig) lines.push(`\nsignature: ${sig}`);
      return;
    }
    case "predicate": {
      const predicate = str(ast, "predicate");
      if (predicate) lines.push(`predicate: ${predicate}`);
      return;
    }
    case "effect": {
      const effect = str(ast, "effect");
      if (effect) lines.push(`effect: ${effect}`);
      return;
    }
    case "includes":
      return appendIncludes(ast, lines);
    case "severity_combination": {
      const sevCombo = str(ast, "severity_combination");
      if (sevCombo) lines.push(`\nseverity: ${sevCombo}`);
      return;
    }
    case "constraint-values":
      return appendConstraintValues(ast, lines);
    case "sources":
      return appendSources(ast, lines);
    case "examples":
      return appendExamples(ast, lines);
    case "relations":
      return appendRelations(ast, lines);
    case "notes": {
      const notes = str(ast, "notes");
      if (notes) {
        lines.push("\n## Notes");
        lines.push(notes);
      }
      return;
    }
    case "rationale": {
      const rationale = str(ast, "rationale");
      if (rationale) {
        lines.push("\n## Rationale");
        lines.push(rationale);
      }
      return;
    }
    case "provenance":
      return appendProvenance(ast, lines);
    case "full-categories": {
      const catsField = findField(ast, "categories");
      if (!catsField || catsField.value.type !== "Array") return;
      // `core` already emitted a truncated list; add the complete one here.
      const fullCats = buildCategoriesFull(ast);
      if (fullCats.length > 0) {
        lines.push("\n## Categories (full)");
        lines.push(...fullCats);
      }
      return;
    }
    case "unprocessed-fields":
      return layer === "core"
        ? appendCoreUnprocessedFields(ast, lines)
        : appendUnprocessedFields(ast, lines, rules);
    default:
      // An unknown section name means the model asked for a projection this
      // engine build cannot render. Silence is correct: the model may target a
      // newer engine, and a hard failure here would make models un-forward-
      // compatible. Renderer coverage is a model-conformance concern (§17.1).
      return;
  }
}

function buildCore(ast: AnyAST, kind: string, summary: string, rules: ChunkProjectionRules): string {
  const lines: string[] = [summary];
  for (const section of sectionsFor("core", kind, rules)) {
    appendSection(section, ast, lines, "core", rules);
  }
  return lines.join("\n");
}

/**
 * Field keys that belong in `full` but NOT in `core`. These are meta /
 * provenance / cross-reference fields — useful for forensics but not for
 * day-to-day "what does this atom prescribe?" reading.
 */
const CORE_EXCLUDED_KEYS = new Set<string>([
  "sources", "source",
  "examples", "applies_to",
  "related", "compatible", "conflicts", "see-also", "see_also",
  "extends", "derived-from", "derived_from",
  "requires", "enhances", "validates_with", "validates-with",
  "supplies_to", "supplies-to", "specializes",
  "contradicts", "relationships",
  "notes", "rationale", "provenance",
  "lifecycle",
  "attributed_to",
]);

function appendCoreUnprocessedFields(ast: AnyAST, lines: string[]): void {
  const unprocessed = ast.body.filter(
    (f) => !PROCESSED_KEYS.has(f.key) && !CORE_EXCLUDED_KEYS.has(f.key),
  );
  if (unprocessed.length === 0) return;
  for (const f of unprocessed) {
    lines.push(`\n## ${humanize(f.key)}`);
    appendGenericValue(f.value, lines, 0);
  }
}

// ─── Level 3 — Full ───────────────────────────────────────────────────────

function buildFull(ast: AnyAST, kind: string, core: string, rules: ChunkProjectionRules): string {
  const lines: string[] = [core];
  for (const section of sectionsFor("full", kind, rules)) {
    appendSection(section, ast, lines, "full", rules);
  }
  return lines.join("\n");
}

// ─── Catch-all: emit fields the structured pipeline didn't already cover ────

/** Field keys already emitted by the summary/core/full pipeline. */
const PROCESSED_KEYS = new Set<string>([
  // Meta
  "id", "version", "name", "kind", "tags",
  // Already in summary
  "description", "domain", "claim", "statement",
  // Already in core (data atoms)
  "facts", "definitions", "categories",
  // Already in core (behaviour atoms)
  "checks", "steps", "signature", "predicate", "effect", "parameters",
  // Already in core (composition atoms)
  "includes", "severity_combination",
  // Already in full
  "sources", "examples", "related", "notes", "rationale", "provenance",
]);

function humanize(key: string): string {
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * In `full`, emit ALL unprocessed fields — including the meta keys that
 * `core` skipped (sources/examples/notes/etc.).
 *
 * Whether a type's `core` already emitted its non-meta body fields depends on
 * whether that type's core section list ends in `unprocessed-fields`; for the
 * v1 model that is true of every group, so the discriminator is which group
 * the type is in. Types in the model's default group (and types in no group at
 * all) went through the lenient branch, so only the meta keys are new here.
 */
function appendUnprocessedFields(ast: AnyAST, lines: string[], rules: ChunkProjectionRules): void {
  const usedLenientBranch = groupOf(deriveKind(ast), rules) === rules.defaultGroup;
  const unprocessed = ast.body.filter((f) => {
    if (PROCESSED_KEYS.has(f.key)) return false;
    if (usedLenientBranch) {
      // Already emitted in core. Only emit the meta keys (CORE_EXCLUDED_KEYS)
      // here, which weren't in core.
      return CORE_EXCLUDED_KEYS.has(f.key);
    }
    return true;
  });
  if (unprocessed.length === 0) return;
  for (const f of unprocessed) {
    lines.push(`\n## ${humanize(f.key)}`);
    appendGenericValue(f.value, lines, 0);
  }
}

function appendGenericValue(v: ValueNode, lines: string[], indent: number): void {
  const prefix = "  ".repeat(indent);
  switch (v.type) {
    case "String": {
      const text = (v as StringNode).value;
      // Multi-line strings (block scalars, triple-quoted): preserve as-is in a
      // fenced block so embedded code/templates render verbatim.
      if (text.includes("\n")) {
        lines.push(prefix + "```");
        for (const ln of text.split("\n")) lines.push(prefix + ln);
        lines.push(prefix + "```");
      } else {
        lines.push(prefix + text);
      }
      return;
    }
    case "Number":
      lines.push(prefix + String((v as NumberNode).value));
      return;
    case "Ident":
      lines.push(prefix + (v as IdentNode).value);
      return;
    case "Boolean":
      lines.push(prefix + String((v as any).value));
      return;
    case "EnumValue":
      lines.push(prefix + (v as any).value);
      return;
    case "Array": {
      const arr = (v as ArrayNode).items;
      for (const item of arr) {
        if (item.type === "String") {
          const t = (item as StringNode).value;
          if (t.includes("\n")) {
            lines.push(prefix + "- ```");
            for (const ln of t.split("\n")) lines.push(prefix + "  " + ln);
            lines.push(prefix + "  ```");
          } else {
            lines.push(`${prefix}- ${t}`);
          }
        } else if (item.type === "Number" || item.type === "Boolean" || item.type === "Ident") {
          lines.push(`${prefix}- ${(item as any).value}`);
        } else if (item.type === "EnumValue") {
          lines.push(`${prefix}- ${(item as any).value}`);
        } else if (item.type === "Object") {
          lines.push(`${prefix}-`);
          appendGenericObject(item as ObjectNode, lines, indent + 1);
        } else {
          appendGenericValue(item, lines, indent);
        }
      }
      return;
    }
    case "Object":
      appendGenericObject(v as ObjectNode, lines, indent);
      return;
    default:
      // ParameterShorthand, Arrow, Step, Threshold, LinkShorthand, Reference
      lines.push(prefix + JSON.stringify(v));
  }
}

function appendGenericObject(o: ObjectNode, lines: string[], indent: number): void {
  const prefix = "  ".repeat(indent);
  for (const f of o.fields) {
    const v = f.value;
    const isScalar =
      v.type === "String" || v.type === "Number" ||
      v.type === "Boolean" || v.type === "Ident" ||
      v.type === "EnumValue";
    if (isScalar) {
      const text = (v as any).value;
      if (typeof text === "string" && text.includes("\n")) {
        lines.push(`${prefix}- **${humanize(f.key)}**:`);
        appendGenericValue(v, lines, indent + 1);
      } else {
        lines.push(`${prefix}- **${humanize(f.key)}**: ${text}`);
      }
    } else {
      lines.push(`${prefix}- **${humanize(f.key)}**:`);
      appendGenericValue(v, lines, indent + 1);
    }
  }
}

// ─── Append helpers ────────────────────────────────────────────────────────

function appendFacts(ast: AnyAST, lines: string[]): void {
  const field = findField(ast, "facts");
  if (!field || field.value.type !== "Array") return;
  const items = (field.value as ArrayNode).items;
  if (items.length === 0) return;
  lines.push("\n## Facts");
  for (const item of items) {
    if (item.type === "Object") {
      const obj = item as ObjectNode;
      const stmt = objStrField(obj, "statement");
      const conf = objStrField(obj, "confidence");
      if (stmt) lines.push(`> ${stmt}${conf ? ` [${conf}]` : ""}`);
    }
  }
}

function appendDefinitions(ast: AnyAST, lines: string[]): void {
  const field = findField(ast, "definitions");
  if (!field || field.value.type !== "Array") return;
  const items = (field.value as ArrayNode).items;
  if (items.length === 0) return;
  lines.push("\n## Definitions");
  for (const item of items) {
    if (item.type === "Object") {
      const obj = item as ObjectNode;
      const term = objStrField(obj, "term");
      const meaning = objStrField(obj, "meaning");
      if (term) lines.push(`**${term}**: ${meaning}`);
    }
  }
}

function appendCategories(ast: AnyAST, lines: string[], full: boolean): void {
  const field = findField(ast, "categories");
  if (!field || field.value.type !== "Array") return;
  const items = (field.value as ArrayNode).items;
  if (items.length === 0) return;
  lines.push("\n## Categories");
  const limit = full ? items.length : Math.min(items.length, 3);
  for (let i = 0; i < limit; i++) {
    const item = items[i];
    if (item.type === "String") {
      lines.push(`- ${(item as StringNode).value}`);
    } else if (item.type === "Object") {
      const obj = item as ObjectNode;
      const catName = objStrField(obj, "name");
      const catDesc = objStrField(obj, "description");
      if (catName) lines.push(`### ${catName}${catDesc ? ` — ${catDesc}` : ""}`);
    }
  }
  if (!full && items.length > 3) lines.push(`_...${items.length - 3} more_`);
}

function buildCategoriesFull(ast: AnyAST): string[] {
  const field = findField(ast, "categories");
  if (!field || field.value.type !== "Array") return [];
  const items = (field.value as ArrayNode).items;
  const lines: string[] = [];
  for (const item of items) {
    if (item.type === "Object") {
      const obj = item as ObjectNode;
      const catName = objStrField(obj, "name");
      const catDesc = objStrField(obj, "description");
      const itemsF = obj.fields.find((f) => f.key === "items");
      if (catName) lines.push(`### ${catName}${catDesc ? ` — ${catDesc}` : ""}`);
      if (itemsF && itemsF.value.type === "Array") {
        for (const sub of (itemsF.value as ArrayNode).items) {
          if (sub.type === "ParameterShorthand") {
            const ps = sub as ParameterShorthandNode;
            lines.push(`- **${ps.name}**: ${ps.description || ""}`);
          } else if (sub.type === "String") {
            lines.push(`- ${(sub as StringNode).value}`);
          }
        }
      }
    }
  }
  return lines;
}

function appendChecks(ast: AnyAST, lines: string[]): void {
  const field = findField(ast, "checks");
  if (!field || field.value.type !== "Array") return;
  const items = (field.value as ArrayNode).items;
  if (items.length === 0) return;
  lines.push("\n## Checks");
  for (const item of items) {
    if (item.type === "Object") {
      const obj = item as ObjectNode;
      const desc = objStrField(obj, "description");
      const pass = objStrField(obj, "pass_condition") || objStrField(obj, "pass");
      const sev = objStrField(obj, "severity");
      lines.push(`- [ ] ${desc}${pass ? ` → ${pass}` : ""}${sev ? ` [${sev}]` : ""}`);
    } else if (item.type === "String") {
      lines.push(`- [ ] ${(item as StringNode).value}`);
    }
  }
  // Thresholds
  const thresholds = findField(ast, "thresholds");
  if (thresholds && thresholds.value.type === "Array") {
    const ts = (thresholds.value as ArrayNode).items.filter(
      (i): i is ThresholdNode => i.type === "Threshold"
    );
    if (ts.length > 0) {
      lines.push("\n| Metric | Block | Warn | Pass |");
      lines.push("|--------|-------|------|------|");
      for (const t of ts) {
        const block = t.levels.find((l) => l.level === "block");
        const warn = t.levels.find((l) => l.level === "warn");
        const pass = t.levels.find((l) => l.level === "pass");
        lines.push(
          `| ${t.metric} | ${block ? `${block.operator}${block.value}` : "-"} | ${warn ? `${warn.operator}${warn.value}` : "-"} | ${pass ? `${pass.operator}${pass.value}` : "-"} |`
        );
      }
    }
  }
}

function appendSteps(ast: AnyAST, lines: string[], withDetail: boolean): void {
  const field = findField(ast, "steps");
  if (!field || field.value.type !== "Array") return;
  const steps = (field.value as ArrayNode).items.filter(
    (i): i is StepNode => i.type === "Step"
  );
  if (steps.length === 0) return;
  lines.push("\n## Steps");
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const desc = step.body.find((e): e is StringNode => e.type === "String");
    lines.push(`${i + 1}. **${step.name}**${desc ? `: ${desc.value}` : ""}`);
  }
  // Warnings and branches
  const warningsField = findField(ast, "warnings");
  if (warningsField && warningsField.value.type === "Array") {
    const arrows = (warningsField.value as ArrayNode).items.filter(
      (i): i is ArrowNode => i.type === "Arrow"
    );
    if (arrows.length > 0) {
      lines.push(`\n**Warn**: ${arrows.map((a) => `"${a.left.value}" → ${a.right.value}`).join("; ")}`);
    }
  }
}

function appendIncludes(ast: AnyAST, lines: string[]): void {
  const field = findField(ast, "includes");
  if (!field || field.value.type !== "Array") return;
  const items = (field.value as ArrayNode).items;
  if (items.length === 0) return;
  lines.push("\n## Includes");
  for (const item of items) {
    if (item.type === "String") lines.push(`- ${(item as StringNode).value}`);
    else if (item.type === "Ident") lines.push(`- ${(item as IdentNode).value}`);
    else if (item.type === "Reference") {
      const ref = item as any;
      lines.push(`- ${ref.path ? ref.path.join("/") : JSON.stringify(ref)}`);
    }
  }
  const orch = str(ast, "orchestration");
  if (orch) lines.push(`orchestration: ${orch}`);
}

function appendConstraintValues(ast: AnyAST, lines: string[]): void {
  const field = findField(ast, "values");
  if (!field || field.value.type !== "Array") return;
  const items = (field.value as ArrayNode).items
    .filter((i): i is StringNode => i.type === "String")
    .map((i) => i.value);
  if (items.length === 0) return;
  lines.push(`\nvalues: ${items.join(", ")}`);
}

function appendSources(ast: AnyAST, lines: string[]): void {
  // Check for `source` (singular object) or `sources` (array)
  const srcSingular = findField(ast, "source");
  const srcPlural = findField(ast, "sources");

  if (srcSingular || srcPlural) {
    lines.push("\n## Sources");
  }

  if (srcSingular && srcSingular.value.type === "Object") {
    const obj = srcSingular.value as ObjectNode;
    const url = objStrField(obj, "url") || objStrField(obj, "file") || objStrField(obj, "repo");
    const type = objStrField(obj, "type");
    if (url) lines.push(`- ${url}${type ? ` [${type}]` : ""}`);
  }

  if (srcPlural && srcPlural.value.type === "Array") {
    for (const item of (srcPlural.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const url = objStrField(obj, "url") || objStrField(obj, "file");
        const type = objStrField(obj, "type");
        if (url) lines.push(`- ${url}${type ? ` [${type}]` : ""}`);
      }
    }
  }

  // attributed_to
  const attr = str(ast, "attributed_to");
  if (attr) lines.push(`attributed_to: ${attr}`);
}

function appendExamples(ast: AnyAST, lines: string[]): void {
  const field = findField(ast, "examples");
  if (!field || field.value.type !== "Array") return;
  const items = (field.value as ArrayNode).items;
  if (items.length === 0) return;
  lines.push("\n## Examples");
  for (const item of items) {
    if (item.type === "String") {
      lines.push(`- ${(item as StringNode).value}`);
    } else if (item.type === "Object") {
      const obj = item as ObjectNode;
      const title = objStrField(obj, "title") || objStrField(obj, "name");
      const desc = objStrField(obj, "description") || objStrField(obj, "body");
      if (title) lines.push(`- **${title}**${desc ? `: ${desc}` : ""}`);
    }
  }
  // Also: applies_to
  const appliesTo = findField(ast, "applies_to");
  if (appliesTo && appliesTo.value.type === "Array") {
    const atItems = (appliesTo.value as ArrayNode).items
      .filter((i): i is StringNode => i.type === "String")
      .map((i) => i.value);
    if (atItems.length > 0) lines.push(`applies_to: ${atItems.join(", ")}`);
  }
}

function appendRelations(ast: AnyAST, lines: string[]): void {
  const RELATION_KEYS = [
    "specializes", "enhances", "requires", "validates_with",
    "supplies_to", "contradicts", "relationships",
  ];
  const found: string[] = [];
  for (const key of RELATION_KEYS) {
    const f = findField(ast, key);
    if (!f) continue;
    if (f.value.type === "String") {
      found.push(`${key}: ${(f.value as StringNode).value}`);
    } else if (f.value.type === "Ident") {
      found.push(`${key}: ${(f.value as IdentNode).value}`);
    } else if (f.value.type === "Array") {
      const items = (f.value as ArrayNode).items
        .map((i) => {
          if (i.type === "String") return (i as StringNode).value;
          if (i.type === "Ident") return (i as IdentNode).value;
          return "";
        })
        .filter(Boolean);
      if (items.length > 0) found.push(`${key}: [${items.join(", ")}]`);
    }
  }
  if (found.length > 0) {
    lines.push("\n## Relations");
    lines.push(...found);
  }
}

function appendProvenance(ast: AnyAST, lines: string[]): void {
  const field = findField(ast, "provenance");
  if (!field || field.value.type !== "Object") return;
  const obj = field.value as ObjectNode;
  const extractedBy = objStrField(obj, "extracted_by");
  const extractedAt = objStrField(obj, "extracted_at");
  if (extractedBy || extractedAt) {
    lines.push(`\nprovenance: by ${extractedBy || "?"}${extractedAt ? ` at ${extractedAt}` : ""}`);
  }
}

function buildSignature(ast: AnyAST): string {
  const name = str(ast, "name") || ast.name;
  // Check for `signature` field first
  const sigField = str(ast, "signature");
  if (sigField) return sigField;
  // Build from input/output
  const inputField = findField(ast, "input");
  const outputField = findField(ast, "output");
  if (!inputField && !outputField) return "";

  const inp = inputField && inputField.value.type === "Array"
    ? (inputField.value as ArrayNode).items.map((i) => {
        if (i.type === "ParameterShorthand") return `${(i as ParameterShorthandNode).name}: ${(i as ParameterShorthandNode).paramType}`;
        if (i.type === "String") return (i as StringNode).value;
        if (i.type === "Ident") return (i as IdentNode).value;
        return "";
      }).filter(Boolean).join(", ")
    : "";

  const out = outputField && outputField.value.type === "Array"
    ? (outputField.value as ArrayNode).items.map((i) => {
        if (i.type === "ParameterShorthand") return `${(i as ParameterShorthandNode).name}: ${(i as ParameterShorthandNode).paramType}`;
        if (i.type === "String") return (i as StringNode).value;
        if (i.type === "Ident") return (i as IdentNode).value;
        return "";
      }).filter(Boolean).join(", ")
    : "";

  return `(${inp}) -> ${out}`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Split a parsed AST into the projection levels the model declares.
 *
 * @param ast - The parsed PrimeAST or AtomDeclaration
 * @param rules - Projection rules folded from a model's ProjectionDefinitions.
 *                Defaults to the v1 compatibility model in `compat/`, so legacy
 *                callers keep working while the kind knowledge stays in data.
 * @returns { summary, core, full } — each a Markdown string
 */
export function chunk(ast: AnyAST, rules: ChunkProjectionRules = defaultProjectionRules()): ChunkLevels {
  const kind = deriveKind(ast);
  const summary = buildSummary(ast, kind, rules);
  const core = buildCore(ast, kind, summary, rules);
  const full = buildFull(ast, kind, core, rules);
  return { summary, core, full };
}
