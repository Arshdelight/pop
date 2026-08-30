import { describe, expect, it } from 'vitest';
import { matchClaimRef } from '../src/cmd/pull.js';

// matchClaimRef is pull's only addressing logic against the remote claims list.
// The hub cannot be spawned for integration tests, so it is covered here as a
// pure function; the contract mirrors SDK resolveNodeRef (§3 node addressing).

const A = `sha256:a1a1a1${'a'.repeat(58)}`;
const B = `sha256:a1a1a1${'b'.repeat(58)}`; // shares the 'a1a1a1' prefix with A
const C = `sha256:f00d${'c'.repeat(60)}`;
const CLAIMS = [{ root_hash: A }, { root_hash: B }, { root_hash: C }];

describe('matchClaimRef: ref addressing over the remote claims list', () => {
  it('full hash, with and without the sha256: prefix', () => {
    expect(matchClaimRef(CLAIMS, A)).toEqual({ ok: true, rootHash: A });
    expect(matchClaimRef(CLAIMS, A.slice('sha256:'.length))).toEqual({ ok: true, rootHash: A });
  });

  it('unique short prefix (≥4 hex), case-insensitive', () => {
    expect(matchClaimRef(CLAIMS, 'f00d')).toEqual({ ok: true, rootHash: C });
    expect(matchClaimRef(CLAIMS, 'F00D')).toEqual({ ok: true, rootHash: C });
    expect(matchClaimRef(CLAIMS, 'a1a1a1a')).toEqual({ ok: true, rootHash: A });
  });

  it('ambiguous prefix lists candidates', () => {
    const m = matchClaimRef(CLAIMS, 'a1a1a1');
    expect(m.ok).toBe(false);
    if (!m.ok) {
      expect(m.code).toBe('ambiguous');
      expect(m.message).toContain('matches 2');
      expect(m.message).toContain('lengthen the prefix');
    }
  });

  it('malformed refs report format, not a missing claim', () => {
    for (const ref of ['abc', 'xyz!', 'sha256:zz', '']) {
      const m = matchClaimRef(CLAIMS, ref);
      expect(m.ok).toBe(false);
      if (!m.ok) expect(m.code).toBe('format');
    }
  });

  it('well-formed ref absent from the claims keeps the clone hint', () => {
    const m = matchClaimRef(CLAIMS, 'c0de');
    expect(m.ok).toBe(false);
    if (!m.ok) {
      expect(m.code).toBe('not-found');
      expect(m.message).toContain('not in your claims');
      expect(m.message).toContain('clone');
    }
  });
});
