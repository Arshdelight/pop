import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_THRESHOLDS,
  computeNodeHash,
  proseLength,
  qualityWarnings,
  type ActionNode,
  type Attachment,
  type FlowItem,
  type PNode,
  type PracticeNode,
  type QualityWarning,
} from '../src/index.js';

/**
 * W_* 记录质量提示：**非阻断**。这些用例锁两件事——
 *  1. 每条规则在该报的时候报、不该报的时候不报；
 *  2. W_* 不是校验：它不抛错、不拒收，绝不与 E_* 混为一谈。
 */

interface Spec {
  type: 'action' | 'practice';
  name: string;
  content?: string;
  description?: string;
  op?: 'seq' | 'par' | 'choice' | 'loop' | 'set';
  outputs?: FlowItem[];
  attachments?: Attachment[];
  children?: Spec[];
}

/** 造一棵树：默认值刻意「健康」，好让每个用例只暴露被测的那一条规则。
 *  practice 不默认带 description —— 「有没有描述」本身就是要测的规则之一。 */
function build(specs: Spec[]): { nodes: Map<string, PNode>; roots: string[] } {
  const nodes = new Map<string, PNode>();
  const buildOne = (s: Spec): PNode => {
    if (s.type === 'action') {
      const n: ActionNode = {
        type: 'action',
        name: s.name,
        content: s.content ?? 'long enough content to clear the thin-content threshold',
        outputs: s.outputs ?? [{ name: 'a verifiable result' }],
      };
      if (s.description !== undefined) n.description = s.description;
      if (s.attachments !== undefined) n.attachments = s.attachments;
      nodes.set(computeNodeHash(n), n);
      return n;
    }
    const kids = (s.children ?? []).map(buildOne);
    const n: PracticeNode = {
      type: 'practice',
      name: s.name,
      content: s.content ?? '',
      op: s.op ?? 'seq',
      children: kids.map(k => ({ hash: computeNodeHash(k) })),
    };
    if (s.description !== undefined) n.description = s.description;
    nodes.set(computeNodeHash(n), n);
    return n;
  };
  const built = specs.map(buildOne);
  return { nodes, roots: built.map(b => computeNodeHash(b)) };
}

/** 只看某一类提示，免得默认值带来的无关告警干扰断言 */
function only(specs: Spec[], code: string, overrides = {}): QualityWarning[] {
  const { nodes, roots } = build(specs);
  return qualityWarnings(roots, nodes, overrides).filter(w => w.code === code);
}

const action = (name: string, extra: Partial<Spec> = {}): Spec => ({ type: 'action', name, ...extra });
const practice = (name: string, children: Spec[], extra: Partial<Spec> = {}): Spec =>
  ({ type: 'practice', name, children, ...extra });

describe('W_THIN_CONTENT', () => {
  it('fires on a near-empty action with no attachments', () => {
    const hits = only([action('烘干', { content: '烘干' })], 'W_THIN_CONTENT');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('烘干');
    expect(hits[0].message).toContain('2 chars');
  });

  it('stays quiet when the text is long enough, or when attachments carry the evidence', () => {
    expect(only([action('Short but evidenced', { content: 'x', attachments: [{ name: 'demo.png', hash: `sha256:${'a'.repeat(64)}` }] })], 'W_THIN_CONTENT')).toEqual([]);
    expect(only([action('Long enough', { content: 'y'.repeat(40) })], 'W_THIN_CONTENT')).toEqual([]);
  });

  it('measures content with whitespace stripped', () => {
    expect(only([action('Padded', { content: `   ${'\n'.repeat(10)}  ` })], 'W_THIN_CONTENT')).toHaveLength(1);
  });

  it('honours a threshold override (thresholds are implementation policy)', () => {
    expect(only([action('Ten chars.', { content: '0123456789' })], 'W_THIN_CONTENT', { minContentChars: 5 })).toEqual([]);
    expect(only([action('Ten chars.', { content: '0123456789' })], 'W_THIN_CONTENT', { minContentChars: 80 })).toHaveLength(1);
  });
});

describe('W_NO_VERIFY', () => {
  it('fires on an action that declares no outputs', () => {
    const hits = only([action('确认站点资源已验证', { outputs: [] })], 'W_NO_VERIFY');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('acceptance criteria');
  });

  it('stays quiet when outputs are declared, and never fires on practices', () => {
    expect(only([action('Has outputs')], 'W_NO_VERIFY')).toEqual([]);
    expect(only([practice('Root', [action('Has outputs')])], 'W_NO_VERIFY')).toEqual([]);
  });
});

describe('proseLength', () => {
  it('keeps prose and drops fenced code blocks', () => {
    const body = ['alpha beta', '```powershell', '$x = 1', '```', 'gamma'].join('\n');
    expect(proseLength(body)).toBe('alpha beta\ngamma'.length);
  });

  it('treats a fence as switched off only by the next fence, language tag or not', () => {
    const body = ['~~~js', 'const a = 1;', '~~~', 'tail'].join('\n');
    expect(proseLength(body)).toBe('tail'.length);
  });

  it('counts indented and inline code as prose — only fenced blocks are excluded', () => {
    expect(proseLength('    indented code')).toBe('indented code'.length);
    expect(proseLength('use `practi show` here')).toBe('use `practi show` here'.length);
  });
});

