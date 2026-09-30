import { describe, expect, it } from 'vitest';
import type { PNode } from '@arshdelight/pop-sdk';
import {
  buildIndex,
  nodeIndexFields,
  parseQuery,
  searchDocs,
  similarDocs,
  subtreeHashes,
  subtreeIndexFields,
  tokenize,
  type DocEntry,
} from '../src/retrieval.js';

// 检索内核的纯函数测试（不起子进程）：分词、查询解析、打分与排序。
// 这些是召回行为的**唯一真源**——CLI 层的端到端用例只验通路。

/** 确定性测试哈希：key 必须是 hex，右侧补零到 64 位（与真实节点同形） */
function doc(key: string, name: string, fields: Partial<DocEntry['fields']> = {}): DocEntry {
  return { hash: `sha256:${key.padEnd(64, '0')}`, name, fields: { name, ...fields } };
}

const NO_OWNER = { directSet: new Set<string>(), depthOf: new Map<string, number>() };

function hits(docs: DocEntry[], q: string, opts = NO_OWNER) {
  return searchDocs(docs, parseQuery(q.split(' ')), opts);
}

/** 命中的下标序列（比硬编码哈希更好读） */
function order(docs: DocEntry[], q: string, opts = NO_OWNER): number[] {
  const at = new Map(docs.map((d, i) => [d.hash, i]));
  return hits(docs, q, opts).hits.map((h) => at.get(h.hash)!);
}

describe('tokenize', () => {
  it('splits CJK into single characters plus adjacent bigrams', () => {
    expect(tokenize('断点续传')).toEqual(['断', '点', '续', '传', '断点', '点续', '续传']);
  });

  it('cuts CJK runs at punctuation, so bigrams never straddle a boundary', () => {
    const toks = tokenize('抽帧，键控');
    expect(toks).toContain('抽帧');
    expect(toks).toContain('键控');
    expect(toks).not.toContain('帧键'); // 标点处断开
  });

  it('keeps latin tokens whole and also emits their parts', () => {
    const toks = tokenize('copy user-data-dir now');
    expect(toks).toContain('user-data-dir');
    expect(toks).toContain('user');
    expect(toks).toContain('data');
    expect(toks).toContain('dir');
    expect(toks).toContain('copy');
  });

  it('trims leading/trailing separators (CLI flags) and is case-insensitive', () => {
    expect(tokenize('--no-playlist')).toEqual(['no-playlist', 'no', 'playlist']);
    expect(tokenize('YT-DLP')).toEqual(tokenize('yt-dlp'));
  });

  it('splits mixed CJK/latin text at the script boundary', () => {
    const toks = tokenize('用 yt-dlp 下载');
    expect(toks).toContain('yt-dlp');
    expect(toks).toContain('下载');
    expect(toks).not.toContain('用y');
  });
});

describe('parseQuery', () => {
  it('keeps words separate (AND semantics) instead of joining them into one string', () => {
    const q = parseQuery(['alpha', 'beta']);
    expect(q.raw).toBe('alpha beta');
    expect(q.words.map((w) => w.raw)).toEqual(['alpha', 'beta']);
  });

  it('maps field aliases and their value', () => {
    expect(parseQuery(['name:foo']).words[0]).toMatchObject({ raw: 'foo', field: 'name' });
    expect(parseQuery(['desc:foo']).words[0]).toMatchObject({ field: 'description' });
    expect(parseQuery(['content:foo']).words[0]).toMatchObject({ field: 'content' });
    expect(parseQuery(['outputs:foo']).words[0]).toMatchObject({ field: 'flow' });
  });

  it('treats a non-alias prefix as an ordinary term', () => {
    expect(parseQuery(['nope:foo']).words[0].field).toBeUndefined();
    expect(parseQuery(['nope:foo']).words[0].raw).toBe('nope:foo');
  });

  it('routes hash: and bare hex to a hash prefix', () => {
    expect(parseQuery(['deadbeef']).hashPrefix).toBe('deadbeef');
    expect(parseQuery(['hash:deadbeef']).hashPrefix).toBe('deadbeef');
    expect(parseQuery(['hash:deadbeef']).words).toHaveLength(0);
    expect(parseQuery(['zz']).hashPrefix).toBeUndefined(); // 太短，不是 hex 前缀
  });
});

