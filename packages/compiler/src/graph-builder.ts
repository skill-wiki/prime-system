/**
 * @module graph-builder
 *
 * 从 Prime AST 构建执行图 (Execution Graph)。
 * 执行图是 Prime 和 RAG 的根本区别：知识不是被检索的，是被执行的。
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

export interface ExecutionGraph {
  prime: string;
  type: string;
  version: string;
  input: string[];
  output: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  branches: GraphBranch[];
  warnings: GraphWarning[];
  totalTokens: number;
}

export interface GraphNode {
  id: string;
  type: "require" | "step" | "substep" | "validate" | "evaluate" | "check";
  label: string;
  chunk: string;          // chunk 内容 (Markdown)
  tokens: number;
  expect?: "pass" | "fail";
  error?: GraphErrorHandler;
  children?: GraphNode[];  // sub-steps
  criteria?: GraphCriterion[];  // for evaluate nodes
  checkItems?: GraphCheckItem[]; // for check/validate nodes
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "sequence" | "require" | "validate" | "branch";
  condition?: string;    // for branch edges
}

export interface GraphBranch {
  condition: string;
  action: string;
  affectsNode?: string;
  interrupt?: boolean;
}

export interface GraphWarning {
  trigger: string;
  response: string;
}

export interface GraphErrorHandler {
  message: string;
  retry?: number;
  fallback?: string;
}

export interface GraphCriterion {
  id: string;
  description: string;
  decidable: boolean;
}

export interface GraphCheckItem {
  description: string;
  passCondition: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function findField(ast: PrimeAST, key: string): FieldNode | undefined {
  return ast.body.find((f) => f.key === key);
}

function getStr(ast: PrimeAST, key: string): string {
  const f = findField(ast, key);
  if (!f) return "";
  if (f.value.type === "String") return (f.value as StringNode).value;
  if (f.value.type === "Ident") return f.value.value;
  return "";
}

function getParamNames(ast: PrimeAST, key: string): string[] {
  const f = findField(ast, key);
  if (!f || f.value.type !== "Array") return [];
  return (f.value as ArrayNode).items.map((i) => {
    if (i.type === "ParameterShorthand") return (i as ParameterShorthandNode).name;
    if (i.type === "String") return (i as StringNode).value;
    if (i.type === "Ident") return i.value;
    return "";
  }).filter(Boolean);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function emitStepChunk(step: StepNode): string {
  const lines: string[] = [];
  const desc = step.body.find((e): e is StringNode => e.type === "String");
  lines.push(`**${step.name}**: ${desc?.value || ""}`);

  const expectF = step.body.find(
    (e): e is FieldNode => e.type === "Field" && (e as FieldNode).key === "expect"
  ) as FieldNode | undefined;
  if (expectF) {
    const val = expectF.value.type === "Ident" ? expectF.value.value : "";
    if (val) lines.push(`Expected: ${val}`);
  }

  const errorF = step.body.find(
    (e): e is FieldNode => e.type === "Field" && ((e as FieldNode).key === "error" || (e as FieldNode).key === "error_handler")
  ) as FieldNode | undefined;
  if (errorF && errorF.value.type === "String") {
    lines.push(`On error: ${(errorF.value as StringNode).value}`);
  }

  return lines.join("\n");
}

function extractError(step: StepNode): GraphErrorHandler | undefined {
  const errorF = step.body.find(
    (e): e is FieldNode => e.type === "Field" && ((e as FieldNode).key === "error" || (e as FieldNode).key === "error_handler")
  ) as FieldNode | undefined;

  if (!errorF) return undefined;

  if (errorF.value.type === "String") {
    return { message: (errorF.value as StringNode).value };
  }

  if (errorF.value.type === "Object") {
    const obj = errorF.value as ObjectNode;
    const msg = obj.fields.find(f => f.key === "message");
    const retry = obj.fields.find(f => f.key === "retry");
    const fallback = obj.fields.find(f => f.key === "fallback");
    return {
      message: msg?.value.type === "String" ? (msg.value as StringNode).value : "Error",
      retry: retry?.value.type === "Number" ? (retry.value as NumberNode).value : undefined,
      fallback: fallback?.value.type === "String" ? (fallback.value as StringNode).value : undefined,
    };
  }

  return undefined;
}

function extractExpect(step: StepNode): "pass" | "fail" | undefined {
  const f = step.body.find(
    (e): e is FieldNode => e.type === "Field" && (e as FieldNode).key === "expect"
  ) as FieldNode | undefined;
  if (!f) return undefined;
  const val = f.value.type === "Ident" ? f.value.value : "";
  if (val === "pass" || val === "fail") return val;
  return undefined;
}

// ─── Graph Builder ────────────────────────────────────────────────────────

export function buildExecutionGraph(ast: PrimeAST): ExecutionGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const branches: GraphBranch[] = [];
  const warnings: GraphWarning[] = [];

  const name = getStr(ast, "name") || ast.name;
  const type = (ast.extends || "unknown").toLowerCase();
  const version = getStr(ast, "version") || "0.0.0";
  const input = getParamNames(ast, "input");
  const output = getParamNames(ast, "output");

  let prevNodeId: string | null = null;

  // ── Require nodes ──────────────────────────────────────────────────
  const linksField = findField(ast, "links");
  if (linksField && linksField.value.type === "Array") {
    for (const item of (linksField.value as ArrayNode).items) {
      if (item.type !== "Object") continue;
      const obj = item as ObjectNode;
      // Look for requires links
      const typeF = obj.fields.find(f => f.key === "type");
      const toF = obj.fields.find(f => f.key === "to");
      if (typeF && toF) {
        const lt = typeF.value.type === "Ident" ? typeF.value.value : "";
        const target = toF.value.type === "String" ? (toF.value as StringNode).value : "";
        if (lt.toLowerCase() === "requires" && target) {
          const nodeId = `require.${target}`;
          nodes.push({
            id: nodeId,
            type: "require",
            label: `Load ${target}`,
            chunk: `[require] Load knowledge from ${target}`,
            tokens: 15,
          });
          if (prevNodeId) edges.push({ from: prevNodeId, to: nodeId, type: "sequence" });
          prevNodeId = nodeId;
        }
      }
    }
  }

  // Also check link shorthand in AST (requires "xxx" syntax)
  for (const field of ast.body) {
    if (field.key === "links" && field.value.type === "Array") {
      for (const item of (field.value as ArrayNode).items) {
        if (item.type === "Object") {
          const obj = item as ObjectNode;
          const verb = obj.fields.find(f => f.key === "verb");
          const target = obj.fields.find(f => f.key === "target");
          if (verb && target) {
            const v = verb.value.type === "String" ? (verb.value as StringNode).value : "";
            const t = target.value.type === "String" ? (target.value as StringNode).value : "";
            if (v === "requires" && t && !nodes.some(n => n.id === `require.${t}`)) {
              const nodeId = `require.${t}`;
              nodes.push({
                id: nodeId,
                type: "require",
                label: `Load ${t}`,
                chunk: `[require] Load knowledge from ${t}`,
                tokens: 15,
              });
              if (prevNodeId) edges.push({ from: prevNodeId, to: nodeId, type: "sequence" });
              prevNodeId = nodeId;
            }
          }
        }
      }
    }
  }

  // ── Step nodes (Method) ────────────────────────────────────────────
  const stepsField = findField(ast, "steps");
  if (stepsField && stepsField.value.type === "Array") {
    const steps = (stepsField.value as ArrayNode).items.filter(
      (item): item is StepNode => item.type === "Step"
    );

    for (const step of steps) {
      const nodeId = `step.${step.name.toLowerCase()}`;
      const chunk = emitStepChunk(step);
      const children: GraphNode[] = [];

      // Check for sub_steps
      const subStepsField = step.body.find(
        (e): e is FieldNode => e.type === "Field" && (e as FieldNode).key === "sub_steps"
      ) as FieldNode | undefined;

      if (subStepsField && subStepsField.value.type === "Array") {
        const subSteps = (subStepsField.value as ArrayNode).items.filter(
          (item): item is StepNode => item.type === "Step"
        );
        for (const sub of subSteps) {
          const subChunk = emitStepChunk(sub);
          children.push({
            id: `${nodeId}.${sub.name.toLowerCase()}`,
            type: "substep",
            label: sub.name,
            chunk: subChunk,
            tokens: estimateTokens(subChunk),
            expect: extractExpect(sub),
            error: extractError(sub),
          });
        }
      }

      const node: GraphNode = {
        id: nodeId,
        type: "step",
        label: step.name,
        chunk,
        tokens: estimateTokens(chunk),
        expect: extractExpect(step),
        error: extractError(step),
        children: children.length > 0 ? children : undefined,
      };
      nodes.push(node);

      if (prevNodeId) edges.push({ from: prevNodeId, to: nodeId, type: "sequence" });
      prevNodeId = nodeId;
    }
  }

  // ── Validate node (from validates_with link) ───────────────────────
  // Scan links for validates_with
  for (const field of ast.body) {
    if (field.key === "links" && field.value.type === "Array") {
      for (const item of (field.value as ArrayNode).items) {
        if (item.type === "Object") {
          const obj = item as ObjectNode;
          const verb = obj.fields.find(f => f.key === "verb");
          const target = obj.fields.find(f => f.key === "target");
          if (verb && target) {
            const v = verb.value.type === "String" ? (verb.value as StringNode).value : "";
            const t = target.value.type === "String" ? (target.value as StringNode).value : "";
            if (v === "validates_with" && t) {
              const nodeId = `validate.${t}`;
              nodes.push({
                id: nodeId,
                type: "validate",
                label: `Validate with ${t}`,
                chunk: `[validate] Apply checks from ${t}`,
                tokens: 20,
              });
              if (prevNodeId) edges.push({ from: prevNodeId, to: nodeId, type: "validate" });
              prevNodeId = nodeId;
            }
          }
        }
      }
    }
  }

  // ── Evaluate node (from success_criteria) ──────────────────────────
  const scField = findField(ast, "success_criteria");
  if (scField && scField.value.type === "Object") {
    const obj = scField.value as ObjectNode;
    const criteriaField = obj.fields.find(f => f.key === "criteria");
    const criteria: GraphCriterion[] = [];

    if (criteriaField && criteriaField.value.type === "Array") {
      for (const item of (criteriaField.value as ArrayNode).items) {
        if (item.type === "Object") {
          const cObj = item as ObjectNode;
          const id = cObj.fields.find(f => f.key === "id");
          const desc = cObj.fields.find(f => f.key === "description");
          const decidability = cObj.fields.find(f => f.key === "decidability");
          criteria.push({
            id: id?.value.type === "String" ? (id.value as StringNode).value : "unknown",
            description: desc?.value.type === "String" ? (desc.value as StringNode).value : "",
            decidable: decidability?.value.type === "EnumValue"
              ? (decidability.value as any).value === "decidable"
              : true,
          });
        }
      }
    }

    const criteriaChunk = criteria.map(c =>
      `- [${c.decidable ? "decidable" : "subjective"}] ${c.description}`
    ).join("\n");

    const nodeId = "evaluate";
    nodes.push({
      id: nodeId,
      type: "evaluate",
      label: "Evaluate success criteria",
      chunk: criteriaChunk || "[evaluate] Check success criteria",
      tokens: estimateTokens(criteriaChunk || "evaluate"),
      criteria,
    });
    if (prevNodeId) edges.push({ from: prevNodeId, to: nodeId, type: "sequence" });
  }

  // ── Check nodes (Rule) ─────────────────────────────────────────────
  const checksField = findField(ast, "checks");
  if (checksField && checksField.value.type === "Array") {
    const checkItems: GraphCheckItem[] = [];
    for (const item of (checksField.value as ArrayNode).items) {
      if (item.type === "Object") {
        const obj = item as ObjectNode;
        const desc = obj.fields.find(f => f.key === "description");
        const pass = obj.fields.find(f => f.key === "pass") || obj.fields.find(f => f.key === "pass_condition");
        checkItems.push({
          description: desc?.value.type === "String" ? (desc.value as StringNode).value : "",
          passCondition: pass?.value.type === "String" ? (pass.value as StringNode).value : "",
        });
      }
    }

    if (checkItems.length > 0) {
      const checkChunk = checkItems.map(c => `- [ ] ${c.description} (${c.passCondition})`).join("\n");
      nodes.push({
        id: "checks",
        type: "check",
        label: `${checkItems.length} checks`,
        chunk: checkChunk,
        tokens: estimateTokens(checkChunk),
        checkItems,
      });
    }
  }

  // ── Branches ───────────────────────────────────────────────────────
  const branchesField = findField(ast, "branches");
  if (branchesField && branchesField.value.type === "Array") {
    for (const item of (branchesField.value as ArrayNode).items) {
      if (item.type === "Arrow") {
        const arrow = item as ArrowNode;
        branches.push({
          condition: arrow.left.value,
          action: arrow.right.value,
        });
      }
    }
  }

  // ── Warnings ───────────────────────────────────────────────────────
  const warningsField = findField(ast, "warnings");
  if (warningsField && warningsField.value.type === "Array") {
    for (const item of (warningsField.value as ArrayNode).items) {
      if (item.type === "Arrow") {
        const arrow = item as ArrowNode;
        warnings.push({
          trigger: arrow.left.value,
          response: arrow.right.value,
        });
      }
    }
  }

  const totalTokens = nodes.reduce((sum, n) => {
    let t = n.tokens;
    if (n.children) t += n.children.reduce((s, c) => s + c.tokens, 0);
    return sum + t;
  }, 0);

  return {
    prime: name,
    type,
    version,
    input,
    output,
    nodes,
    edges,
    branches,
    warnings,
    totalTokens,
  };
}

// ─── Graph Walker (Runtime) ──────────────────────────────────────────────

export interface WalkState {
  currentNode: string;
  completedNodes: string[];
  loadedChunks: string[];
  totalTokensLoaded: number;
  peakTokens: number;
  currentContextTokens: number;
  results: Map<string, string>;
  errors: string[];
}

export interface WalkStep {
  nodeId: string;
  nodeType: string;
  label: string;
  chunkLoaded: string;
  tokensLoaded: number;
  tokensInContext: number;
  action: string;
}

/**
 * Simulate walking the execution graph, tracking token consumption at each step.
 */
