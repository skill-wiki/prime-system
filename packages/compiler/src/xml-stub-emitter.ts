/**
 * @module xml-stub-emitter
 *
 * Emits the per-atom `index.xml` — a pre-rendered XML stub (~50 tok) that
 * gives agents fast one-line metadata about a single atom.
 *
 * Format (PRIME.md §6.3 / §8.2):
 *
 *   <atom id="@community/fact-wcag-focus-contrast"
 *         kind="fact"
 *         version="1.0.0"
 *         domain="frontend-design"
 *         tokens="142"
 *         q="4.7">
 *     <description>Focus ring contrast must be ≥ 3:1 against adjacent colors</description>
 *     <tags>a11y, wcag, focus</tags>
 *     <projection>
 *       <level name="summary" file="chunks/summary.md" tokens="28"/>
 *       <level name="core"    file="chunks/core.md"    tokens="142"/>
 *       <level name="full"    file="chunks/full.md"    tokens="384"/>
 *     </projection>
 *   </atom>
 */

import type { PrimeAST, AtomDeclaration, FieldNode, ArrayNode, StringNode, IdentNode, ObjectNode } from "@prime-lang/types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
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

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function deriveKind(ast: AnyAST): string {
  if (!isPrimeAST(ast)) return ast.kind.toLowerCase();
  const kindField = str(ast, "kind");
  if (kindField) return kindField.toLowerCase();
  return (ast.extends ?? "knowledge").toLowerCase();
}

function deriveId(ast: AnyAST, name: string): string {
  // Prefer explicit id field
  const idField = str(ast, "id");
  if (idField) return idField;

  // Use module field for scoped id
  const moduleField = str(ast, "module");
  if (moduleField && /^M\d+$/.test(moduleField)) {
    return `@${moduleField}/${name.replace(/^m\d+-/, "")}`;
  }

  // Detect mNN- prefix in name
  const m = name.match(/^(m\d+)-/);
  if (m) return `@${m[1].toUpperCase()}/${name.replace(/^m\d+-/, "")}`;

  return `@prime/${name}`;
}

function deriveQuality(ast: AnyAST): string {
  const qualityField = findField(ast, "quality");
  if (qualityField && qualityField.value.type === "Object") {
    const obj = qualityField.value as ObjectNode;
    // Average numeric quality scores
    const scores: number[] = [];
    for (const f of obj.fields) {
      if (f.value.type === "Number") {
        scores.push((f.value as any).value as number);
      }
    }
    if (scores.length > 0) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      return avg.toFixed(1);
    }
  }
  // Default quality based on status
  const status = str(ast, "status");
  if (status === "validated") return "4.5";
  if (status === "draft") return "3.0";
  return "4.0";
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface AtomTokenCounts {
  summary: number;
  core: number;
  full: number;
}

/**
 * Emit the per-atom `index.xml` stub.
 *
 * @param ast - The parsed PrimeAST
 * @param tokens - Token counts for each chunk level
 * @returns XML string
 */
export function emitXmlStub(ast: AnyAST, tokens: AtomTokenCounts): string {
  const name = str(ast, "name") || ast.name;
  const id = deriveId(ast, name);
  const kind = deriveKind(ast);
  const version = str(ast, "version") || "1.0.0";
  const description = str(ast, "description");
  const tags = strArr(ast, "tags");
  const domain = str(ast, "domain");
  const quality = deriveQuality(ast);

  const lines: string[] = [];
  lines.push(`<atom`);
  lines.push(`  id="${xmlEscape(id)}"`);
  lines.push(`  kind="${xmlEscape(kind)}"`);
  lines.push(`  version="${xmlEscape(version)}"`);
  if (domain) lines.push(`  domain="${xmlEscape(domain)}"`);
  lines.push(`  tokens="${tokens.core}"`);
  lines.push(`  q="${quality}">`);
  if (description) {
    lines.push(`  <description>${xmlEscape(description)}</description>`);
  }
  if (tags.length > 0) {
    lines.push(`  <tags>${xmlEscape(tags.join(", "))}</tags>`);
  }
  lines.push(`  <projection>`);
  lines.push(`    <level name="summary" file="chunks/summary.md" tokens="${tokens.summary}"/>`);
  lines.push(`    <level name="core"    file="chunks/core.md"    tokens="${tokens.core}"/>`);
  lines.push(`    <level name="full"    file="chunks/full.md"    tokens="${tokens.full}"/>`);
  lines.push(`  </projection>`);
  lines.push(`</atom>`);

  return lines.join("\n") + "\n";
}
