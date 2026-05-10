/**
 * @module chunked-emitter
 *
 * 分块编译器 — 把一个 Prime 编译成多个独立可加载的 chunk。
 *
 * 传统 emitter: 1 个 .prime → 1 个 .md (全量)
 * 分块 emitter: 1 个 .prime → 1 个 manifest.yaml + N 个 chunk .md
 *
 * AI 运行时根据需要动态加载 chunk，而不是一次加载整个编译产物。
 */

import type {
  PrimeAST,
  FieldNode,
  ArrayNode,
  StringNode,
  NumberNode,
  StepNode,
  ArrowNode,
  ObjectNode,
  ParameterShorthandNode,
} from "@skill-wiki/types";

// ─── Types ────────────────────────────────────────────────────────────────

export interface Chunk {
  id: string;           // chunk 标识符 (如 "categories.color", "steps.RED")
  type: string;         // chunk 类型 (category, step, checks, warnings, ...)
  label: string;        // 人可读标签
  content: string;      // chunk 的 Markdown 内容
  tokens: number;       // 估算 token 数
}

export interface ChunkedOutput {
  manifest: Manifest;
  chunks: Chunk[];
  fullMd: string;       // 仍然生成完整 .md (用于非分块场景)
}

export interface Manifest {
  name: string;
  type: string;
  version: string;
  description: string;
  signature: string;
  totalTokens: number;
  chunks: ManifestEntry[];
}

