/**
 * @module ast
 * AST (Abstract Syntax Tree) node types for parsed .prime source files.
 *
 * These types represent the raw parse tree before any semantic analysis.
 * They mirror the concrete syntax of .prime files.
 */

import type { PrimeType, PrimeDecorator, Identifier, Version } from "./base";

// ─── Atom Kind (opaque) ───────────────────────────────────────────────────────

/**
 * An atom/unit kind as written in the source: an **opaque string**.
 *
 * The engine deliberately does not know which kinds exist. Legality is decided
 * by the Model Package that declares the TypeDefinitions (see ADR-1: atom types
 * are external), never by a TypeScript union here — a union would make "the
 * engine owns the domain ontology" true at the type level and would force a
 * Core edit for every new domain.
 *
 * @deprecated Prefer plain `string`. This alias only exists so the remaining
 * AST field keeps a name that says what it holds; it carries no constraint.
 */
export type AtomKind = string;

// ─── Source Location ────────────────────────────────────────────────────────

/**
 * Source location info attached to every AST node for diagnostics and source maps.
 */
export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
}

// ─── AST Node Types ─────────────────────────────────────────────────────────

/**
 * Base interface for all AST nodes.
 */
export interface ASTNodeBase {
  /** Node type discriminant */
  type: string;
  /** Source location of the node */
  loc: SourceLocation;
}

/**
 * The root AST node for a .prime file.
 */
export interface PrimeAST extends ASTNodeBase {
  type: "PrimeDeclaration";
  /** PascalCase class name (e.g. "OWASPTop10") */
  name: string;
  /** Parent class name after `extends` keyword, if any */
  extends?: string;
  /** The Prime class type inferred from extends chain (Knowledge, Method, Rule) */
  class?: PrimeType;
  /** Decorators applied before the `prime` keyword */
  decorators: DecoratorNode[];
  /** All body fields */
  body: FieldNode[];
  /** Source filename (if provided) */
  filename?: string;
  /** Parsed version for quick access */
  version?: Version;

  // ─── Inheritance Modifiers ───────────────────
  /** Fields that override parent fields */
  overrides?: OverrideNode[];
  /** Fields that are appended to parent arrays */
  appends?: AppendNode[];
  /** Fields that extend parent arrays with additional items */
  extensions?: ExtendNode[];
}

/**
 * The root AST node for a new-style atom declaration.
 *
 * Syntax:  `<kind> Identifier { field* }`
 *
 * Examples:
 *   fact WcagFocusContrast { ... }
 *   method DesignCritique { ... }
 *   collection AccessibleFrontend { ... }
 *
 * For backwards-compatibility the old `prime Name extends Base { ... }` form
 * still produces a `PrimeAST` node (type === "PrimeDeclaration").
 */
export interface AtomDeclaration extends ASTNodeBase {
  type: "AtomDeclaration";
  /** The kind token as written in the source; resolved against a Model Package. */
  kind: AtomKind;
  /** PascalCase or CamelCase name, e.g. "WcagFocusContrast". */
  name: string;
  /** Decorators applied before the keyword, e.g. @sealed. */
  decorators: DecoratorNode[];
  /** All body fields. */
  body: FieldNode[];
  /** Source filename (if provided). */
  filename?: string;
}
export interface TypeRefNode extends ASTNodeBase { type: "TypeRef"; name: string; }
export interface UnitDeclaration extends ASTNodeBase { type: "UnitDeclaration"; name: string; typeRef: TypeRefNode; decorators: DecoratorNode[]; body: FieldNode[]; filename?: string; }
export type SyntaxAST = PrimeAST | AtomDeclaration | UnitDeclaration;
/** Legacy declarations accepted by checker/chunker/emitter pipelines. */
export type LegacySyntaxAST = PrimeAST | AtomDeclaration;

/**
 * A decorator node (e.g. @sealed, @abstract).
 */
export interface DecoratorNode extends ASTNodeBase {
  type: "Decorator";
  /** The full decorator text including "@" (e.g. "@sealed") */
  name: string;
}

/**
 * A field within the prime body: `key: value`.
 */
export interface FieldNode extends ASTNodeBase {
  type: "Field";
  /** Field key (identifier) */
  key: string;
  /** Field value */
  value: ValueNode;
  /** Field-level decorators (e.g. @safe, @deprecated) */
  decorators?: DecoratorNode[];
}

/**
 * Override field: `override dotpath { ... }`
 */
