/**
 * @module emitter
 * Markdown emitter — converts AST to optimized compiled output.
 *
 * Outputs:
 * - compiled/name.md            Optimized Markdown (AI Agent consumption)
 * - compiled/name.bundle.md     Bundle with inlined dependencies
 * - compiled/name.index.yaml    Index entry for Registry
 * - compiled/name.graph.yaml    Relationship graph for visualization
 *
 * Markdown optimization rules:
 * - Single-line header: `prime: name | type | version`
 * - Compact in/out: `in: x, y | out: a, b`
 * - Numbered steps with inline expect/error
 * - Compact warnings: `Warn: trigger -> correction`
 * - Remove comments
 * - Inline inherited content (expand parent into child)
 */

import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  ArrayNode,
  StringNode,
  NumberNode,
  StepNode,
  ArrowNode,
  ThresholdNode,
  ObjectNode,
  ParameterShorthandNode,
  ReferenceNode,
} from "@skill-wiki/types";
import type { DependencyGraph, InstalledPrime } from "./types";

type AnyAST = PrimeAST | AtomDeclaration;

function isPrimeAST(ast: AnyAST): ast is PrimeAST {
  return ast.type === "PrimeDeclaration";
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findField(ast: AnyAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

function getStringValue(ast: AnyAST, key: string): string {
  const field = findField(ast, key);
  if (!field) return "";
  if (field.value.type === "String") return (field.value as StringNode).value;
  if (field.value.type === "Ident") return field.value.value;
  return "";
}

function getArrayStrings(ast: AnyAST, key: string): string[] {
  const field = findField(ast, key);
  if (!field || field.value.type !== "Array") return [];
  return (field.value as ArrayNode).items
    .filter((item): item is StringNode => item.type === "String")
    .map((item) => item.value);
}

function getParameters(ast: AnyAST, key: string): string[] {
  const field = findField(ast, key);
  if (!field || field.value.type !== "Array") return [];
  const items = (field.value as ArrayNode).items;
  return items.map((item) => {
    if (item.type === "ParameterShorthand") {
      return (item as ParameterShorthandNode).name;
    }
    if (item.type === "String") {
      return (item as StringNode).value;
    }
    if (item.type === "Ident") {
      return item.value;
    }
    return "";
  }).filter(Boolean);
}

function getUseNames(ast: AnyAST): string[] {
  const field = findField(ast, "use");
  if (!field || field.value.type !== "Array") return [];
  return (field.value as ArrayNode).items.map((item) => {
    if (item.type === "Reference") {
      const ref = item as ReferenceNode;
      return ref.alias || ref.path[0];
    }
    if (item.type === "String") return (item as StringNode).value;
    return "";
  }).filter(Boolean);
}

function getRequire(ast: AnyAST): string[] {
  const field = findField(ast, "require");
  if (!field || field.value.type !== "Array") return [];
  return (field.value as ArrayNode).items.map((item) => {
    if (item.type === "String") return (item as StringNode).value;
    return "";
  }).filter(Boolean);
}

// ─── Markdown Emitter ──────────────────────────────────────────────────────

/**
 * Emit optimized Markdown from a Prime AST.
 *
 * @param ast - The parsed Prime AST
 * @returns Optimized Markdown string
 */
export function emitMarkdown(ast: AnyAST): string {
  const lines: string[] = [];

  const name = getStringValue(ast, "name") || ast.name;
  const version = getStringValue(ast, "version") || "0.0.0";
  const baseClass = ((isPrimeAST(ast) ? ast.extends : undefined) || "unknown").toLowerCase();
  const description = getStringValue(ast, "description");

  // ── Header line ───────────────────────────────────────────────────────
  lines.push(`prime: ${name} | ${baseClass} | ${version}`);

  // ── Input / Output ────────────────────────────────────────────────────
  const inputs = getParameters(ast, "input");
  const outputs = getParameters(ast, "output");
  if (inputs.length > 0 || outputs.length > 0) {
    const inStr = inputs.length > 0 ? `in: ${inputs.join(", ")}` : "";
    const outStr = outputs.length > 0 ? `out: ${outputs.join(", ")}` : "";
    if (inStr && outStr) {
      lines.push(`${inStr} | ${outStr}`);
    } else {
      lines.push(inStr || outStr);
    }
  }

  // ── Require ───────────────────────────────────────────────────────────
  const requires = getRequire(ast);
  if (requires.length > 0) {
    lines.push(`require: ${requires.join(", ")}`);
  }

  // ── Use ───────────────────────────────────────────────────────────────
  const uses = getUseNames(ast);
  if (uses.length > 0) {
    lines.push(`use: ${uses.join(", ")}`);
  }

  // ── Blank separator ───────────────────────────────────────────────────
  lines.push("");

  // ── Title ─────────────────────────────────────────────────────────────
  if (description) {
    lines.push(`# ${description}`);
  } else {
    // Generate a title from the PascalCase name
    const title = ast.name.replace(/([A-Z])/g, " $1").trim();
    lines.push(`# ${title}`);
  }

  lines.push("");

  // ── Steps (Method) ────────────────────────────────────────────────────
  const stepsField = findField(ast, "steps");
  if (stepsField && stepsField.value.type === "Array") {
    const steps = (stepsField.value as ArrayNode).items.filter(
      (item): item is StepNode => item.type === "Step"
    );
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let stepLine = `${i + 1}. **${step.name}**:`;

      // Extract description
      const desc = step.body.find(
        (e): e is StringNode => e.type === "String"
      );
      if (desc) {
        stepLine += ` ${desc.value}.`;
      }

      // Extract expect
      const expectField = step.body.find(
        (e): e is FieldNode => e.type === "Field" && (e as FieldNode).key === "expect"
      ) as FieldNode | undefined;
      if (expectField) {
        const expectVal =
          expectField.value.type === "Ident"
            ? expectField.value.value
            : expectField.value.type === "String"
              ? (expectField.value as StringNode).value
              : "";
        if (expectVal) {
          stepLine += ` Run -> must ${expectVal}.`;
        }
      }

      // Extract error handler
      const errorField = step.body.find(
        (e): e is FieldNode =>
          e.type === "Field" &&
          ((e as FieldNode).key === "error" || (e as FieldNode).key === "error_handler")
      ) as FieldNode | undefined;
      if (errorField) {
        if (errorField.value.type === "String") {
          stepLine += ` If fail -> error: ${(errorField.value as StringNode).value}.`;
        } else if (errorField.value.type === "Object") {
          const obj = errorField.value as ObjectNode;
          const retry = obj.fields.find((f) => f.key === "retry");
          const fallback = obj.fields.find((f) => f.key === "fallback");
          if (retry && retry.value.type === "Number") {
            stepLine += ` If fail ${(retry.value as NumberNode).value}x`;
            if (fallback && fallback.value.type === "String") {
              stepLine += ` -> escalate: ${(fallback.value as StringNode).value}`;
            }
            stepLine += ".";
          }
        }
      }

      lines.push(stepLine);
    }
    lines.push("");
  }

  // ── Loop ──────────────────────────────────────────────────────────────
  const loopField = findField(ast, "loop");
  if (loopField) {
    if (loopField.value.type === "Object") {
      const obj = loopField.value as ObjectNode;
      const untilField = obj.fields.find((f) => f.key === "until");
      const maxField = obj.fields.find((f) => f.key === "max");
      const until = untilField?.value.type === "String"
        ? (untilField.value as StringNode).value
        : "done";
      const max = maxField?.value.type === "Number"
        ? (maxField.value as NumberNode).value
        : undefined;
      lines.push(`Repeat until ${until}${max ? ` (max ${max})` : ""}.${uses.length > 0 ? ` Apply ${uses.join(", ")} post-check.` : ""}`);
      lines.push("");
    }
  }

  // ── Warnings ──────────────────────────────────────────────────────────
  const warningsField = findField(ast, "warnings");
  if (warningsField && warningsField.value.type === "Array") {
    const arrows = (warningsField.value as ArrayNode).items.filter(
      (item): item is ArrowNode => item.type === "Arrow"
    );
    if (arrows.length > 0) {
      const warnParts = arrows.map(
        (a) => `"${a.left.value}" -> ${a.right.value}`
      );
      lines.push(`**Warn**: ${warnParts.join(". ")}.`);
    }
  }

  // ── Branches ──────────────────────────────────────────────────────────
  const branchesField = findField(ast, "branches");
  if (branchesField && branchesField.value.type === "Array") {
    const arrows = (branchesField.value as ArrayNode).items.filter(
      (item): item is ArrowNode => item.type === "Arrow"
    );
    if (arrows.length > 0) {
      const branchParts = arrows.map(
        (a) => `${a.left.value} -> ${a.right.value}`
      );
      lines.push(`**If**: ${branchParts.join(". ")}.`);
    }
  }

  // ── Checks (Rule) ────────────────────────────────────────────────────
  const checksField = findField(ast, "checks");
  if (checksField && checksField.value.type === "Array") {
    lines.push("");
    for (const item of (checksField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const descField = obj.fields.find((f) => f.key === "description");
        const passField = obj.fields.find((f) => f.key === "pass_condition");
        const desc = descField?.value.type === "String"
          ? (descField.value as StringNode).value
          : "";
        const pass = passField?.value.type === "String"
          ? ` (${(passField.value as StringNode).value})`
          : "";
        lines.push(`- [ ] ${desc}${pass}`);
      } else if (item.type === "String") {
        lines.push(`- [ ] ${(item as StringNode).value}`);
      }
    }
  }

  // ── Thresholds (Rule) ─────────────────────────────────────────────────
  const thresholdsField = findField(ast, "thresholds");
  if (thresholdsField && thresholdsField.value.type === "Array") {
    const thresholds = (thresholdsField.value as ArrayNode).items.filter(
      (item): item is ThresholdNode => item.type === "Threshold"
    );
    if (thresholds.length > 0) {
      lines.push("");
      lines.push("| Metric | Block | Warn | Pass |");
      lines.push("|--------|-------|------|------|");
      for (const t of thresholds) {
        const block = t.levels.find((l) => l.level === "block");
        const warn = t.levels.find((l) => l.level === "warn");
        const pass = t.levels.find((l) => l.level === "pass");
        const unit = t.levels[0]?.unit || "";
        lines.push(
          `| ${t.metric} | ${block ? `${block.operator}${block.value}${unit}` : "-"} | ${warn ? `${warn.operator}${warn.value}${unit}` : "-"} | ${pass ? `${pass.operator}${pass.value}${unit}` : "-"} |`
        );
      }
    }
  }

  // ── Definitions (Knowledge) ───────────────────────────────────────────
  const defsField = findField(ast, "definitions");
  if (defsField && defsField.value.type === "Array") {
    lines.push("");
    for (const item of (defsField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const termField = obj.fields.find((f) => f.key === "term");
        const meaningField = obj.fields.find((f) => f.key === "meaning");
        const term = termField?.value.type === "String"
          ? (termField.value as StringNode).value
          : "";
        const meaning = meaningField?.value.type === "String"
          ? (meaningField.value as StringNode).value
          : "";
        if (term) {
          lines.push(`**${term}**: ${meaning}`);
        }
      }
    }
  }

  // ── Categories (Knowledge) ────────────────────────────────────────────
  const catsField = findField(ast, "categories");
  if (catsField && catsField.value.type === "Array") {
    lines.push("");
    for (const item of (catsField.value as ArrayNode).items) {
      if (item.type === "String") {
        lines.push(`- ${(item as StringNode).value}`);
      } else if (item.type === "Object") {
        const obj = item as ObjectNode;
        const nameF = obj.fields.find((f) => f.key === "name");
        const descF = obj.fields.find((f) => f.key === "description");
        const itemsF = obj.fields.find((f) => f.key === "items");
        const catName = nameF?.value.type === "String"
          ? (nameF.value as StringNode).value
          : "";
        const catDesc = descF?.value.type === "String"
          ? (descF.value as StringNode).value
          : "";
        if (catName) {
          lines.push(`### ${catName}${catDesc ? ` — ${catDesc}` : ""}`);
          // Emit sub-items (ParameterShorthand: Name "description")
          if (itemsF && itemsF.value.type === "Array") {
            for (const subItem of (itemsF.value as ArrayNode).items) {
              if (subItem.type === "ParameterShorthand") {
                const ps = subItem as ParameterShorthandNode;
                lines.push(`- **${ps.name}**: ${ps.description || ""}`);
              } else if (subItem.type === "String") {
                lines.push(`- ${(subItem as StringNode).value}`);
              } else if (subItem.type === "Object") {
                const subObj = subItem as ObjectNode;
                const subName = subObj.fields.find((f) => f.key === "name");
                const subDesc = subObj.fields.find((f) => f.key === "description");
                const sn = subName?.value.type === "String" ? (subName.value as StringNode).value : "";
                const sd = subDesc?.value.type === "String" ? (subDesc.value as StringNode).value : "";
                if (sn) lines.push(`- **${sn}**: ${sd}`);
              }
            }
          }
        }
      }
    }
  }

  // ── Facts (Knowledge) ────────────────────────────────────────────────
  const factsField = findField(ast, "facts");
  if (factsField && factsField.value.type === "Array") {
    lines.push("");
    for (const item of (factsField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const stmtF = obj.fields.find((f) => f.key === "statement");
        const confF = obj.fields.find((f) => f.key === "confidence");
        const stmt = stmtF?.value.type === "String" ? (stmtF.value as StringNode).value : "";
        const conf = confF?.value.type === "String" ? (confF.value as StringNode).value
          : confF?.value.type === "Ident" ? confF.value.value : "";
        if (stmt) lines.push(`> ${stmt}${conf ? ` [${conf}]` : ""}`);
      }
    }
  }

  // ── Relationships (Knowledge) ─────────────────────────────────────────
  const relsField = findField(ast, "relationships");
  if (relsField && relsField.value.type === "Array") {
    const rels: string[] = [];
    for (const item of (relsField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const fromF = obj.fields.find((f) => f.key === "from");
        const relF = obj.fields.find((f) => f.key === "relation");
        const toF = obj.fields.find((f) => f.key === "to");
        const from = fromF?.value.type === "String" ? (fromF.value as StringNode).value : "";
        const rel = relF?.value.type === "String" ? (relF.value as StringNode).value : "";
        const to = toF?.value.type === "String" ? (toF.value as StringNode).value : "";
        if (from && to) rels.push(`${from} ${rel} ${to}`);
      }
    }
    if (rels.length > 0) {
      lines.push("");
      lines.push(`**Relationships**: ${rels.join(". ")}.`);
    }
  }

  return lines.join("\n").trim() + "\n";
}

// ─── Bundle Emitter ────────────────────────────────────────────────────────

/**
 * Emit a bundle Markdown that inlines all dependency content.
 *
 * @param ast - The root Prime AST
 * @param graph - Resolved dependency graph
 * @param installedPrimes - Map of installed Primes with compiled content
 * @returns Bundle Markdown string
 */
export function emitBundle(
  ast: AnyAST,
  graph: DependencyGraph,
  installedPrimes: Map<string, InstalledPrime> = new Map()
): string {
  const lines: string[] = [];

  const name = getStringValue(ast, "name") || ast.name;
  const depCount = graph.nodes.length - 1; // exclude root

  lines.push(`<!-- bundle: ${name} | dependencies: ${depCount} -->`);
  lines.push("");

  // Emit dependencies first (in load order, excluding root)
  for (const depId of graph.loadOrder) {
    if (depId === name) continue; // skip root, emit last

    const node = graph.nodes.find((n) => n.id === depId);
    const installed = installedPrimes.get(depId);

    if (node) {
      lines.push(`## [dep] ${node.id} | ${node.type.toLowerCase()} | ${node.version}`);
      if (installed?.compiled) {
        // Inline the compiled content (skip the header line)
        const depLines = installed.compiled.split("\n");
        const contentStart = depLines.findIndex((l) => l.startsWith("#"));
        if (contentStart >= 0) {
          lines.push(depLines.slice(contentStart).join("\n"));
        } else {
          lines.push(installed.compiled);
        }
      }
      lines.push("");
    }
  }

  // Emit the main Prime
  const mainMd = emitMarkdown(ast);
  const mainLines = mainMd.split("\n");
  // Replace the first header-style line with a [main] marker
  if (mainLines.length > 0 && mainLines[0].startsWith("prime:")) {
    mainLines[0] = `## [main] ${mainLines[0].replace("prime: ", "")}`;
  }
  lines.push(mainLines.join("\n"));

  return lines.join("\n").trim() + "\n";
}

// ─── Index Emitter ─────────────────────────────────────────────────────────

/**
 * Emit a YAML index entry for the Registry.
 *
 * @param ast - The parsed Prime AST
 * @param graph - Resolved dependency graph
 * @param sourceTokenCount - Approximate token count of the source
 * @param compiledTokenCount - Approximate token count of compiled output
 * @param bundleTokenCount - Approximate token count of bundle output
 * @returns YAML string
 */
export function emitIndex(
  ast: AnyAST,
  graph: DependencyGraph,
  sourceTokenCount?: number,
  compiledTokenCount?: number,
  bundleTokenCount?: number
): string {
  const name = getStringValue(ast, "name") || ast.name;
  const version = getStringValue(ast, "version") || "0.0.0";
  const baseClass = ((isPrimeAST(ast) ? ast.extends : undefined) || "unknown").toLowerCase();
  const description = getStringValue(ast, "description") || "";
  const tags = getArrayStrings(ast, "tags");
  const inputs = getParameters(ast, "input");
  const outputs = getParameters(ast, "output");

  // Build signature
  const sig =
    inputs.length > 0 || outputs.length > 0
      ? `${name}(${inputs.join(", ")}) -> ${outputs.join(", ")}`
      : name;

  // Get dependency names
  const deps = graph.nodes
    .filter((n) => n.id !== name)
    .map((n) => n.id);

  // Get link details from edges
  const linkLines: string[] = [];
  for (const edge of graph.edges) {
    if (edge.from === name) {
      const verb = edge.type.toLowerCase();
      linkLines.push(`  ${verb}: [${edge.to}]`);
    }
  }

  const lines: string[] = [];
  lines.push(`name: ${name}`);
  lines.push(`type: ${baseClass}`);
  lines.push(`version: ${version}`);
  lines.push(`signature: "${sig}"`);
  if (description) lines.push(`description: "${description}"`);
  if (tags.length > 0) lines.push(`tags: [${tags.join(", ")}]`);
  if (deps.length > 0) lines.push(`dependencies: [${deps.join(", ")}]`);
  if (linkLines.length > 0) {
    lines.push("links:");
    lines.push(...linkLines);
  }
  if (sourceTokenCount !== undefined || compiledTokenCount !== undefined) {
    lines.push("token_count:");
    if (sourceTokenCount !== undefined) lines.push(`  source: ${sourceTokenCount}`);
    if (compiledTokenCount !== undefined) lines.push(`  compiled: ${compiledTokenCount}`);
    if (bundleTokenCount !== undefined) lines.push(`  bundle: ${bundleTokenCount}`);
  }

  return lines.join("\n") + "\n";
}

// ─── Graph Emitter ─────────────────────────────────────────────────────────

/**
 * Emit a YAML graph file for visualization.
 *
 * @param graph - The resolved dependency graph
 * @returns YAML string
 */
export function emitGraph(graph: DependencyGraph): string {
  const lines: string[] = [];

  lines.push("nodes:");
  for (const node of graph.nodes) {
    lines.push(`  - id: ${node.id}`);
    lines.push(`    type: ${node.type.toLowerCase()}`);
    lines.push(`    version: ${node.version}`);
  }

  lines.push("edges:");
  for (const edge of graph.edges) {
    lines.push(`  - from: ${edge.from}`);
    lines.push(`    to: ${edge.to}`);
    lines.push(`    type: ${edge.type}`);
    if (edge.direction) {
      lines.push(`    direction: ${edge.direction}`);
    }
    lines.push(`    required: ${edge.required}`);
  }

  return lines.join("\n") + "\n";
}

// ─── Token Count Estimation ────────────────────────────────────────────────

/**
 * Rough token count estimation (approx 4 chars per token for English/mixed text).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
