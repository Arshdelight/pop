import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { computeNodeHash, stableStringify } from '../src/hash.js';
import type { ActionNode } from '../src/model.js';

const FAKE = `sha256:${'a'.repeat(64)}`;
const FAKE2 = `sha256:${'b'.repeat(64)}`;

// Appendix A vectors (pop-spec.md, byte-for-byte) */
const A1 = { type: 'action', name: 'Boil water', content: 'Heat until boiling.' } as const;
const H1 = 'sha256:f461f429ee82f6a3298aaac20adbfbec1c4d7c3aaf181dc24e653eaab75c3377';
const A2 = {
  type: 'action', name: 'Pour', description: 'Fill the cup',
  content: 'Pour along the wall to 70% full.',
  license: 'CC-BY-4.0',
  metadata: { 'x-demo': 'teapot' },
  inputs: [{ name: 'hot water', from: H1 }],
  outputs: [{ name: 'cup of tea', spec: '85°C' }],
} as const;
const H2 = 'sha256:7846bcba677a1585219647dfe6ba137cdaa9b4335a7b25c6991580e19ffe233f';
const H3 = 'sha256:95d4872db873283352020393a00381bfda021038ac701a107c33be8cab571d3a';

function action(partial: Partial<ActionNode> = {}): ActionNode {
  return { type: 'action', name: 'X', content: 'b', ...partial };
}

