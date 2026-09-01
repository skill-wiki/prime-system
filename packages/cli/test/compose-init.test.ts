/**
 * Pins the two behaviours that used to be domain-coupled: composition sections
 * follow the kinds the corpus declares (not a fixed knowledge/method/rule
 * trichotomy), and no relation is synthesised from a pair of kind names.
 */

import { describe, expect, test } from 'bun:test';
import { collectRelationships, generateSkill, type AvailablePrime } from '../src/commands/compose';
import { generateTemplate } from '../src/commands/init';

const unit = (name: string, kind: string, links: { verb: string; target: string }[] = []): AvailablePrime => ({
  name, kind, description: `${name} desc`, version: '1.0.0', links,
});

describe('collectRelationships', () => {
  test('reports a declared relation between two available units', () => {
    const units = [unit('a', 'widget', [{ verb: 'powers', target: 'b' }]), unit('b', 'gadget')];
    expect(collectRelationships(units)).toEqual([{ from: 'a', to: 'b', verb: 'powers' }]);
  });

  test('resolves a scoped target to the bare unit name', () => {
    const units = [unit('a', 'widget', [{ verb: 'powers', target: '@scope/b' }]), unit('b', 'gadget')];
    expect(collectRelationships(units)).toEqual([{ from: 'a', to: 'b', verb: 'powers' }]);
  });

  test('drops a target that is not in the available set', () => {
    expect(collectRelationships([unit('a', 'widget', [{ verb: 'powers', target: 'absent' }])])).toEqual([]);
  });

  test('synthesises no relation from a pair of kinds', () => {
    // The removed rule was: every `rule` validates every `method`.
    const units = [unit('r', 'rule'), unit('m', 'method')];
    expect(collectRelationships(units)).toEqual([]);
  });
});

describe('generateSkill', () => {
  test('emits one section per declared kind, in first-appearance order', () => {
    const md = generateSkill('demo', [unit('a', 'widget'), unit('b', 'gadget'), unit('c', 'widget')], []);
    expect(md.indexOf('## widget')).toBeGreaterThan(-1);
    expect(md.indexOf('## gadget')).toBeGreaterThan(md.indexOf('## widget'));
  });

  test('numbers units continuously across sections', () => {
    const md = generateSkill('demo', [unit('a', 'widget'), unit('b', 'gadget')], []);
    expect(md).toContain('1. **a**');
    expect(md).toContain('2. **b**');
  });

  test('handles a kind the CLI has never seen without a fallback bucket', () => {
    const md = generateSkill('demo', [unit('z', 'quuxoid')], []);
    expect(md).toContain('## quuxoid');
  });

  test('buckets a unit with no declared kind under a neutral heading', () => {
    expect(generateSkill('demo', [unit('z', '')], [])).toContain('## unit');
  });

  test('lists declared relations verbatim when there are any', () => {
    const md = generateSkill('demo', [unit('a', 'widget')], [{ from: 'a', to: 'b', verb: 'powers' }]);
    expect(md).toContain('- a `powers` b');
  });

  test('omits the relations section when none are declared', () => {
    expect(generateSkill('demo', [unit('a', 'widget')], [])).not.toContain('Declared relations');
  });
});

describe('generateTemplate', () => {
  test('uses the type name the caller supplied as the declaration head', () => {
    expect(generateTemplate('my-thing', 'Quuxoid', 'd', ['t'])).toContain('Quuxoid MyThing {');
  });

  test('emits only universal fields, no per-type field ontology', () => {
    const out = generateTemplate('my-thing', 'Quuxoid', 'd', []);
    for (const field of ['input:', 'output:', 'steps:', 'checks:', 'categories:', 'success_criteria:']) {
      expect(out).not.toContain(field);
    }
    for (const field of ['name:', 'version:', 'description:', 'tags:', 'license:']) {
      expect(out).toContain(field);
    }
  });

  test('round-trips through the parser', async () => {
    const { parse } = await import('@aoe/parser');
    const { ast, errors } = parse(generateTemplate('my-thing', 'Quuxoid', 'd', ['a', 'b']), 'my-thing.prime');
    expect(errors).toEqual([]);
    expect(ast.type).toBe('AtomDeclaration');
  });
});