describe('nodeIndexFields', () => {
  it('indexes declared inputs/outputs and the loop predicate (derived, never stored)', () => {
    const action = { type: 'action' as const, name: 'Heat', content: 'body', outputs: [{ name: 'boiling water' }] };
    expect(nodeIndexFields('sha256:x', action).fields.flow).toContain('boiling water');

    const loop = {
      type: 'practice' as const, name: 'Repeat', content: 'body', op: 'loop' as const,
      children: [{ hash: `sha256:${'0'.repeat(64)}` }], loop: { mode: 'until' as const, until: '颜色稳定' },
    };
    expect(nodeIndexFields('sha256:z', loop).fields.loop).toContain('颜色稳定');
    expect(nodeIndexFields('sha256:z', loop).fields.op).toBe('loop');
  });

  it('reads the node without mutating it (index text stays derived)', () => {
    const loop = {
      type: 'practice' as const, name: 'Repeat', content: 'body', op: 'loop' as const,
      children: [{ hash: `sha256:${'0'.repeat(64)}` }], loop: { mode: 'count' as const, count: 3 },
    };
    const before = JSON.stringify(loop);
    nodeIndexFields('sha256:z', loop);
    expect(JSON.stringify(loop)).toBe(before);
  });

  it('carries the note into its own field when one is supplied', () => {
    const action = { type: 'action' as const, name: 'Heat', content: 'body' };
    expect(nodeIndexFields('sha256:x', action, '实测 412 退避').fields.note).toBe('实测 412 退避');
    expect(nodeIndexFields('sha256:x', action).fields.note).toBeUndefined();
  });
});

describe('searchDocs: ranking', () => {
  it('ranks a name hit above a content hit', () => {
    const docs = [
      doc('aaaaaa', 'Body mention', { content: 'kimchi appears in the body' }),
      doc('bbbbbb', 'Kimchi stew', { content: 'nothing relevant' }),
    ];
    expect(order(docs, 'kimchi')).toEqual([1, 0]);
  });

  it('does not let a stray single CJK character in the name outrank a real phrase in the description', () => {
    const docs = [
      // 名字里只有一个偶然的单字「断」，靠**正文**里的完整短语命中
      doc('aaaaaa', '修复拉取中断', { content: '正文补一句断点续传的做法' }),
      // 摘要里就是完整短语
      doc('bbbbbb', 'Download helper', { description: '支持断点续传' }),
    ];
    expect(order(docs, '断点续传')).toEqual([1, 0]);
  });

  it('prefers the exact name over a longer name that merely contains the query', () => {
    const docs = [
      doc('aaaaaa', 'Needle topic extended', { content: 'body' }),
      doc('bbbbbb', 'Needle topic', { content: 'body' }),
    ];
    expect(order(docs, 'Needle topic')).toEqual([1, 0]);
  });
});

