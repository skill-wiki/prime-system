/**
 * A deterministic expression evaluator — §9.7's first Evaluation Provider class,
 * and the thing §5.4's `preconditions: - expression: "input.rules.length > 0"`
 * has needed since it was written.
 *
 * It is a hand-written tokenizer and Pratt parser, not `eval` or `new Function`,
 * because §12.3 is explicit that model and corpus data must not implicitly gain
 * code execution. There is deliberately **no call syntax at all**: `.length` is a
 * property, not a function, so there is no production in this grammar that can
 * reach a host object. There is also no arithmetic, no regular expression, and no
 * date or random access, which is what makes the same expression over the same
 * value produce the same verdict on every machine and every run.
 */

export class ExpressionError extends Error {}

type Token =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "punct"; readonly value: string };

const PUNCTUATION = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "(", ")", "[", "]", ".", ","] as const;

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) { index++; continue }
    if (/[0-9]/.test(char)) {
      let end = index;
      while (end < source.length && /[0-9]/.test(source[end]!)) end++;
      if (source[end] === ".") { end++; while (end < source.length && /[0-9]/.test(source[end]!)) end++ }
      tokens.push({ kind: "number", value: Number(source.slice(index, end)) });
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      // No escape sequences: a value that needs one is a value this language is
      // not meant to compare, and a half-implemented escape table is a silent
      // wrong answer rather than a refusal.
      const end = source.indexOf(char, index + 1);
      if (end < 0) throw new ExpressionError(`Unterminated string literal at offset ${index}`);
      tokens.push({ kind: "string", value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_$-]/.test(source[end]!)) end++;
      tokens.push({ kind: "name", value: source.slice(index, end) });
      index = end;
      continue;
    }
    const punct = PUNCTUATION.find(candidate => source.startsWith(candidate, index));
    if (!punct) throw new ExpressionError(`Unexpected character ${JSON.stringify(char)} at offset ${index}`);
    tokens.push({ kind: "punct", value: punct });
    index += punct.length;
  }
  return tokens;
}

export type ExpressionNode =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "path"; readonly root: string; readonly steps: readonly (string | number)[] }
  | { readonly kind: "not"; readonly operand: ExpressionNode }
  | { readonly kind: "binary"; readonly operator: string; readonly left: ExpressionNode; readonly right: ExpressionNode };

const COMPARISONS = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">="]);

class Parser {
  private position = 0;
  constructor(private readonly tokens: readonly Token[]) {}
  private peek(): Token | undefined { return this.tokens[this.position] }
  private eat(value: string): boolean { const token = this.peek(); if (token?.kind === "punct" && token.value === value) { this.position++; return true } return false }
  private expect(value: string): void { if (!this.eat(value)) throw new ExpressionError(`Expected ${value}`) }

  parse(): ExpressionNode { const node = this.or(); if (this.position !== this.tokens.length) throw new ExpressionError("Trailing tokens after expression"); return node }

  private or(): ExpressionNode { let left = this.and(); while (this.eat("||")) left = { kind: "binary", operator: "||", left, right: this.and() }; return left }
  private and(): ExpressionNode { let left = this.comparison(); while (this.eat("&&")) left = { kind: "binary", operator: "&&", left, right: this.comparison() }; return left }

  private comparison(): ExpressionNode {
    const left = this.unary();
    const token = this.peek();
    if (token?.kind === "punct" && COMPARISONS.has(token.value)) { this.position++; return { kind: "binary", operator: token.value, left, right: this.unary() } }
    if (token?.kind === "name" && token.value === "in") { this.position++; return { kind: "binary", operator: "in", left, right: this.unary() } }
    return left;
  }

  private unary(): ExpressionNode { return this.eat("!") ? { kind: "not", operand: this.unary() } : this.primary() }

