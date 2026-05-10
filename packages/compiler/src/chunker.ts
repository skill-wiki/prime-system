/**
 * @module chunker
 *
 * Splits a parsed PrimeAST into 3 projection levels:
 *
 *   Level 1 — summary  (~30 tok):  description + tags + 1-line claim/statement
 *   Level 2 — core     (~150 tok): + body fields (facts/checks/steps/etc.)
 *   Level 3 — full     (~380 tok): + sources + examples + relations + notes
 *
 * Works with both the legacy `prime X extends Base {}` form and the new
 * typed keyword form (fact/method/rule/…). The `kind` is derived from
 * the `extends` value or from the atom kind field.
 */

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
} from "@prime-lang/types";
import type { AtomKind } from "@prime-lang/types";

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

/** Derive atom kind from AST — supports new kind field or legacy extends */
function deriveKind(ast: AnyAST): AtomKind | string {
  // New 28-type form: parser returns an AtomDeclaration with `kind` directly.
  if (!isPrimeAST(ast)) {
    return ast.kind.toLowerCase();
  }
  // Check for explicit `kind:` field next (object-literal form)
  const kindField = str(ast, "kind");
  if (kindField) return kindField.toLowerCase();
  // Fall back to extends (legacy form)
  return (ast.extends ?? "knowledge").toLowerCase();
}

