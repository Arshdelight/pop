import { describe, expect, it } from 'vitest';
import { nodeIndexFields, parseQuery, searchDocs, type DocEntry } from '../src/retrieval.js';

/**
 * 召回**质量**回归夹具。
 *
 * 其余测试覆盖的是机制（分词与 HF 逐位一致、融合确定性、缓存格式），
 * 这一份覆盖的是**排序结果本身**：给了这份语料，该被搜到的记录就得排在该在的位置。
 * 有了它，谁再动 BM25 参数、字段权重或分层加分，把召回改坏了会立刻红。
 *
 * 语料是合成的小型技术实践集（含刻意设置的干扰项与近义项），不依赖用户的私有语料；
 * 断言以「进前 N」为主、只有无歧义的才锁 top-1，避免对合理调参过度敏感。
 */

interface Spec {
  name: string;
  description?: string;
  content?: string;
  outputs?: { name: string; spec?: string }[];
  inputs?: { name: string; spec?: string }[];
  children?: Spec[];
}

/** 把嵌套 spec 摊平成节点表（practice 只作为容器，索引文本仍按节点各自算） */
function corpus(specs: readonly Spec[]): DocEntry[] {
  const out: DocEntry[] = [];
  let n = 0;
  const walk = (s: Spec): void => {
    const hash = `sha256:${String(n++).padStart(4, '0')}${'a'.repeat(60)}`;
    const node = {
      type: (s.children === undefined ? 'action' : 'practice') as 'action' | 'practice',
      name: s.name,
      ...(s.description !== undefined ? { description: s.description } : {}),
      content: s.content ?? '',
      ...(s.outputs !== undefined ? { outputs: s.outputs } : {}),
      ...(s.inputs !== undefined ? { inputs: s.inputs } : {}),
    } as never;
    out.push(nodeIndexFields(hash, node));
    for (const c of s.children ?? []) walk(c);
  };
  for (const s of specs) walk(s);
  return out;
}

/** 用户语料里真实存在的那类东西：中文为主、夹杂拉丁工具名与版本号 */
const SPECS: readonly Spec[] = [
  {
    name: '用 yt-dlp 下载 B 站视频（412 防御版）',
    description: '整季与单集两种下法，含 412 限流的规避',
    content: '先装 yt-dlp 与 ffmpeg，再按选集结构决定用 playlist 还是单集 URL。',
    children: [
      { name: '安装 yt-dlp 并确认 ffmpeg', content: 'winget 装完跑 yt-dlp --version 与 ffmpeg -version 对版本。', outputs: [{ name: '可用的 yt-dlp 与 ffmpeg', spec: '两个命令都能打印版本' }] },
      { name: '启动整季下载（带 archive）', content: '用 --download-archive 断点续传，中断了再跑不会重复下。', inputs: [{ name: '可用的 yt-dlp 与 ffmpeg' }], outputs: [{ name: '完整的视频文件集' }] },
    ],
  },
  {
    name: 'Blender 入门 P34：萤火虫粒子+花草随风摇曳动画',
    description: '平面发射器做萤火虫，布朗运动让它飘起来',
    content: '重力改 0 粒子就往上飘，再加布朗运动强度 20 就无规则飞舞。',
    children: [
      { name: '3. 萤火虫：平面发射器 + 布朗运动', content: '新建平面当发射器，粒子渲染为小球，重力 0 + 布朗 20。', outputs: [{ name: '飞舞的萤火虫群', spec: '重力 0 + 布朗 20' }] },
      { name: '4. 调蝴蝶飞行路径，消灭死亡旋转', content: '用曲线约束飞行路径，避免原地打转。' },
    ],
  },
  {
    name: '修复 GitHub 部分克隆仓库的慢 checkout 与拉取中断',
    description: 'partial clone 的惰性抓取会把 checkout 拖成几分钟',
    content: '把远端换成直连、加大 postBuffer，并给 fetch 加 --filter=blob:none 的兜底。',
    children: [
      { name: '浅克隆仓库', content: 'git clone --depth 1 --filter=blob:none 先把骨架拿到手。', outputs: [{ name: '浅克隆的本地仓库' }] },
      { name: '分批 fetch-pack 拉取缺失对象', content: '按 OID 分批拉，避免一次性把远端拖垮。' },
    ],
  },
  {
    name: '麦克风降噪与增益校正',
    description: '把底噪压下去再补回人声电平',
    content: '先录一段纯底噪做噪声采样，再用降噪滤镜处理，最后统一增益到 -16 LUFS。',
    outputs: [{ name: '可用的录音素材', spec: '底噪低于 -60dB' }],
  },
  {
    name: '批量下载字幕为 SRT',
    description: '用 yt-dlp 拉 CC 字幕并转成 SRT',
    content: '--write-auto-subs --convert-subs srt 一条命令搞定。',
    outputs: [{ name: 'SRT 字幕文件' }],
  },
  {
    name: '低内存 Linux 服务器配置 Swap 交换分区',
    description: '小内存机器加交换分区避免 OOM',
    content: 'fallocate 建文件、mkswap、swapon，再写进 fstab 持久化。',
  },
  {
    name: '给网站图片做磨砂玻璃面板',
    description: 'Next.js + Tailwind 的 backdrop-blur 实现',
    content: 'backdrop-filter: blur(12px) 配合半透明底色，注意 Safari 的前缀。',
  },
  {
    name: '泡菜做法',
    description: '白菜抹盐发酵三天',
    content: '抹盐压两小时出水，抹辣酱后冷藏发酵三天。',
  },
];