  private primary(): ExpressionNode {
    if (this.eat("(")) { const node = this.or(); this.expect(")"); return node }
    const token = this.peek();
    if (token === undefined) throw new ExpressionError("Unexpected end of expression");
    this.position++;
    if (token.kind === "number" || token.kind === "string") return { kind: "literal", value: token.value };
    if (token.kind === "name") {
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      const steps: (string | number)[] = [];
      for (;;) {
        if (this.eat(".")) { const next = this.peek(); if (next?.kind !== "name") throw new ExpressionError("Expected a property name after '.'"); this.position++; steps.push(next.value); continue }
        if (this.eat("[")) { const next = this.peek(); if (next?.kind !== "number" || !Number.isInteger(next.value) || next.value < 0) throw new ExpressionError("Array index must be a non-negative integer literal"); this.position++; this.expect("]"); steps.push(next.value); continue }
        break;
      }
      return { kind: "path", root: token.value, steps };
    }
    throw new ExpressionError(`Unexpected token ${token.value}`);
  }
}

/** The named values an expression may read. Nothing else is in scope, so an expression cannot reach the host at all. */
export type ExpressionScope = Readonly<Record<string, unknown>>;

function step(value: unknown, key: string | number): unknown {
  if (value === null || value === undefined) throw new ExpressionError(`Cannot read ${String(key)} of ${value === null ? "null" : "undefined"}`);
  if (typeof key === "number") { if (!Array.isArray(value)) throw new ExpressionError("Index access requires an array"); return value[key] }
  // `length` is answered here rather than by property lookup so that arrays and
  // strings expose it and objects cannot shadow it with data.
  if (key === "length") { if (Array.isArray(value) || typeof value === "string") return value.length; throw new ExpressionError("length is only defined for arrays and strings") }
  if (typeof value !== "object" || Array.isArray(value)) throw new ExpressionError(`Cannot read property ${key} of a ${Array.isArray(value) ? "array" : typeof value}`);
  // `Object.hasOwn` rather than a plain read, so no expression can reach a
  // prototype member such as `constructor`.
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function ordered(left: unknown, right: unknown, operator: string): boolean {
  if (typeof left === "number" && typeof right === "number") return operator === "<" ? left < right : operator === "<=" ? left <= right : operator === ">" ? left > right : left >= right;
  if (typeof left === "string" && typeof right === "string") return operator === "<" ? left < right : operator === "<=" ? left <= right : operator === ">" ? left > right : left >= right;
  throw new ExpressionError(`Operator ${operator} requires two numbers or two strings`);
}

function evaluateNode(node: ExpressionNode, scope: ExpressionScope): unknown {
  switch (node.kind) {
    case "literal": return node.value;
    case "path": {
      if (!Object.hasOwn(scope, node.root)) throw new ExpressionError(`Unknown name in expression: ${node.root}`);
      let value = scope[node.root];
      for (const key of node.steps) value = step(value, key);
      return value;
    }
    case "not": return !truth(evaluateNode(node.operand, scope));
    case "binary": {
      if (node.operator === "&&") return truth(evaluateNode(node.left, scope)) && truth(evaluateNode(node.right, scope));
      if (node.operator === "||") return truth(evaluateNode(node.left, scope)) || truth(evaluateNode(node.right, scope));
      const left = evaluateNode(node.left, scope), right = evaluateNode(node.right, scope);
      if (node.operator === "in") {
        if (Array.isArray(right)) return right.some(one => one === left);
        if (typeof right === "string" && typeof left === "string") return right.includes(left);
        throw new ExpressionError("Operator in requires an array, or two strings");
      }
      if (node.operator === "==" || node.operator === "===") return left === right;
      if (node.operator === "!=" || node.operator === "!==") return left !== right;
      return ordered(left, right, node.operator);
    }
  }
}

/** Only booleans are truthy. `0`, `""` and `undefined` are refused rather than coerced, because a coerced verdict is a verdict nobody wrote. */
function truth(value: unknown): boolean { if (typeof value !== "boolean") throw new ExpressionError(`Expected a boolean, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`); return value }

export function parseExpression(source: string): ExpressionNode { if (source.trim() === "") throw new ExpressionError("Expression is empty"); return new Parser(tokenize(source)).parse() }

/** Throws `ExpressionError` on anything it cannot answer. Every caller in this repo turns that into a recorded refusal, never into a pass. */
export function evaluateExpression(source: string, scope: ExpressionScope): boolean { return truth(evaluateNode(parseExpression(source), scope)) }
