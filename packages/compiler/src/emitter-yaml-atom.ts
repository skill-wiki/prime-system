/**
 * @module emitter-yaml-atom
 * YAML-frontmatter atom emitter — produces .md files the existing MCP
 * server's data loader can read directly.
 *
 * Output shape (matches primes/atoms/**.md and what mcp-server/data.ts
 * expects):
 *
 *   ---
 *   id: "@prime/<name>" | "<original-id>"
 *   version: X.Y.Z
 *   type: rule | knowledge | concept | pattern | ...
 *   subtype: <subtype>      # if present on AST
 *   name: <human name>
 *   description: <...>
 *   tags: [...]
 *   claim: <first-fact-statement or first-check-description>
 *   severity: block | warn | pass    # if present
 *   priority: 1|2|3                   # if present
 *   activation: mindset|behavioral|reference
 *   domain: <domain>
 *   status: <status>
 *   # + every other scalar/array/object field preserved from the AST
 *   ---
 *
 *   ## Notes
 *   <description body>
 *
 * The design goal is round-trip compatibility: a .prime file produced by
 * scripts/yaml-to-prime.ts and then emitted via emitYamlAtom should be
 * functionally equivalent to the original YAML atom it was derived from.
 */

import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  ArrayNode,
  ObjectNode,
  StringNode,
  NumberNode,
  BooleanNode,
  IdentNode,
  ValueNode,
} from "@prime-lang/types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

// ─── AST field access ───────────────────────────────────────────────────────