describe('searchDocs: recall semantics', () => {
  it('matches words across different fields (AND, not one joined string)', () => {
    const docs = [
      doc('aaaaaa', 'alpha', { content: 'beta lives here' }),
      doc('bbbbbb', 'alpha', { content: 'gamma only' }),
    ];
    const r = hits(docs, 'alpha beta');
    expect(r.mode).toBe('and');
    expect(order(docs, 'alpha beta')).toEqual([0]);
  });

  it('relaxes to partial matching only when a strict majority of the terms still hit', () => {
    const docs = [doc('aaaaaa', 'Solo marker', { content: 'body' })];
    expect(hits(docs, 'marker').mode).toBe('and'); // 全中，不必放宽
    // 三个词里对两个 → 过半 → 放宽（用户漏说了一个词）
    const three = [doc('aaaaaa', 'alpha doc', { content: 'beta lives here' })];
    expect(hits(three, 'alpha beta gamma').mode).toBe('or');
    expect(order(three, 'alpha beta gamma')).toEqual([0]);
    // 两个词里只中一个 → 不过半，宁可不给。旧实现会退化成 OR，把无关记录排到第一
    expect(hits(docs, 'marker absentword')).toEqual({ hits: [], mode: 'and' });
  });

  it('does not count single CJK characters toward the majority gate', () => {
    // 「配置目录」的多字 token 只有 配置/置目/目录：一条只把「配置」和「目录」写在
    // 两处（不相邻）的记录仍算命中两枚 → 放宽够格；而仅共享单字的记录不够格
    const nearMiss = [doc('aaaaaa', 'Other doc', { content: '先做配置，再看目录树' })];
    expect(hits(nearMiss, '配置目录').mode).toBe('or');
    const charOnly = [doc('bbbbbb', 'Char doc', { content: '配 目' })];
    expect(hits(charOnly, '配置目录').hits).toEqual([]);
  });

  it('rescues reversed CJK wording at the last relaxation level', () => {
    const docs = [
      doc('aaaaaa', '目录配置助手', { content: 'body' }),   // 词序与查询相反
      doc('bbbbbb', 'Unrelated doc', { content: 'body' }),
    ];
    // 严格档：全 bigram 都要中 → 零命中；放宽档按半数 token → 命中
    const r = hits(docs, '配置目录');
    expect(r.mode).toBe('or');
    expect(order(docs, '配置目录')).toEqual([0]);
  });

  it('does not relax a single-word query when every token matches', () => {
    const docs = [doc('aaaaaa', '目录配置助手', { content: 'body' })];
    expect(order(docs, '配置目录')).toEqual([0]);
  });

  it('restricts a field-qualified term to that field', () => {
    const docs = [
      doc('aaaaaa', 'Quartz named', { content: 'body' }),
      doc('bbbbbb', 'Other', { content: 'quartz in body' }),
    ];
    expect(order(docs, 'name:quartz')).toEqual([0]);
    expect(hits(docs, 'name:quartz').hits[0].matchedIn).toEqual(['name']);
  });

  it('reports which fields matched, in weight order', () => {
    const docs = [doc('aaaaaa', 'Kimchi stew', { description: 'fermented cabbage', content: 'kimchi again' })];
    expect(hits(docs, 'kimchi').hits[0].matchedIn).toEqual(['name', 'content']);
  });

  it('recalls every doc passed in — the caller decides the universe (all stored nodes)', () => {
    const docs = [
      doc('aaaaaa', 'Reachable root'),
      doc('bbbbbb', 'Only referenced by a flow'),
      doc('cccccc', 'Orphan nobody points at'),
    ];
    expect(order(docs, 'nobody')).toEqual([2]);
    expect(order(docs, 'flow')).toEqual([1]);
  });

  it('matches a hash prefix and labels the hit', () => {
    const docs = [doc('deadbeefcafe', 'Whatever', { content: 'body' })];
    const r = hits(docs, 'deadbe');
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].matchedIn).toEqual(['hash']);
  });
});

describe('searchDocs: determinism', () => {
  it('orders identical documents by hash ascending', () => {
    const docs = [
      doc('bbbbbb', 'Twin doc', { content: 'same text' }),
      doc('aaaaaa', 'Twin doc', { content: 'same text' }),
      doc('cccccc', 'Twin doc', { content: 'same text' }),
    ];
    expect(order(docs, 'twin')).toEqual([1, 0, 2]);
    expect(order(docs, 'twin')).toEqual(order(docs, 'twin'));
  });

  it('breaks ties by direct-first, then shallower depth', () => {
    const docs = [
      doc('aaaaaa', 'Twin doc', { content: 'same text' }),
      doc('bbbbbb', 'Twin doc', { content: 'same text' }),
    ];
    const opts = { directSet: new Set([docs[1].hash]), depthOf: new Map([[docs[1].hash, 0]]) };
    expect(order(docs, 'twin', opts)).toEqual([1, 0]);
  });

  it('ranks a shallower node above a deeper one at equal score', () => {
    const docs = [
      doc('aaaaaa', 'Twin doc', { content: 'same text' }),
      doc('bbbbbb', 'Twin doc', { content: 'same text' }),
    ];
    const opts = { directSet: new Set<string>(), depthOf: new Map([[docs[0].hash, 3], [docs[1].hash, 1]]) };
    expect(order(docs, 'twin', opts)).toEqual([1, 0]);
  });
});

describe('buildIndex', () => {
  it('weights the name field above content', () => {
    const idx = buildIndex([doc('aaaaaa', 'marker', { content: `${'x'.repeat(500)} marker` })]);
    expect(idx.postings.get('marker')![0].wtf).toBe(9); // name 8 + content 1
  });
});

/* ── 近邻（similar）── */