const DOCS = corpus(SPECS);
const NO_OWNER = { directSet: new Set<string>(), depthOf: new Map<string, number>() };

/** 命中里的名次（按节点名匹配子串），1-based；未命中返回 -1 */
function rankOf(query: string, pattern: string): number {
  const { hits } = searchDocs(DOCS, parseQuery(query.split(' ')), NO_OWNER);
  const at = hits.findIndex((h) => DOCS[Number(h.hash.slice(7, 11))].name.includes(pattern));
  return at === -1 ? -1 : at + 1;
}

const inTop = (query: string, pattern: string, n: number): void => {
  const r = rankOf(query, pattern);
  expect(r, `"${query}" 应在前 ${n} 名内命中「${pattern}」，实际名次 ${r}`).toBeGreaterThan(0);
  expect(r, `"${query}" 命中「${pattern}」但排在第 ${r} 名`).toBeLessThanOrEqual(n);
};

describe('召回质量：精确词与标题', () => {
  it('把名字里就写着查询词的记录排在第一位', () => {
    expect(rankOf('泡菜', '泡菜做法')).toBe(1);
    expect(rankOf('Swap', '配置 Swap')).toBe(1);
  });

  it('拉丁工具名不受大小写与连字符影响', () => {
    expect(rankOf('YT-DLP', 'yt-dlp')).toBe(1);
    expect(rankOf('ffmpeg', 'yt-dlp')).toBeLessThanOrEqual(3);
  });

  it('标题命中优先于正文命中', () => {
    // 「浅克隆仓库」名字里有「克隆」；「修复 GitHub 部分克隆仓库…」名字里也有
    // 但描述的「partial clone」不含「克隆」——两者都该排在只提过一次的正文命中之前
    expect(rankOf('克隆', '浅克隆仓库')).toBeLessThanOrEqual(2);
  });
});

