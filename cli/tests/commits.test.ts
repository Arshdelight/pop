import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendCommit, commitChainRoots, loadCommits, unpushedCommits } from '../src/commits.js';
import { tempDataDir } from './helpers.js';

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);
const HASH_C = 'sha256:' + 'c'.repeat(64);

function writeCommits(dir: string, commits: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'commits.json'), JSON.stringify({ schema: 1, commits }), 'utf8');
}

describe('commits ledger: fetched entries vs local edits (S2-3)', () => {
  it('legacy entries without origin stay local edits (backward compatible)', () => {
    const dir = tempDataDir();
    writeCommits(dir, [{ hash: HASH_A, from: null, message: '初版', createdAt: '2026-10-20T00:00:00Z' }]);
    const file = loadCommits(dir);
    expect(file.commits).toHaveLength(1);
    expect(file.commits[0].origin).toBeUndefined();
    expect(unpushedCommits(dir)).toHaveLength(1);
  });

  it('fetched entries are not unpushed commits (pull is not local leadership)', () => {
    const dir = tempDataDir();
    writeCommits(dir, [
      { hash: HASH_A, from: null, message: 'edited via practi edit', createdAt: '2026-10-20T00:00:00Z' },
      { hash: HASH_B, from: null, message: 'fetched from xiaohong/green-tea@main', createdAt: '2026-10-20T00:00:01Z', origin: 'fetched' },
    ]);
    const unpushed = unpushedCommits(dir);
    expect(unpushed).toHaveLength(1);
    expect(unpushed[0].hash).toBe(HASH_A);
  });

  it('commitChainRoots collects hash ∪ from — the gc reachability root set', () => {
    const dir = tempDataDir();
    writeCommits(dir, [
      { hash: HASH_B, from: HASH_A, message: 'v2', createdAt: '2026-10-20T00:00:00Z', pushedAt: '2026-10-20T00:01:00Z' },
      { hash: HASH_C, from: null, message: 'fetched from xiaohong/green-tea@main', createdAt: '2026-10-20T00:00:01Z', origin: 'fetched' },
    ]);
    const roots = commitChainRoots(dir);
    expect(roots).toEqual(new Set([HASH_A, HASH_B, HASH_C]));
  });

  it('appendCommit records origin=fetched on request', () => {
    const dir = tempDataDir();
    appendCommit(dir, HASH_A, null, 'fetched from o/n@main', 'fetched');
    const file = loadCommits(dir);
    expect(file.commits[0].origin).toBe('fetched');
  });
});