const H = (c: string) => `sha256:${c.repeat(64)}`;

describe('subtree aggregation', () => {
  const nodes = new Map<string, PNode>([
    [H('a'), { type: 'practice', name: 'Root practice', content: 'root body', op: 'seq', children: [{ hash: H('b') }, { hash: H('c') }] }],
    [H('b'), { type: 'practice', name: 'Middle', content: 'middle body', op: 'seq', children: [{ hash: H('c') }] }],
    [H('c'), { type: 'action', name: 'Leaf step', content: 'leaf body', outputs: [{ name: 'boiling water' }] }],
  ]);

  it('aggregates descendant text — a practice IS its tree', () => {
    const f = subtreeIndexFields(H('a'), nodes);
    expect(f.name).toBe('Root practice'); // 显示名仍是根
    expect(f.fields.content).toContain('root body');
    expect(f.fields.content).toContain('middle body');
    expect(f.fields.content).toContain('leaf body');
    expect(f.fields.flow).toContain('boiling water');
  });

  it('returns the children closure for exclusion (shared child counted once)', () => {
    expect([...subtreeHashes(H('a'), nodes)].sort()).toEqual([H('a'), H('b'), H('c')].sort());
    expect([...subtreeHashes(H('c'), nodes)]).toEqual([H('c')]);
  });
});

describe('similarDocs', () => {
  /** 验收：同一主题的两种措辞，相似度必须显著高于只是沾了一个词的记录 */
  const target = doc('tttttt', '配置目录复制', { content: '把浏览器配置目录复制到新位置' });
  const near = doc('nnnnnn', '复制 user-data-dir', { content: '把 user-data-dir 复制到新位置，先关掉浏览器' });
  const far = doc('ffffff', '目录权限修复', { content: 'chmod 修复目录权限问题' });

  it('ranks a same-topic paraphrase above a merely-related node', () => {
    const hits = similarDocs([target, near, far], target, new Set([target.hash]), 10);
    const hashes = hits.map((h) => h.hash);
    expect(hashes).toContain(near.hash);
    expect(hashes.indexOf(near.hash)).toBeLessThan(hashes.indexOf(far.hash));
    const byHash = new Map(hits.map((h) => [h.hash, h.score]));
    expect(byHash.get(near.hash)!).toBeGreaterThan(byHash.get(far.hash)! * 2); // 显著更高
  });

  it('never returns the excluded subtree or the target itself', () => {
    const hits = similarDocs([target, near, far], target, new Set([target.hash, near.hash]), 10);
    expect(hits.map((h) => h.hash)).toEqual([far.hash]);
  });

  it('drops nodes that share no wording at all (score 0 is not a neighbour)', () => {
    const unrelated = doc('uuuuuu', '泡菜做法', { content: '白菜抹盐发酵三天' });
    const hits = similarDocs([target, unrelated], target, new Set([target.hash]), 10);
    expect(hits).toEqual([]);
  });

  it('ignores single CJK characters, so shared function words do not create neighbours', () => {
    const stopwordOnly = doc('ssssss', '的了是在', { content: '我的他的你的' });
    const hits = similarDocs([target, stopwordOnly], target, new Set([target.hash]), 10);
    expect(hits).toEqual([]);
  });

  it('reports the shared terms that actually carried the score', () => {
    const hits = similarDocs([target, near], target, new Set([target.hash]), 10);
    expect(hits[0].shared).toContain('复制');
    expect(hits[0].shared.length).toBeLessThanOrEqual(5);
  });

  it('is deterministic and returns scores in (0, 1]', () => {
    const once = similarDocs([target, near, far], target, new Set([target.hash]), 10);
    const twice = similarDocs([target, near, far], target, new Set([target.hash]), 10);
    expect(once).toEqual(twice);
    for (const h of once) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it('honours the limit and breaks ties by hash ascending', () => {
    const twins = [doc('cccccc', '复制配置', { content: '复制配置目录' }), doc('aaaaaa', '复制配置', { content: '复制配置目录' })];
    const hits = similarDocs([target, ...twins], target, new Set([target.hash]), 10);
    expect(hits.map((h) => h.hash)).toEqual([twins[1].hash, twins[0].hash]);
    expect(similarDocs([target, ...twins], target, new Set([target.hash]), 1)).toHaveLength(1);
  });
});
