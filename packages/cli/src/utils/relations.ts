/**
 * Generic relation extraction: a relation's verb is *data*, never a constant.
 *
 * Every command that used to carry its own
 * `/(?:requires|validates_with|enhances|contradicts|…)/` regex was asserting a
 * closed set of relation names, plus (in `graph`) which of them are mandatory
 * and which one blocks a composition. Architecture §3.1 puts exactly those two
 * judgements outside the engine: the engine may know "there are relation
 * definitions", not that `requires` exists nor that `contradicts` is fatal.
 *
 * It also removes a second-order duplication (§8.1): the regexes were a private
 * re-parse of .prime source living beside the real parser. The parser already
 * handles an unknown verb — `frobnicates "@a/b"` yields the same node shape as
 * `requires "@a/b"` — so reading the AST needs no vocabulary at all.
 */

import { parse } from '@skill-wiki/parser';
import type { FieldNode, ValueNode } from '@skill-wiki/types';

export interface RelationRef {
  /** The verb exactly as the source spelled it. Not validated, not ranked. */
  readonly verb: string;
  /** The reference target as written. Resolution is the resolver's job. */
  readonly target: string;
  readonly line: number;
}

export interface ExtractResult {
  readonly relations: readonly RelationRef[];
  /** Parse failures are surfaced, never swallowed: no relations != no errors. */
  readonly parseErrors: readonly string[];
}

/**
 * A statement of the form `<verb> "<target>"`.
 *
 * The parser emits `LinkShorthand` for verbs its own `LINK_VERBS` set happens to
 * list, and the generic `ParameterShorthand` for every other verb. Both are
 * accepted here so a model-declared verb the parser has never seen behaves
 * identically — which is the whole point.
 */
function asRelation(field: FieldNode): { verb: string; target: string } | undefined {
  const value: ValueNode = field.value;
  if (value.type === 'LinkShorthand') {
    return { verb: value.verb, target: value.target };
  }
  // `paramType` is non-empty only for `name(Type) "description"` parameter
  // declarations, which are not relations.
  if (value.type === 'ParameterShorthand' && value.paramType === '' && value.description !== undefined) {
    return { verb: value.name, target: value.description };
  }
  return undefined;
}

/** Extract every relation statement from .prime source, in source order. */
export function extractRelations(source: string, filename?: string): ExtractResult {
  let body: readonly FieldNode[];
  const parseErrors: string[] = [];
  try {
    const result = parse(source, filename);
    body = result.ast.body;
    for (const err of result.errors) parseErrors.push(err.message);
  } catch (err) {
    return { relations: [], parseErrors: [(err as Error).message] };
  }

  const relations: RelationRef[] = [];
  for (const field of body) {
    const rel = asRelation(field);
    if (rel !== undefined && rel.target.length > 0) {
      relations.push({ verb: rel.verb, target: rel.target, line: field.loc.line });
    }
  }
  return { relations, parseErrors };
}

/** The declared kind/base of a unit, as written. `undefined` when absent. */
export function extractKind(source: string, filename?: string): string | undefined {
  try {
    const { ast } = parse(source, filename);
    if (ast.type === 'AtomDeclaration') return ast.kind;
    if (ast.type === 'UnitDeclaration') return ast.typeRef.name;
    return ast.extends;
  } catch {
    return undefined;
  }
}

/** A scalar `key: "value"` field read off the AST rather than by regex. */
export function extractStringField(source: string, key: string, filename?: string): string | undefined {
  try {
    const { ast } = parse(source, filename);
    const field = ast.body.find((f) => f.key === key);
    if (field !== undefined && field.value.type === 'String') return field.value.value;
    return undefined;
  } catch {
    return undefined;
  }
}