describe('W_CONTENT_LONG', () => {
  it('fires on a node whose prose passes the limit', () => {
    const hits = only([action('Kitchen sink', { content: 'x'.repeat(2001) })], 'W_CONTENT_LONG');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('Kitchen sink');
    expect(hits[0].message).toContain('2001 chars of prose');
  });

  it('stays quiet at the limit — the calibrated boundary is 2000', () => {
    expect(DEFAULT_QUALITY_THRESHOLDS.maxContentChars).toBe(2000);
    expect(only([action('Just fits', { content: 'x'.repeat(2000) })], 'W_CONTENT_LONG')).toEqual([]);
  });

  it('excludes code blocks, so a long reference node made of commands is not punished', () => {
    // 3000 字全是代码：total 早已超限，散文为 0 → 不报。贴完整命令是好习惯，不是啰嗦。
    const codeHeavy = ['intro line', '```cpp', 'y'.repeat(3000), '```'].join('\n');
    expect(only([action('Interop definition', { content: codeHeavy })], 'W_CONTENT_LONG')).toEqual([]);
  });

  it('still fires when the prose alone passes the limit, however much code sits alongside', () => {
    const mixed = ['z'.repeat(2100), '```sh', 'echo hi', '```'].join('\n');
    const hits = only([action('Half prose', { content: mixed })], 'W_CONTENT_LONG');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('2100 chars of prose');
  });

  it('measures prose with whitespace stripped', () => {
    expect(only([action('Padded', { content: `  ${'x'.repeat(2001)}  \n\n   ` })], 'W_CONTENT_LONG')).toHaveLength(1);
  });

  it('honours a threshold override (thresholds are implementation policy)', () => {
    expect(only([action('Medium', { content: 'x'.repeat(100) })], 'W_CONTENT_LONG', { maxContentChars: 50 })).toHaveLength(1);
    expect(only([action('Medium', { content: 'x'.repeat(100) })], 'W_CONTENT_LONG', { maxContentChars: 500 })).toEqual([]);
  });

  it('is not a gate: the same node also draws ordinary node-level coding, never an error', () => {
    const hits = only([action('Long and unverifiable', { content: 'x'.repeat(2001), outputs: [] })], 'W_NO_VERIFY');
    expect(hits).toHaveLength(1);
  });
});

describe('W_FLAT_TREE', () => {
  const flat = (n: number, extra: Partial<Spec> = {}): Spec =>
    practice('Flat root', Array.from({ length: n }, (_, i) => action(`Step ${i + 1}`, { content: `${'z'.repeat(50)} ${i}` })), extra);

  it('fires when a practice has many children and none of them are grouped', () => {
    const hits = only([flat(9)], 'W_FLAT_TREE');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('9 child steps');
  });

  it('stays quiet at or below the threshold (the calibrated p90 boundary is 8)', () => {
    expect(DEFAULT_QUALITY_THRESHOLDS.maxFlatChildren).toBe(8);
    expect(only([flat(8)], 'W_FLAT_TREE')).toEqual([]);
  });

  it('stays quiet once the children are grouped — nesting is the fix', () => {
    const grouped = practice('Grouped root', [
      practice('Group A', [action('A1'), action('A2')], { description: 'g' }),
      ...Array.from({ length: 8 }, (_, i) => action(`Step ${i}`, { content: `${'z'.repeat(50)} ${i}` })),
    ]);
    expect(only([grouped], 'W_FLAT_TREE')).toEqual([]);
  });

  it('never fires on a set — a directory view is supposed to have many entries', () => {
    expect(only([flat(12, { op: 'set' })], 'W_FLAT_TREE')).toEqual([]);
  });

  it('never fires on a single source’s timestamped chapter list — a video walkthrough is flat by design', () => {
    const chapters = Array.from({ length: 10 }, (_, i) =>
      action(`${i + 1}. 建模操作（原视频 ${i}:00–${i}:59）`, { content: `${'z'.repeat(60)} ${i}` }));
    expect(only([practice('P07（视频导看）', chapters, { description: 'd' })], 'W_FLAT_TREE')).toEqual([]);
  });

  it('accepts a plain hyphen between the timestamps too, not just the en dash', () => {
    const chapters = Array.from({ length: 9 }, (_, i) =>
      action(`Chapter ${i + 1} (video ${i}:00-${i}:59)`, { content: `${'z'.repeat(60)} ${i}` }));
    expect(only([practice('Walkthrough', chapters, { description: 'd' })], 'W_FLAT_TREE')).toEqual([]);
  });

  it('still fires when only a few children carry timestamps — the exemption needs the list to be one', () => {
    const mixed = [
      ...Array.from({ length: 7 }, (_, i) => action(`Step ${i}`, { content: `${'z'.repeat(60)} ${i}` })),
      action('Chapter (原视频 1:00–2:00)', { content: 'z'.repeat(60) }),
      action('Another (原视频 2:00–3:00)', { content: 'z'.repeat(70) }),
    ];
    expect(only([practice('Mixed', mixed, { description: 'd' })], 'W_FLAT_TREE')).toHaveLength(1);
  });
});