describe('computeNodeHash', () => {
  it('key order does not affect the hash', () => {
    const n1 = action({ attachments: [{ name: 'x', hash: FAKE }] });
    const n2 = action({ attachments: [{ hash: FAKE, name: 'x' } as unknown as { name: string; hash: string }] });
    expect(computeNodeHash(n1)).toBe(computeNodeHash(n2));
  });

  it('children contribute their hash (Merkle): a different child pin changes the parent hash', () => {
    const p1 = { type: 'practice', name: 'P', content: 'b', op: 'seq', children: [{ hash: FAKE }] } as const;
    const p2 = { type: 'practice', name: 'P', content: 'b', op: 'seq', children: [{ hash: FAKE2 }] } as const;
    expect(computeNodeHash(p1)).not.toBe(computeNodeHash(p2));
  });

  it('child order participates (seq is ordered)', () => {
    const p1 = { type: 'practice', name: 'P', content: '', op: 'seq', children: [{ hash: FAKE }, { hash: FAKE2 }] } as const;
    const p2 = { type: 'practice', name: 'P', content: '', op: 'seq', children: [{ hash: FAKE2 }, { hash: FAKE }] } as const;
    expect(computeNodeHash(p1)).not.toBe(computeNodeHash(p2));
  });

  it('a child pin carrying anything beyond hash is rejected loudly (§8)', () => {
    const p = { type: 'practice', name: 'P', content: '', op: 'seq', children: [{ hash: FAKE, name: 'x' }] } as const;
    expect(() => computeNodeHash(p)).toThrowError(/E_HASH_FORMAT|pin/);
  });

  it('keys sort by Unicode code point, not UTF-16 code units (astral-plane keys keep code-point order)', () => {
    // U+FFFF is a BMP character, U+1F600 (😀) is astral: code-point order puts U+FFFF first.
    // JavaScript's default sort (UTF-16 code units, surrogate 0xD83D < 0xFFFF) would reverse them.
    const canonical = stableStringify({ '\u{1F600}': 'a', '\uFFFF': 'b' });
    expect(canonical.indexOf('\uFFFF')).toBeGreaterThan(0);
    expect(canonical.indexOf('\uFFFF')).toBeLessThan(canonical.indexOf('\u{1F600}'));
  });

  it('empty ≡ absent is enforced by the hash itself (total function): empties never fork identity', () => {
    expect(computeNodeHash(action({ description: '' }))).toBe(computeNodeHash(action()));
    expect(computeNodeHash(action({ description: '   ' }))).toBe(computeNodeHash(action()));
    expect(computeNodeHash(action({ license: '' }))).toBe(computeNodeHash(action()));
    expect(computeNodeHash(action({ inputs: [] }))).toBe(computeNodeHash(action()));
    expect(computeNodeHash(action({ outputs: [] }))).toBe(computeNodeHash(action()));
    const p = { type: 'practice', name: 'P', content: '', op: 'seq', children: [{ hash: FAKE }] } as const;
    expect(computeNodeHash({ ...p, refines: '' })).toBe(computeNodeHash(p));
  });

  it('metadata values are arbitrary JSON and participate in the hash (recursive canonical serialization)', () => {
    const m1 = action({ metadata: { 'x-tools': ['Bash', 'Read'] } });
    const m2 = action({ metadata: { 'x-tools': ['Read', 'Bash'] } }); // arrays are ordered — order matters
    expect(computeNodeHash(m1)).not.toBe(computeNodeHash(m2));
    const m3 = action({ metadata: { 'x-flags': { verbose: true, quiet: false } } });
    const m4 = action({ metadata: { 'x-flags': { quiet: false, verbose: true } } }); // key order irrelevant, recursively
    expect(computeNodeHash(m3)).toBe(computeNodeHash(m4));
  });

  it('content participates trimmed', () => {
    expect(computeNodeHash(action({ content: '\n  hello  \n' }))).toBe(computeNodeHash(action({ content: 'hello' })));
    expect(computeNodeHash(action({ content: 'hello' }))).not.toBe(computeNodeHash(action({ content: 'world' })));
  });

  it('hash format is the sha256 prefix + 64 hex digits', () => {
    expect(computeNodeHash(action())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('inputs/outputs participate in the content hash (identity is content)', () => {
    const base = action();
    const withFlow: ActionNode = { ...base, outputs: [{ name: 'hot water', spec: '85°C' }] };
    expect(computeNodeHash(base)).not.toBe(computeNodeHash(withFlow));
  });

  it("attachment url does not participate in the node hash (§5) — only name/hash/mime/size do", () => {
    const a1 = action({ attachments: [{ name: 'x', hash: FAKE, mime: 'image/png', size: 10, url: 'https://a.example.com/x.png' }] });
    const a2 = action({ attachments: [{ name: 'x', hash: FAKE, mime: 'image/png', size: 10, url: 'https://b.example.com/x.png' }] });
    expect(computeNodeHash(a1)).toBe(computeNodeHash(a2));
  });

  it('attachment hash participates in the node hash (changed bytes → changed identity)', () => {
    const a1 = action({ attachments: [{ name: 'x', hash: FAKE }] });
    const a2 = action({ attachments: [{ name: 'x', hash: FAKE2 }] });
    expect(computeNodeHash(a1)).not.toBe(computeNodeHash(a2));
  });
});

describe('Appendix A vectors (pop-spec.md, byte-for-byte)', () => {
  it('A1 minimal action', () => {
    expect(computeNodeHash(A1)).toBe(H1);
  });

  it('A2 full-field action (description + license + metadata + inputs + outputs; from = A1 hash)', () => {
    expect(computeNodeHash(A2)).toBe(H2);
  });

  it('A3 practice pinning A1/A2 (children contribute their hashes)', () => {
    expect(computeNodeHash({
      type: 'practice', name: 'Make tea', content: '', op: 'seq',
      children: [{ hash: H1 }, { hash: H2 }],
    })).toBe(H3);
  });

  it('A4 equivalence: whitespace around A1 content leaves the hash unchanged (trim rule)', () => {
    expect(computeNodeHash({ ...A1, content: '  Heat until boiling.  ' })).toBe(H1);
  });

  it('A5 blob vector: photo-bytes (UTF-8, 11 bytes)', () => {
    // sha256 of the literal bytes — protocol-independent, unchanged across versions
    expect(`sha256:${createHash('sha256').update('photo-bytes').digest('hex')}`)
      .toBe('sha256:dac6f451810bc38390a3b6e278d686b332a77cf21b2ea95145ad73722b77035d');
  });

  it('A6 stableStringify', () => {
    expect(stableStringify({ b: 1, a: undefined, c: [2, { d: null }] })).toBe('{"b":1,"c":[2,{"d":null}]}');
  });

  it('A7 pin ↔ inline interchangeability: A3 written with A1/A2 inlined hashes identically', () => {
    expect(computeNodeHash({
      type: 'practice', name: 'Make tea', content: '', op: 'seq',
      children: [A1, A2],
    })).toBe(H3);
  });

  it('A8 Merkle: editing a descendant content changes the root hash (the root covers the whole tree)', () => {
    const h8 = computeNodeHash({
      type: 'practice', name: 'Make tea', content: '', op: 'seq',
      children: [A1, { ...A2, content: 'Pour along the wall to 80% full.' }],
    });
    expect(h8).not.toBe(H3);
    expect(h8).toBe('sha256:1974200356cf6d553ff2fce2305460c3c20d6f6e46155180070eb0fc5e62488f');
  });
});
