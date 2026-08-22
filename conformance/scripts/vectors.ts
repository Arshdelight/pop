/** Regenerate Appendix A vectors (run: npx tsx scripts/vectors.ts) */
import { computeNodeHash, stableStringify } from '../src/hash.js';
import { createHash } from 'node:crypto';

const A1 = { type: 'action', name: 'Boil water', content: 'Heat until boiling.' } as const;
const H1 = computeNodeHash(A1);

const A2 = {
  type: 'action', name: 'Pour', description: 'Fill the cup',
  content: 'Pour along the wall to 70% full.',
  license: 'CC-BY-4.0',
  metadata: { 'x-demo': 'teapot' },
  inputs: [{ name: 'hot water', from: H1 }],
  outputs: [{ name: 'cup of tea', spec: '85°C' }],
} as const;
const H2 = computeNodeHash(A2);

const A3 = {
  type: 'practice', name: 'Make tea', content: '', op: 'seq',
  children: [{ hash: H1 }, { hash: H2 }],
} as const;
const H3 = computeNodeHash(A3);

const A7 = {
  type: 'practice', name: 'Make tea', content: '', op: 'seq',
  children: [A1, A2],
} as const;
const H7 = computeNodeHash(A7);

const A8 = {
  type: 'practice', name: 'Make tea', content: '', op: 'seq',
  children: [A1, { ...A2, content: 'Pour along the wall to 80% full.' }],
} as const;
const H8 = computeNodeHash(A8);

const A4a = computeNodeHash({ ...A1, content: '  Heat until boiling.  ' });

console.log('A1 (minimal action)      =', H1);
console.log('A2 (full action, from=H1)=', H2);
console.log('A3 (practice, pins)      =', H3);
console.log('A7 (inline ≡ A3?)        =', H7, H7 === H3 ? '✓ equal' : '✗ MISMATCH');
console.log('A8 (descendant edited)   =', H8, H8 !== H3 ? '✓ differs (Merkle)' : '✗ MISMATCH');
console.log('A4 (trim ≡ A1?)          =', A4a, A4a === H1 ? '✓ equal' : '✗ MISMATCH');
console.log('A5 (blob photo-bytes)    =', `sha256:${createHash('sha256').update('photo-bytes').digest('hex')}`);
console.log('A6 (stableStringify)     =', stableStringify({ b: 1, a: undefined, c: [2, { d: null }] }));