describe('W_DEEP_TREE', () => {
  const chain = (depth: number): Spec => {
    let node: Spec = action('Leaf', { content: 'leaf body that is long enough to pass' });
    for (let i = depth - 1; i >= 0; i--) node = practice(`Level ${i}`, [node]);
    return node;
  };

  it('fires once on the root when the tree is deeper than the limit', () => {
    const hits = only([chain(7)], 'W_DEEP_TREE');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('Level 0');
    expect(hits[0].message).toContain('depth 7');
  });

  it('is silent at the limit', () => {
    expect(only([chain(6)], 'W_DEEP_TREE')).toEqual([]);
  });
});

describe('W_DUP_NAME', () => {
  it('fires once per duplicated name and reports how many nodes share it', () => {
    const tree = practice('Root', [
      action('Same name', { content: 'first body, long enough to pass the thin check' }),
      action('Same name', { content: 'second body, different so the hashes differ' }),
    ]);
    const hits = only([tree], 'W_DUP_NAME');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('2 nodes');
  });

  it('stays quiet when every node has its own name', () => {
    expect(only([practice('Root', [action('One'), action('Two')])], 'W_DUP_NAME')).toEqual([]);
  });
});

describe('W_VAGUE_NAME', () => {
  it.each(['步骤 2', 'step 3', '1', '完成', 'untitled', '...'])('fires on the placeholder name %j', (name) => {
    expect(only([action(name)], 'W_VAGUE_NAME')).toHaveLength(1);
  });

  it.each(['定位配置目录', 'Step through the OAuth dance', '3. 萤火虫：平面发射器'])('stays quiet on a real name %j', (name) => {
    expect(only([action(name)], 'W_VAGUE_NAME')).toEqual([]);
  });
});

describe('W_DESC_MISSING', () => {
  it('fires on a practice root with no description — the field search leans on most', () => {
    const hits = only([practice('Bare root', [action('Step')])], 'W_DESC_MISSING');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('Bare root');
    expect(hits[0].message).toContain('hardest node to find again');
  });

  it('treats an empty description the same as an absent one', () => {
    expect(only([practice('Blank root', [action('Step')], { description: '' })], 'W_DESC_MISSING')).toHaveLength(1);
  });

  it('stays quiet when the root has a description', () => {
    expect(only([practice('Described root', [action('Step')], { description: 'what this does' })], 'W_DESC_MISSING')).toEqual([]);
  });

  it('applies to the document root only — an inner practice is not nagged for it', () => {
    const inner = practice('Inner', [action('Step')]);
    expect(only([practice('Outer root', [inner], { description: 'outer' })], 'W_DESC_MISSING')).toEqual([]);
  });
});

describe('quality warnings are advisory, never a gate', () => {
  it('never throws and never mutates the nodes it inspects', () => {
    const { nodes, roots } = build([practice('Root', [action('步骤 1', { content: 'x', outputs: [] })])]);
    const before = JSON.stringify([...nodes.entries()]);
    expect(() => qualityWarnings(roots, nodes)).not.toThrow();
    expect(JSON.stringify([...nodes.entries()])).toBe(before);
  });

  it('returns an empty list for a clean tree and for unknown roots', () => {
    const { nodes, roots } = build([practice('Clean root', [action('A real step'), action('Another real step')], { description: 'clean' })]);
    expect(qualityWarnings(roots, nodes)).toEqual([]);
    expect(qualityWarnings([`sha256:${'f'.repeat(64)}`], nodes)).toEqual([]);
    expect(qualityWarnings([], nodes)).toEqual([]);
  });

  it('is deterministic and reports a shared node once, not once per referencing tree', () => {
    const shared = action('Shared step', { content: 'x', outputs: [] });
    const { nodes, roots } = build([practice('Root one', [shared]), practice('Root two', [action('Other'), shared])]);
    const once = qualityWarnings(roots, nodes);
    expect(once).toEqual(qualityWarnings(roots, nodes));
    // 该节点正好两条提示（过薄 + 无产出）；若按树重复体检，这里会是 4 条
    expect(once.filter(w => w.name === 'Shared step')).toHaveLength(2);
    // 节点级提示不重复：(code, hash) 在结果里唯一
    const keys = once.map(w => `${w.code}|${w.hash}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sorts by node then code, so output is stable regardless of traversal luck', () => {
    const { nodes, roots } = build([practice('Root', [action('步骤 1', { content: 'x', outputs: [] })], { description: 'd' })]);
    const codes = qualityWarnings(roots, nodes).map(w => w.code);
    expect(codes.length).toBeGreaterThan(1);
    expect([...codes].sort()).toEqual(codes);
  });
});