export interface OverrideNode extends ASTNodeBase {
  type: "Override";
  /** Dotted path (e.g. ["steps", "ANALYZE"]) */
  path: string[];
  /** Body fields inside the override block */
  body: FieldNode[];
}

/**
 * Append field: `append ident { ... }` or `append ident [ ... ]`
 */
export interface AppendNode extends ASTNodeBase {
  type: "Append";
  /** Target identifier */
  target: string;
  /** Appended content (object block or array items) */
  value: ObjectNode | ArrayNode;
}

/**
 * Extend field: `extend ident [ ... ]`
 */
export interface ExtendNode extends ASTNodeBase {
  type: "Extend";
  /** Target identifier */
  target: string;
  /** Extended array items */
  value: ArrayNode;
}

// ─── Value Nodes ────────────────────────────────────────────────────────────

/**
 * All possible value types in the AST.
 */
export type ValueNode =
  | StringNode
  | NumberNode
  | BooleanNode
  | IdentNode
  | ObjectNode
  | ArrayNode
  | ArrowNode
  | StepNode
  | ReferenceNode
  | EnumValueNode
  | LinkShorthandNode
  | ThresholdNode
  | ParameterShorthandNode;

/**
 * String literal: `"hello"`.
 */
export interface StringNode extends ASTNodeBase {
  type: "String";
  value: string;
}

/**
 * Number literal: `42`, `3.14`.
 */
export interface NumberNode extends ASTNodeBase {
  type: "Number";
  value: number;
}

/**
 * Boolean literal: `true` or `false`.
 */
export interface BooleanNode extends ASTNodeBase {
  type: "Boolean";
  value: boolean;
}

/**
 * Plain identifier (used as reference or keyword value): `fail`, `pass`, `Knowledge`.
 */
export interface IdentNode extends ASTNodeBase {
  type: "Ident";
  value: string;
}

/**
 * Dotted path reference: `TDD.steps.RED`.
 */
export interface ReferenceNode extends ASTNodeBase {
  type: "Reference";
  /** Path segments (e.g. ["TDD", "steps", "RED"]) */
  path: string[];
  /** Optional alias from `as aliasName` */
  alias?: string;
}

/**
 * Object literal: `{ key: value, ... }`.
 */
export interface ObjectNode extends ASTNodeBase {
  type: "Object";
  fields: FieldNode[];
}

/**
 * Array literal: `[ item, item, ... ]`.
 */
export interface ArrayNode extends ASTNodeBase {
  type: "Array";
  items: ValueNode[];
}

/**
 * Arrow expression: `"trigger" -> "response"`.
 */
export interface ArrowNode extends ASTNodeBase {
  type: "Arrow";
  left: StringNode;
  right: StringNode;
}

/**
 * Step shorthand node: `RED { "description" expect: fail error: "msg" }`.
 */
export interface StepNode extends ASTNodeBase {
  type: "Step";
  /** Step name identifier */
  name: string;
  /** Step body fields (descriptions as string fields, plus expect/error/use) */
  body: (FieldNode | StringNode)[];
}

/**
 * Enum value node: `@decidable`, `@measurable`, `@subjective`.
 */
export interface EnumValueNode extends ASTNodeBase {
  type: "EnumValue";
  value: string;
}

/**
 * Link shorthand node: `requires "owasp-top-10"`.
 */
export interface LinkShorthandNode extends ASTNodeBase {
  type: "LinkShorthand";
  verb: string;
  target: string;
  modifiers?: ObjectNode;
}

/**
 * Threshold shorthand: `line_coverage block: < 60% warn: < 80% pass: >= 80%`.
 */
export interface ThresholdNode extends ASTNodeBase {
  type: "Threshold";
  metric: string;
  levels: { level: string; operator: string; value: number; unit?: string }[];
}

/**
 * Parameter shorthand: `task(string) "description"`.
 */
export interface ParameterShorthandNode extends ASTNodeBase {
  type: "ParameterShorthand";
  name: string;
  paramType: string;
  description?: string;
}

// ─── Simplified Field/Value types (for compiled representation) ─────────────

/**
 * A simplified field representation used in compiled output.
 * Unlike the full AST FieldNode, this has no source location info.
 */
export interface Field {
  /** Field name */
  name: string;
  /** The parsed value */
  value: Value;
}

/**
 * A simplified value representation used in compiled output.
 * Primitive JSON-compatible types without source location info.
 */
export type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [key: string]: Value };