export interface ManifestEntry {
  id: string;
  type: string;
  label: string;
  tokens: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function findField(ast: PrimeAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

function getStringValue(ast: PrimeAST, key: string): string {
  const field = findField(ast, key);
  if (!field) return "";
  if (field.value.type === "String") return (field.value as StringNode).value;
  if (field.value.type === "Ident") return field.value.value;
  return "";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Chunked Emitter ──────────────────────────────────────────────────────

export function emitChunked(ast: PrimeAST): ChunkedOutput {
  const chunks: Chunk[] = [];
  const name = getStringValue(ast, "name") || ast.name;
  const version = getStringValue(ast, "version") || "0.0.0";
  const baseClass = (ast.extends || "unknown").toLowerCase();
  const description = getStringValue(ast, "description");

  // ── Header chunk (always loaded, ultra-light) ─────────────────────
  const inputs = getParamNames(ast, "input");
  const outputs = getParamNames(ast, "output");
  const sig = inputs.length > 0
    ? `${name}(${inputs.join(", ")}) -> ${outputs.join(", ")}`
    : name;

  const headerLines = [`prime: ${name} | ${baseClass} | ${version}`];
  if (inputs.length > 0) headerLines.push(`in: ${inputs.join(", ")} | out: ${outputs.join(", ")}`);

  const requireField = findField(ast, "require");
  if (requireField && requireField.value.type === "Array") {
    const reqs = (requireField.value as ArrayNode).items
      .filter((i): i is StringNode => i.type === "String")
      .map((i) => i.value);
    if (reqs.length > 0) headerLines.push(`require: ${reqs.join(", ")}`);
  }

  chunks.push({
    id: "header",
    type: "header",
    label: description || name,
    content: headerLines.join("\n"),
    tokens: estimateTokens(headerLines.join("\n")),
  });

  // ── Definitions chunk (Knowledge) ─────────────────────────────────
  const defsField = findField(ast, "definitions");
  if (defsField && defsField.value.type === "Array") {
    const lines: string[] = [];
    for (const item of (defsField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const term = obj.fields.find((f) => f.key === "term");
        const meaning = obj.fields.find((f) => f.key === "meaning");
        const t = term?.value.type === "String" ? (term.value as StringNode).value : "";
        const m = meaning?.value.type === "String" ? (meaning.value as StringNode).value : "";
        if (t) lines.push(`**${t}**: ${m}`);
      }
    }
    if (lines.length > 0) {
      chunks.push({
        id: "definitions",
        type: "definitions",
        label: `Definitions (${lines.length} terms)`,
        content: lines.join("\n"),
        tokens: estimateTokens(lines.join("\n")),
      });
    }
  }

  // ── Categories — each category is a separate chunk (Knowledge) ────
  const catsField = findField(ast, "categories");
  if (catsField && catsField.value.type === "Array") {
    for (const item of (catsField.value as ArrayNode).items) {
      if (item.type !== "Object") continue;
      const obj = item as ObjectNode;
      const nameF = obj.fields.find((f) => f.key === "name");
      const descF = obj.fields.find((f) => f.key === "description");
      const itemsF = obj.fields.find((f) => f.key === "items");

      const catName = nameF?.value.type === "String" ? (nameF.value as StringNode).value : "";
      const catDesc = descF?.value.type === "String" ? (descF.value as StringNode).value : "";
      if (!catName) continue;

      const lines: string[] = [`### ${catName}${catDesc ? ` — ${catDesc}` : ""}`];

      if (itemsF && itemsF.value.type === "Array") {
        for (const subItem of (itemsF.value as ArrayNode).items) {
          if (subItem.type === "ParameterShorthand") {
            const ps = subItem as ParameterShorthandNode;
            lines.push(`- **${ps.name}**: ${ps.description || ""}`);
          } else if (subItem.type === "String") {
            lines.push(`- ${(subItem as StringNode).value}`);
          }
        }
      }

      const catId = catName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      chunks.push({
        id: `category.${catId}`,
        type: "category",
        label: catName,
        content: lines.join("\n"),
        tokens: estimateTokens(lines.join("\n")),
      });
    }
  }

  // ── Steps — each step is a separate chunk (Method) ────────────────
  const stepsField = findField(ast, "steps");
  if (stepsField && stepsField.value.type === "Array") {
    const steps = (stepsField.value as ArrayNode).items.filter(
      (item): item is StepNode => item.type === "Step"
    );
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const lines: string[] = [];
      let stepLine = `${i + 1}. **${step.name}**:`;

      const desc = step.body.find((e): e is StringNode => e.type === "String");
      if (desc) stepLine += ` ${desc.value}.`;

      const expectField = step.body.find(
        (e): e is FieldNode => e.type === "Field" && (e as FieldNode).key === "expect"
      ) as FieldNode | undefined;
      if (expectField) {
        const val = expectField.value.type === "Ident" ? expectField.value.value : "";
        if (val) stepLine += ` Run -> must ${val}.`;
      }

      const errorField = step.body.find(
        (e): e is FieldNode =>
          e.type === "Field" && ((e as FieldNode).key === "error" || (e as FieldNode).key === "error_handler")
      ) as FieldNode | undefined;
      if (errorField) {
        if (errorField.value.type === "String") {
          stepLine += ` If fail -> ${(errorField.value as StringNode).value}.`;
        } else if (errorField.value.type === "Object") {
          const obj = errorField.value as ObjectNode;
          const retry = obj.fields.find((f) => f.key === "retry");
          const fallback = obj.fields.find((f) => f.key === "fallback");
          if (retry && retry.value.type === "Number") {
            stepLine += ` If fail ${(retry.value as NumberNode).value}x`;
            if (fallback && fallback.value.type === "String") {
              stepLine += ` -> ${(fallback.value as StringNode).value}`;
            }
            stepLine += ".";
          }
        }
      }

      lines.push(stepLine);

      chunks.push({
        id: `step.${step.name.toLowerCase()}`,
        type: "step",
        label: `Step ${i + 1}: ${step.name}`,
        content: lines.join("\n"),
        tokens: estimateTokens(lines.join("\n")),
      });
    }
  }

  // ── Checks chunk (Rule) ───────────────────────────────────────────
  const checksField = findField(ast, "checks");
  if (checksField && checksField.value.type === "Array") {
    const lines: string[] = [];
    for (const item of (checksField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const descField = obj.fields.find((f) => f.key === "description");
        const passField = obj.fields.find((f) => f.key === "pass") || obj.fields.find((f) => f.key === "pass_condition");
        const desc = descField?.value.type === "String" ? (descField.value as StringNode).value : "";
        const pass = passField?.value.type === "String" ? (passField.value as StringNode).value : "";
        lines.push(`- [ ] ${desc}${pass ? ` (${pass})` : ""}`);
      }
    }
    if (lines.length > 0) {
      chunks.push({
        id: "checks",
        type: "checks",
        label: `Checks (${lines.length} items)`,
        content: lines.join("\n"),
        tokens: estimateTokens(lines.join("\n")),
      });
    }
  }

  // ── Warnings chunk ────────────────────────────────────────────────
  const warningsField = findField(ast, "warnings");
  if (warningsField && warningsField.value.type === "Array") {
    const arrows = (warningsField.value as ArrayNode).items.filter(
      (item): item is ArrowNode => item.type === "Arrow"
    );
    if (arrows.length > 0) {
      const content = arrows.map((a) => `- "${a.left.value}" → ${a.right.value}`).join("\n");
      chunks.push({
        id: "warnings",
        type: "warnings",
        label: `Warnings (${arrows.length} anti-patterns)`,
        content,
        tokens: estimateTokens(content),
      });
    }
  }

  // ── Branches chunk ────────────────────────────────────────────────
  const branchesField = findField(ast, "branches");
  if (branchesField && branchesField.value.type === "Array") {
    const arrows = (branchesField.value as ArrayNode).items.filter(
      (item): item is ArrowNode => item.type === "Arrow"
    );
    if (arrows.length > 0) {
      const content = arrows.map((a) => `- If ${a.left.value} → ${a.right.value}`).join("\n");
      chunks.push({
        id: "branches",
        type: "branches",
        label: `Branches (${arrows.length} conditions)`,
        content,
        tokens: estimateTokens(content),
      });
    }
  }

  // ── Facts chunk (Knowledge) ───────────────────────────────────────
  const factsField = findField(ast, "facts");
  if (factsField && factsField.value.type === "Array") {
    const lines: string[] = [];
    for (const item of (factsField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const stmt = obj.fields.find((f) => f.key === "statement");
        const s = stmt?.value.type === "String" ? (stmt.value as StringNode).value : "";
        if (s) lines.push(`> ${s}`);
      }
    }
    if (lines.length > 0) {
      chunks.push({
        id: "facts",
        type: "facts",
        label: `Facts (${lines.length})`,
        content: lines.join("\n"),
        tokens: estimateTokens(lines.join("\n")),
      });
    }
  }

  // ── Relationships chunk (Knowledge) ───────────────────────────────
  const relsField = findField(ast, "relationships");
  if (relsField && relsField.value.type === "Array") {
    const lines: string[] = [];
    for (const item of (relsField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const from = obj.fields.find((f) => f.key === "from");
        const rel = obj.fields.find((f) => f.key === "relation");
        const to = obj.fields.find((f) => f.key === "to");
        const f = from?.value.type === "String" ? (from.value as StringNode).value : "";
        const r = rel?.value.type === "String" ? (rel.value as StringNode).value : "";
        const t = to?.value.type === "String" ? (to.value as StringNode).value : "";
        if (f && t) lines.push(`${f} ${r} ${t}`);
      }
    }
    if (lines.length > 0) {
      chunks.push({
        id: "relationships",
        type: "relationships",
        label: `Relationships (${lines.length})`,
        content: lines.join("\n"),
        tokens: estimateTokens(lines.join("\n")),
      });
    }
  }

  // ── Build manifest ────────────────────────────────────────────────
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
  const manifest: Manifest = {
    name,
    type: baseClass,
    version,
    description,
    signature: sig,
    totalTokens,
    chunks: chunks.map((c) => ({
      id: c.id,
      type: c.type,
      label: c.label,
      tokens: c.tokens,
    })),
  };

  // ── Build full .md (concatenation of all chunks) ──────────────────
  const fullMd = chunks.map((c) => c.content).join("\n\n");

  return { manifest, chunks, fullMd };
}

// ─── Helper ─────────────────────────────────────────────────────────────

function getParamNames(ast: PrimeAST, key: string): string[] {
  const field = findField(ast, key);
  if (!field || field.value.type !== "Array") return [];
  return (field.value as ArrayNode).items.map((item) => {
    if (item.type === "ParameterShorthand") return (item as ParameterShorthandNode).name;
    if (item.type === "String") return (item as StringNode).value;
    if (item.type === "Ident") return item.value;
    return "";
  }).filter(Boolean);
}