export function simulateGraphWalk(graph: ExecutionGraph): {
  steps: WalkStep[];
  totalTokensLoaded: number;
  peakTokens: number;
  nodesVisited: number;
} {
  const steps: WalkStep[] = [];
  let totalLoaded = 0;
  let peakTokens = 0;
  let contextTokens = 0;
  const manifestTokens = 30; // manifest always in context
  contextTokens += manifestTokens;

  // Walk nodes in edge order
  const visited = new Set<string>();
  const queue: string[] = [];

  // Find start node (first node with no incoming edge)
  const hasIncoming = new Set(graph.edges.map(e => e.to));
  for (const node of graph.nodes) {
    if (!hasIncoming.has(node.id)) {
      queue.push(node.id);
      break;
    }
  }
  if (queue.length === 0 && graph.nodes.length > 0) {
    queue.push(graph.nodes[0].id);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) continue;

    // Load chunk
    contextTokens += node.tokens;
    totalLoaded += node.tokens;

    const step: WalkStep = {
      nodeId: node.id,
      nodeType: node.type,
      label: node.label,
      chunkLoaded: node.chunk.slice(0, 60) + (node.chunk.length > 60 ? "..." : ""),
      tokensLoaded: node.tokens,
      tokensInContext: contextTokens,
      action: `Execute ${node.type}: ${node.label}`,
    };

    // Handle children (sub-steps)
    if (node.children) {
      for (const child of node.children) {
        contextTokens += child.tokens;
        totalLoaded += child.tokens;
        if (contextTokens > peakTokens) peakTokens = contextTokens;

        steps.push({
          nodeId: child.id,
          nodeType: child.type,
          label: child.label,
          chunkLoaded: child.chunk.slice(0, 60) + "...",
          tokensLoaded: child.tokens,
          tokensInContext: contextTokens,
          action: `Execute substep: ${child.label}`,
        });

        // Unload child after execution
        contextTokens -= child.tokens;
      }
    }

    if (contextTokens > peakTokens) peakTokens = contextTokens;
    steps.push(step);

    // Unload chunk after execution (keep results summary, ~10 tok)
    contextTokens -= node.tokens;
    contextTokens += 10; // result summary

    // Find next nodes
    for (const edge of graph.edges) {
      if (edge.from === nodeId && !visited.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  return {
    steps,
    totalTokensLoaded: totalLoaded,
    peakTokens,
    nodesVisited: visited.size,
  };
}
