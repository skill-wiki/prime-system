/**
 * These tests exist to pin the one property the de-domaining depends on: a verb
 * or kind the CLI has never seen must behave identically to a prime-v1 one. If a
 * future change reintroduces a vocabulary table, the "unknown verb" cases fail.
 */

import { describe, expect, test } from 'bun:test';
import { extractRelations, extractKind, extractStringField } from '../src/utils/relations';
import { colorKind, paintFor, kindPadding } from '../src/utils/kind-color';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('extractRelations', () => {
  test('reads a legacy verb and an unknown verb identically', () => {
    const src = `prime Foo extends Bar {
  name: "foo"
  requires "@a/b"
  frobnicates "@c/d"
}`;
    const { relations, parseErrors } = extractRelations(src, 'foo.prime');
    expect(parseErrors).toEqual([]);
    expect(relations.map((r) => [r.verb, r.target])).toEqual([
      ['requires', '@a/b'],
      ['frobnicates', '@c/d'],
    ]);
  });

  test('preserves source order and line numbers', () => {
    const src = `prime Foo extends Bar {
  alpha "@a/1"
  beta "@a/2"
}`;
    const { relations } = extractRelations(src, 'foo.prime');
    expect(relations.map((r) => r.verb)).toEqual(['alpha', 'beta']);
    expect(relations.map((r) => r.line)).toEqual([2, 3]);
  });

  test('works on the kind form, where the type name is not a keyword', () => {
    const src = `widget Gadget {
  name: "gadget"
  powers "@a/b"
}`;
    const { relations } = extractRelations(src, 'g.prime');
    expect(relations).toEqual([{ verb: 'powers', target: '@a/b', line: 3 }]);
  });

  test('returns no relations for a unit that declares none', () => {
    const { relations } = extractRelations(`prime Foo extends Bar {\n  name: "foo"\n}`, 'f.prime');
    expect(relations).toEqual([]);
  });

  test('surfaces parse failure instead of reporting an empty graph', () => {
    const { relations, parseErrors } = extractRelations('this is not prime source at all', 'bad.prime');
    expect(relations).toEqual([]);
    expect(parseErrors.length).toBeGreaterThan(0);
  });

  test('does not mistake a typed parameter declaration for a relation', () => {
    const src = `prime Foo extends Bar {
  input: [
    target(string)  "what to act on"
  ]
}`;
    const { relations } = extractRelations(src, 'f.prime');
    expect(relations.map((r) => r.verb)).not.toContain('target');
  });
});

describe('extractKind', () => {
  test('returns the declared kind for the kind form', () => {
    expect(extractKind('widget Gadget {\n  name: "g"\n}', 'g.prime')).toBe('widget');
  });

  test('returns the base for the legacy form', () => {
    expect(extractKind('prime Foo extends Whatever {\n  name: "f"\n}', 'f.prime')).toBe('Whatever');
  });

  test('returns undefined on unparseable source', () => {
    expect(extractKind('%%%', 'x.prime')).toBeUndefined();
  });
});

describe('extractStringField', () => {
  test('reads a scalar field', () => {
    expect(extractStringField('widget G {\n  description: "hi"\n}', 'description', 'g.prime')).toBe('hi');
  });

  test('returns undefined for an absent field', () => {
    expect(extractStringField('widget G {\n  name: "g"\n}', 'description', 'g.prime')).toBeUndefined();
  });
});

describe('colorKind', () => {
  test('is stable for the same kind across calls', () => {
    expect(colorKind('anything')).toBe(colorKind('anything'));
  });

  test('colours a kind the CLI has never seen, without falling back to grey', () => {
    const unknown = colorKind('quuxoid');
    expect(strip(unknown)).toBe('quuxoid');
    expect(unknown).not.toBe(`\x1b[90mquuxoid\x1b[0m`);
  });

  test('marks an absent kind as missing data rather than colouring it', () => {
    expect(strip(colorKind(''))).toBe('(no kind)');
  });

  test('paintFor and colorKind agree', () => {
    expect(paintFor('fact')('fact')).toBe(colorKind('fact'));
  });

  test('kindPadding pads by visible width, not by escape-code length', () => {
    const padded = kindPadding('abc', 10);
    expect(strip(padded)).toBe('abc' + ' '.repeat(7));
  });

  test('kindPadding never returns a negative pad', () => {
    expect(strip(kindPadding('averylongkindname', 3))).toBe('averylongkindname');
  });
});