function findField(ast: AnyAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

function fieldAsString(ast: AnyAST, key: string): string | undefined {
  const f = findField(ast, key);
  if (!f) return undefined;
  if (f.value.type === "String") return (f.value as StringNode).value;
  if (f.value.type === "Ident") return (f.value as IdentNode).value;
  return undefined;
}

function fieldAsNumber(ast: AnyAST, key: string): number | undefined {
  const f = findField(ast, key);
  if (!f || f.value.type !== "Number") return undefined;
  return (f.value as NumberNode).value;
}

function fieldAsStringArray(ast: AnyAST, key: string): string[] {
  const f = findField(ast, key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items
    .filter((item): item is StringNode => item.type === "String")
    .map((item) => item.value);
}

function objectStringField(obj: ObjectNode, key: string): string | undefined {
  const f = obj.fields.find((x) => x.key === key);
  if (!f || f.value.type !== "String") return undefined;
  return (f.value as StringNode).value;
}

// ─── YAML serialization ─────────────────────────────────────────────────────

function yamlString(s: string): string {
  // Single-line strings: double-quote and escape
  if (!s.includes("\n")) {
    if (/^[A-Za-z0-9_][A-Za-z0-9_ .,:;!?()&/'"\\-]*$/.test(s) && s.length < 80 && !s.startsWith("\"")) {
      // Bare works for most plain text, but YAML has a lot of gotchas
      // (starts-with-colon, starts-with-dash, ends-with-colon, starts-with-@)
      // so we always double-quote to be safe.
    }
    return JSON.stringify(s);
  }
  // Multi-line: use block scalar
  const indent = "  ";
  const lines = s.split("\n").map((l) => indent + l);
  return `|\n${lines.join("\n")}`;
}

function yamlValue(v: ValueNode, indent = ""): string {
  switch (v.type) {
    case "String":
      return yamlString((v as StringNode).value);
    case "Number":
      return String((v as NumberNode).value);
    case "Boolean":
      return String((v as BooleanNode).value);
    case "Ident":
      return yamlString((v as IdentNode).value);
    case "Array": {
      const items = (v as ArrayNode).items;
      if (items.length === 0) return "[]";
      // For nested rendering each item gets indented to `indent` (current level),
      // so its own children (in nested objects) go deeper.
      const itemIndent = indent;
      const rendered = items
        .map((it) => yamlValue(it, itemIndent + "  "))
        .filter((s) => s.length > 0);
      // Flow style for all-scalar, under-80-char total
      const allScalar = rendered.every((s) => !s.includes("\n") && s.length < 60);
      const flowLen = rendered.join(", ").length;
      if (allScalar && flowLen < 80) return `[${rendered.join(", ")}]`;
      return "\n" + rendered.map((s) => `${itemIndent}- ${s}`).join("\n");
    }
    case "Object": {
      const fields = (v as ObjectNode).fields;
      if (fields.length === 0) return "{}";
      // Children go one indent level deeper than their parent.
      const childIndent = indent + "  ";
      const lines: string[] = [];
      for (const f of fields) {
        const rendered = yamlValue(f.value, childIndent);
        if (!rendered) continue;
        if (rendered.startsWith("\n")) {
          lines.push(`${childIndent}${f.key}:${rendered}`);
        } else {
          lines.push(`${childIndent}${f.key}: ${rendered}`);
        }
      }
      return "\n" + lines.join("\n");
    }
    default:
      return "";
  }
}

// ─── Content extraction ─────────────────────────────────────────────────────

function extractClaim(ast: AnyAST): string | undefined {
  // Rule: first check.description
  // Knowledge: first fact.statement, or first definition.meaning
  const extendsVal = isPrimeAST(ast) ? ast.extends : undefined;
  if (extendsVal === "Rule") {
    const checks = findField(ast, "checks");
    if (checks && checks.value.type === "Array") {
      for (const item of (checks.value as ArrayNode).items) {
        if (item.type !== "Object") continue;
        const desc = objectStringField(item as ObjectNode, "description");
        if (desc) return desc;
      }
    }
  }
  if (extendsVal === "Knowledge") {
    const facts = findField(ast, "facts");
    if (facts && facts.value.type === "Array") {
      for (const item of (facts.value as ArrayNode).items) {
        if (item.type !== "Object") continue;
        const stmt = objectStringField(item as ObjectNode, "statement");
        if (stmt) return stmt;
      }
    }
    const defs = findField(ast, "definitions");
    if (defs && defs.value.type === "Array") {
      for (const item of (defs.value as ArrayNode).items) {
        if (item.type !== "Object") continue;
        const meaning = objectStringField(item as ObjectNode, "meaning");
        if (meaning) return meaning;
      }
    }
  }
  return undefined;
}

function derivePassCondition(ast: AnyAST): string | undefined {
  if (!isPrimeAST(ast) || ast.extends !== "Rule") return undefined;
  const checks = findField(ast, "checks");
  if (!checks || checks.value.type !== "Array") return undefined;
  for (const item of (checks.value as ArrayNode).items) {
    if (item.type !== "Object") continue;
    const pass = objectStringField(item as ObjectNode, "pass_condition");
    if (pass) return pass;
  }
  return undefined;
}

// ─── Emit ───────────────────────────────────────────────────────────────────

/**
 * Which .prime top-level fields correspond to the `type` YAML field. We let
 * the AST's `extends` win for canonical type, but also preserve any explicit
 * `type:` field the migration emitted.
 */
const MCP_CORE_FIELDS = new Set([
  "name",
  "version",
  "description",
  "tags",
  "subtype",
  "severity",
  "priority",
  "activation",
  "status",
  "domain",
  "module",
  "category",
  "claim",
  "verify_by",
  "applies_when",
  "rationale",
]);

/**
 * Fields that appear on .prime primes as part of the language's required
 * content (facts/definitions/checks) — not meaningful as YAML frontmatter.
 */
const CONTENT_FIELDS_SKIP = new Set([
  "facts",
  "definitions",
  "categories",
  "checks",
  "thresholds",
  "severity_table",
]);

/**
 * Fields the .prime language uses but that the YAML atom schema doesn't
 * have a direct equivalent for — we preserve them as-is in frontmatter
 * under the same key (consumers can ignore).
 */
const LINK_FIELDS = new Set([
  "specializes",
  "enhances",
  "requires",
  "validates_with",
  "supplies_to",
  "contradicts",
]);

function moduleFromName(name: string): string | undefined {
  const m = name.match(/^(m\d+)-/);
  return m ? m[1].toUpperCase() : undefined;
}

function idFromAst(ast: AnyAST, name: string): string {
  // If the AST has a `module` field (e.g. "M12"), prefer "@MXX/<name>".
  // Otherwise check for "mNN-" slug prefix. Otherwise default to "@prime/<name>".
  const module = fieldAsString(ast, "module");
  if (module && /^M\d+$/.test(module)) return `@${module}/${name.replace(/^m\d+-/, "")}`;
  const slugModule = moduleFromName(name);
  if (slugModule) return `@${slugModule}/${name.replace(/^m\d+-/, "")}`;
  return `@prime/${name}`;
}

function typeFromAst(ast: AnyAST): string {
  // Prefer an explicit `type` field if the migration preserved one,
  // otherwise derive from `extends`.
  const explicit = fieldAsString(ast, "type");
  if (explicit) return explicit;
  return ((isPrimeAST(ast) ? ast.extends : undefined) ?? "knowledge").toLowerCase();
}

/**
 * Emit a YAML-frontmatter + Markdown body string equivalent to the
 * original atom's format. This is the format the existing MCP server
 * (mcp-server/data.ts) reads.
 */
export function emitYamlAtom(ast: AnyAST): string {
  const name = fieldAsString(ast, "name") ?? ast.name;
  const version = fieldAsString(ast, "version") ?? "1.0.0";
  const description = fieldAsString(ast, "description") ?? "";
  const tags = fieldAsStringArray(ast, "tags");
  const id = idFromAst(ast, name);
  const type = typeFromAst(ast);
  const claim = fieldAsString(ast, "claim") ?? extractClaim(ast);
  const verify = fieldAsString(ast, "verify_by") ?? derivePassCondition(ast);

  // Top-level ordered keys that matter most for MCP
  const headerLines: string[] = [];
  headerLines.push(`id: ${yamlString(id)}`);
  headerLines.push(`version: ${version}`);
  headerLines.push(`type: ${yamlString(type)}`);

  // Subtype + name + description always before tags for readability.
  const subtype = fieldAsString(ast, "subtype");
  if (subtype) headerLines.push(`subtype: ${yamlString(subtype)}`);
  headerLines.push(`name: ${yamlString(name)}`);
  if (description) headerLines.push(`description: ${yamlString(description)}`);
  if (tags.length > 0)
    headerLines.push(`tags: [${tags.map((t) => yamlString(t)).join(", ")}]`);

  // Common scalar fields in a canonical order.
  const ORDERED = [
    "domain",
    "module",
    "category",
    "activation",
    "priority",
    "severity",
    "status",
    "applies_when",
    "rationale",
  ] as const;
  for (const key of ORDERED) {
    const f = findField(ast, key);
    if (!f) continue;
    const rendered = yamlValue(f.value);
    if (rendered) {
      if (rendered.startsWith("\n")) headerLines.push(`${key}:${rendered}`);
      else headerLines.push(`${key}: ${rendered}`);
    }
  }

  if (claim) headerLines.push(`claim: ${yamlString(claim)}`);
  if (verify) headerLines.push(`verify_by: ${yamlString(verify)}`);

  // Link fields
  for (const key of LINK_FIELDS) {
    const f = findField(ast, key);
    if (!f) continue;
    const rendered = yamlValue(f.value);
    if (rendered) {
      if (rendered.startsWith("\n")) headerLines.push(`${key}:${rendered}`);
      else headerLines.push(`${key}: ${rendered}`);
    }
  }

  // Everything else — emit every AST field that's not already covered, not
  // content-shaped, and not a Prime-language control field.
  const COVERED = new Set([
    ...MCP_CORE_FIELDS,
    ...LINK_FIELDS,
    ...CONTENT_FIELDS_SKIP,
    "type",
  ]);
  for (const f of ast.body) {
    if (COVERED.has(f.key)) continue;
    const rendered = yamlValue(f.value);
    if (!rendered) continue;
    if (rendered.startsWith("\n")) headerLines.push(`${f.key}:${rendered}`);
    else headerLines.push(`${f.key}: ${rendered}`);
  }

  const frontmatter = `---\n${headerLines.join("\n")}\n---\n`;
  const body = description ? `\n## Notes\n${description}\n` : "\n";
  return frontmatter + body;
}
