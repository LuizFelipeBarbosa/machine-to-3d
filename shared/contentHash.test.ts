import { describe, expect, test } from 'vitest';
import { contentHash } from './contentHash';

describe('contentHash', () => {
  test('sorts object keys recursively, including objects inside arrays', () => {
    expect(contentHash({ z: [{ b: 2, a: 1 }], a: { y: true, x: null } }))
      .toBe(contentHash({ a: { x: null, y: true }, z: [{ a: 1, b: 2 }] }));
  });

  test.each([2, '1', false, null])('changes when a nested value changes to %j', (value) => {
    expect(contentHash({ nested: { value } })).not.toBe(contentHash({ nested: { value: 1 } }));
  });

  test('preserves array order', () => {
    expect(contentHash({ steps: ['first', 'second'] }))
      .not.toBe(contentHash({ steps: ['second', 'first'] }));
  });

  test('returns a zero-padded 64-bit FNV-1a hash', () => {
    expect(contentHash({})).toBe('08f44b07b5901a25');
    expect(contentHash({ title: 'Vídeo 🛠' })).toMatch(/^[0-9a-f]{16}$/);
  });

  test('follows JSON semantics for undefined properties and array entries', () => {
    expect(contentHash({ a: undefined, b: [undefined] })).toBe(contentHash({ b: [null] }));
    expect(() => contentHash(undefined)).toThrow('Value is not JSON serializable');
    expect(() => contentHash(1n)).toThrow(TypeError);
  });
});
