/**
 * Pins that composition extras are discovered by enumeration, not by a list of
 * field names the CLI happens to know.
 */

import { describe, expect, test } from 'bun:test';
import { parseAtom } from '../src/commands/registry';

const atom = (body: string) => parseAtom(`widget Gadget {\n${body}\n}`, '/tmp/g.prime', '@scope/gadget');

describe('parseAtom composition extras', () => {
  test('keeps a field from a domain the CLI has never heard of', () => {
    const meta = atom(`  composition: {
    quuxoid-budget: "3"
  }`);
    expect(meta.compositionExtras).toEqual({ 'quuxoid-budget': '3' });
  });

  test('does not duplicate the universal composition fields into extras', () => {
    const meta = atom(`  composition: {
    must-include: [ @a/b ]
    must-avoid: [ @c/d ]
  }`);
    expect(Object.keys(meta.compositionExtras)).toEqual([]);
    expect(meta.mustInclude).toEqual(['@a/b']);
    expect(meta.mustAvoid).toEqual(['@c/d']);
  });

  test('captures a list-valued extra as one entry, not as its inner keys', () => {
    const meta = atom(`  composition: {
    thing-refs: [ @a/b, @c/d ]
  }`);
    expect(Object.keys(meta.compositionExtras)).toEqual(['thing-refs']);
    expect(meta.compositionExtras['thing-refs']).toContain('@a/b');
  });

  test('returns no extras when there is no composition block', () => {
    expect(atom(`  name: "gadget"`).compositionExtras).toEqual({});
  });

  test('reads the kind as declared', () => {
    expect(atom(`  name: "gadget"`).kind).toBe('widget');
  });
});
