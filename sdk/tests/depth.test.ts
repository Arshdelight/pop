import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/doc.js';
import { computeNodeHash, stableStringify, type HashableNode } from '../src/hash.js';
import { MAX_JSON_DEPTH, MAX_NODE_DEPTH } from '../src/model.js';
import { PracticeError } from '../src/errors.js';

/**
 * Resource guards (spec §6): recursion is how every layer walks trees and JSON
 * values, so unbounded nesting must surface as a typed E_SCHEMA refusal — never
 * a stack RangeError. The limits are generous (real practices are <10 deep);
 * these tests pin the boundary on both sides.
 */

/** A chain of n practices over a leaf action — the leaf sits at tree depth n */
function chain(n: number): Record<string, unknown> {
  let node: Record<string, unknown> = { name: 'leaf', content: 'x' };
  for (let i = 0; i < n; i++) node = { name: `p${i}`, content: 'c', children: [node] };
  return node;
}

/** A value nested n object-wrappers deep (metadata-style JSON, no node fields) */
function nested(n: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = { v };
  return v;
}

function expectSchemaError(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PracticeError);
    expect((err as PracticeError).code).toBe('E_SCHEMA');
    return;
  }
  throw new Error('expected an E_SCHEMA refusal, got success');
}

describe('depth guards', () => {
  it('accepts a tree at exactly MAX_NODE_DEPTH', () => {
    const doc = parseDocument(chain(MAX_NODE_DEPTH));
    expect(doc.rootHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses a tree one level deeper with E_SCHEMA, not a stack overflow', () => {
    expectSchemaError(() => parseDocument(chain(MAX_NODE_DEPTH + 1)));
  });

  it('guards the direct hash entry point too (computeNodeHash is public, not only parseDocument)', () => {
    expectSchemaError(() => computeNodeHash(chain(MAX_NODE_DEPTH + 1) as unknown as HashableNode));
  });

  it('a direct-hash of the parsed root agrees with parseDocument (both channels, one identity)', () => {
    const doc = parseDocument(chain(50));
    expect(computeNodeHash(doc.root)).toBe(doc.rootHash);
  });

  it('accepts metadata nested at MAX_JSON_DEPTH and refuses one level deeper', () => {
    const at = parseDocument({ name: 'a', metadata: { deep: nested(MAX_JSON_DEPTH) } });
    expect(at.rootHash).toMatch(/^sha256:/);
    expectSchemaError(() => parseDocument({ name: 'a', metadata: { deep: nested(MAX_JSON_DEPTH + 1) } }));
  });

  it('stableStringify refuses nesting beyond the limit with E_SCHEMA', () => {
    expectSchemaError(() => stableStringify(nested(MAX_JSON_DEPTH + 10)));
    expect(stableStringify(nested(MAX_JSON_DEPTH))).toMatch(/^\{"v"/);
  });
});