/** Estimate token count (chars / 4) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Level 1 — Summary ────────────────────────────────────────────────────

function buildSummary(ast: AnyAST, kind: string): string {
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
  const claim = extractOneLiner(ast, kind);
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

function extractOneLiner(ast: AnyAST, kind: string): string {
  // fact / term: statement or meaning
  if (kind === "fact") {
    const facts = findField(ast, "facts");
    if (facts && facts.value.type === "Array") {
      for (const item of (facts.value as ArrayNode).items) {
        if (item.type === "Object") {
          const s = objStrField(item as ObjectNode, "statement");
          if (s) return s;
        }
      }
    }
    const stmt = str(ast, "statement");
    if (stmt) return stmt;
  }
  if (kind === "term") {
    const meaning = str(ast, "meaning");
    if (meaning) return meaning;
  }
  // rule / check: first check description
  if (kind === "rule" || kind === "check") {
    const checks = findField(ast, "checks");
    if (checks && checks.value.type === "Array") {
      for (const item of (checks.value as ArrayNode).items) {
        if (item.type === "Object") {
          const d = objStrField(item as ObjectNode, "description");
          if (d) return d;
        }
      }
    }
  }
  // method: first step
  if (kind === "method") {
    const steps = findField(ast, "steps");
    if (steps && steps.value.type === "Array") {
      for (const item of (steps.value as ArrayNode).items) {
        if (item.type === "Step") {
          const step = item as StepNode;
          const desc = step.body.find((e): e is StringNode => e.type === "String");
          if (desc) return `Step 1: ${step.name} — ${desc.value}`;
        }
      }
    }
  }
  // collection: description
  if (kind === "collection") {
    const desc = str(ast, "description");
    if (desc) return desc;
  }
  // principle/tradeoff: statement
  const stmtField = str(ast, "statement");
  if (stmtField) return stmtField;
  // fallback: first fact in facts array for knowledge-type atoms
  const facts = findField(ast, "facts");
  if (facts && facts.value.type === "Array") {
    for (const item of (facts.value as ArrayNode).items) {
      if (item.type === "Object") {
        const s = objStrField(item as ObjectNode, "statement");
        if (s) return s;
      }
    }
  }
  return "";
}

// ─── Level 2 — Core ───────────────────────────────────────────────────────

function buildCore(ast: AnyAST, kind: string, summary: string): string {
  const lines: string[] = [summary];

  // Core body depends on atom kind
  const isDataAtom = ["fact", "term", "value", "category", "example", "counter-example", "source", "metric"].includes(kind);
  const isBehaviourAtom = ["step", "check", "transform", "tool"].includes(kind);
  const isCompositionAtom = ["method", "rule", "taxonomy", "pattern", "anti-pattern", "type"].includes(kind);

  if (isDataAtom) {
    // Data atoms: emit full content (they tend to be small)
    appendFacts(ast, lines);
    appendDefinitions(ast, lines);
    appendCategories(ast, lines, false);
    appendChecks(ast, lines);
    appendSteps(ast, lines, false);
  } else if (isBehaviourAtom) {
    appendChecks(ast, lines);
    appendSteps(ast, lines, false);
    // signature
    const sig = buildSignature(ast);
    if (sig) lines.push(`\nsignature: ${sig}`);
    const predicate = str(ast, "predicate");
    if (predicate) lines.push(`predicate: ${predicate}`);
    const effect = str(ast, "effect");
    if (effect) lines.push(`effect: ${effect}`);
  } else if (isCompositionAtom) {
    appendChecks(ast, lines);
    appendSteps(ast, lines, false);
    appendFacts(ast, lines);
    appendCategories(ast, lines, false);
    // collection: includes
    appendIncludes(ast, lines);
    // rule: severity combination
    const sevCombo = str(ast, "severity_combination");
    if (sevCombo) lines.push(`\nseverity: ${sevCombo}`);
  } else {
    // Style / Parameter / Meta / Binding atoms (persona, voice, template,
    // constraint, principle, tradeoff, provocation, scope, taxonomy, …).
    appendFacts(ast, lines);
    appendChecks(ast, lines);
    appendIncludes(ast, lines);
    appendSteps(ast, lines, false);
    appendConstraintValues(ast, lines);
  }

  // Universal catch-all: emit body fields that the structured appenders above
  // didn't already cover, EXCEPT meta-level fields (sources/examples/relations/
  // notes/rationale/provenance) which belong only in `full`.
  //
  // Without this, ~60% of the corpus on 2026-05-07 had core ≡ summary —
  // pattern/persona/template atoms keep their semantic value in kind-specific
  // body fields (implies, palette, prohibitions, body, font.*, …) that the
  // structured appenders don't touch.
  appendCoreUnprocessedFields(ast, lines);

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

function buildFull(ast: AnyAST, kind: string, core: string): string {
  const lines: string[] = [core];

  // Sources
  appendSources(ast, lines);
  // Examples
  appendExamples(ast, lines);
  // Relations (link fields)
  appendRelations(ast, lines);
  // Notes / rationale
  const notes = str(ast, "notes");
  if (notes) {
    lines.push("\n## Notes");
    lines.push(notes);
  }
  const rationale = str(ast, "rationale");
  if (rationale) {
    lines.push("\n## Rationale");
    lines.push(rationale);
  }
  // Provenance
  appendProvenance(ast, lines);
  // Full categories (with all subitems)
  const catsField = findField(ast, "categories");
  if (catsField && catsField.value.type === "Array") {
    // If core already has truncated categories, add full version here
    const fullCats = buildCategoriesFull(ast);
    if (fullCats.length > 0) {
      lines.push("\n## Categories (full)");
      lines.push(...fullCats);
    }
  }

  // Catch-all: emit every top-level field not already projected. Persona/
  // voice/template/constraint atoms keep most of their semantic value in
  // kind-specific fields (implies, palette, prohibitions, values, body…)
  // that the structured projections above don't touch — without this the
  // agent gets a 3-line stub instead of the actual design language.
  appendUnprocessedFields(ast, lines);

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
 * `core` skipped (sources/examples/relations/notes/etc.). Style-atom body
 * fields (implies/palette/prohibitions/...) were already emitted by
 * `appendCoreUnprocessedFields` if the atom went through the style branch
 * of `buildCore`; this function uses a "seen" set passed by `buildFull` to
 * avoid double-emission.
 */
function appendUnprocessedFields(ast: AnyAST, lines: string[]): void {
  // Track which fields are already in `core` so we don't duplicate them.
  // For atoms whose `core` ran through the style branch, body fields that
  // aren't in PROCESSED_KEYS or CORE_EXCLUDED_KEYS were already emitted —
  // we emit only the meta keys here. For atoms that went through the data
  // /behaviour/composition branches, all unprocessed fields end up here.
  const isStyleish = !["fact", "term", "value", "category", "example", "counter-example", "source", "metric",
                       "step", "check", "transform", "tool",
                       "method", "rule", "taxonomy", "pattern", "anti-pattern", "type"].includes(deriveKind(ast));
  const unprocessed = ast.body.filter((f) => {
    if (PROCESSED_KEYS.has(f.key)) return false;
    if (isStyleish) {
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
 * Split a parsed AST into 3 projection levels.
 *
 * @param ast - The parsed PrimeAST
 * @returns { summary, core, full } — each a Markdown string
 */
export function chunk(ast: AnyAST): ChunkLevels {
  const kind = deriveKind(ast);
  const summary = buildSummary(ast, kind);
  const core = buildCore(ast, kind, summary);
  const full = buildFull(ast, kind, core);
  return { summary, core, full };
}