describe('召回质量：多词与字段限定', () => {
  it('多词可分布在不同字段', () => {
    inTop('Blender 布朗', '萤火虫', 3);
    inTop('github 中断', '拉取中断', 3);
  });

  it('查不着全部词时宁可不给，也不给错', () => {
    // 「泡菜」与「Swap」在语料里分属两篇；严格要求两个词都在同一节点 → 无命中
    expect(searchDocs(DOCS, parseQuery(['泡菜', 'Swap']), NO_OWNER).hits).toHaveLength(0);
  });

  it('name: 只看名字，desc: 只看描述', () => {
    // 「降噪」只出现在麦克风那篇的 name 与 content 里
    inTop('name:降噪', '麦克风降噪', 1);
    // 「惰性抓取」只在 GitHub 那篇的 description 里
    inTop('desc:惰性抓取', '拉取中断', 1);
    // 「fstab」只出现在 Swap 那篇的**正文**里 → 描述限定不该命中它
    expect(rankOf('desc:fstab', 'Swap')).toBe(-1);
    // 反过来，正文限定能命中
    inTop('content:fstab', 'Swap', 1);
  });
});

describe('召回质量：declared flows（P0-3 的回归）', () => {
  it('按产出物搜得到声明它的那一步', () => {
    inTop('飞舞的萤火虫群', '萤火虫', 1);
    inTop('SRT 字幕文件', '批量下载字幕', 1);
    inTop('浅克隆的本地仓库', '浅克隆仓库', 1);
    inTop('可用的录音素材', '麦克风降噪', 1);
  });

  it('按依赖（inputs）也搜得到', () => {
    inTop('可用的 yt-dlp', '整季下载', 2);
  });
});

describe('召回质量：中文 bigram 与放宽', () => {
  it('不看词序，两字以上的片段都能召回', () => {
    inTop('字幕下载', '批量下载字幕', 2);
    inTop('降噪麦克风', '麦克风降噪', 2);
  });

  it('完全不相干的查询一条都不给', () => {
    expect(searchDocs(DOCS, parseQuery(['量子纠缠']), NO_OWNER).hits).toHaveLength(0);
    expect(searchDocs(DOCS, parseQuery(['zzzz']), NO_OWNER).hits).toHaveLength(0);
  });

  it('放宽档：过半的多字 token 命中才放宽，且把结果标成 partial', () => {
    // 三个词里对两个（Blender 那篇与泡菜无关）→ 放宽
    const relaxed = searchDocs(DOCS, parseQuery(['泡菜', '发酵', 'Blender']), NO_OWNER);
    expect(relaxed.mode).toBe('or');
    expect(relaxed.hits[0].hash).toBeDefined();
  });

  it('查询里混进语料根本没有的词时**不放宽**——别让一个词撑起整条查询', () => {
    // gate 的分母是查询自身的多字 token（含 zzzz/absent 这种哪里都匹配不到的），
    // 所以「泡菜 zzzz-absent」够不到严格过半 → 宁可给空
    expect(searchDocs(DOCS, parseQuery(['泡菜', 'zzzz-absent']), NO_OWNER).hits).toHaveLength(0);
    expect(searchDocs(DOCS, parseQuery(['泡菜', '发酵', 'zzzz-absent']), NO_OWNER).hits).toHaveLength(0);
  });
});

describe('召回质量：稳定性', () => {
  it('同一查询两次结果完全一致（排序是全序）', () => {
    for (const q of ['克隆', 'Blender 粒子', '字幕 下载', 'name:yt-dlp']) {
      const a = searchDocs(DOCS, parseQuery(q.split(' ')), NO_OWNER).hits.map((h) => h.hash);
      const b = searchDocs(DOCS, parseQuery(q.split(' ')), NO_OWNER).hits.map((h) => h.hash);
      expect(a).toEqual(b);
    }
  });

  it('语料顺序不影响结果（索引按哈希排序，与传入顺序无关）', () => {
    const reversed = [...DOCS].reverse();
    const q = parseQuery(['克隆']);
    const a = searchDocs(DOCS, q, NO_OWNER).hits.map((h) => h.hash).sort();
    const b = searchDocs(reversed, q, NO_OWNER).hits.map((h) => h.hash).sort();
    expect(a).toEqual(b);
  });
});
