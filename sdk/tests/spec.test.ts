import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { readSpec, POP_SPEC_VERSION } from '../src/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('bundled spec', () => {
  it('the package copy is byte-identical to the repo root pop-spec.md', () => {
    const rootSpec = readFileSync(resolve(repoRoot, 'pop-spec.md'), 'utf8');
    expect(readSpec()).toBe(rootSpec);
  });

  it('the spec header version matches POP_SPEC_VERSION', () => {
    const m = readSpec().match(/normatively defines POP, \*\*version ([0-9.]+)\*\*/);
    expect(m, 'spec header must carry "**version X.Y.Z**" (keep in sync with POP_SPEC_VERSION)').not.toBeNull();
    expect(m![1]).toBe(POP_SPEC_VERSION);
  });
});
