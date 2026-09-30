import type { PNode } from '@arshdelight/pop-sdk';

/**
 * 本地检索内核（纯词法、零依赖、确定性）。
 *
 * 三条不变量：
 *  1. **索引文本是检索期派生的**——只影响召回，绝不写回节点，也绝不进入
 *     computeNodeHash（内容寻址不可破坏）。hub 侧同款索引见 pop-spec §9.1。
 *  2. **中文不分词**：切相邻两字 bigram（外加单字）。标点与换行天然切断，
 *     不需要词典，也就没有词典带来的版本漂移。bigram 全中 ≈ 短语命中，
 *     但允许两字分开出现，比子串匹配**严格更宽**。
 *  3. **确定的全序**：score ↓ → direct 优先 → 树内深度浅优先 → hash 升序。
 *     同输入两次运行结果完全一致（可达性与 Map 迭代序都由排序后的输入决定）。
 */

/* ───────────────────────── 字段 ───────────────────────── */

export type FieldName = 'name' | 'description' | 'flow' | 'note' | 'loop' | 'op' | 'content' | 'hash';

/** 展示顺序 = 权重降序：命中解释里最相关的字段排最前 */
export const FIELD_ORDER: readonly FieldName[] = [
  'name', 'description', 'flow', 'note', 'loop', 'op', 'content', 'hash',
];

/**
 * 字段权重（BM25 词频乘子）。标题优先是规格要求（pop-spec §9.1 title hits
 * rank first）；声明流紧随其后——「哪一步产出 boiling water」「谁需要 pH 7.4
 * 的缓冲液」这类按产出物/依赖检索完全靠它。hash 权重 0：它走前缀命中 + 分层加分。
 */
export const FIELD_WEIGHT: Record<FieldName, number> = {
  name: 8,
  description: 4,
  flow: 3,
  note: 3,
  loop: 2,
  op: 1,
  content: 1,
  hash: 0,
};

const FIELD_BIT = (() => {
  const m = {} as Record<FieldName, number>;
  FIELD_ORDER.forEach((f, i) => { m[f] = 1 << i; });
  return m;
})();

/* ───────────────────────── 分词 ───────────────────────── */

function isCJK(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||   // 假名
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 基本区
    (cp >= 0xf900 && cp <= 0xfaff) ||   // 兼容表意文字
    (cp >= 0xac00 && cp <= 0xd7af) ||   // 谚文
    (cp >= 0x20000 && cp <= 0x2fa1f)    // 扩展 B 及以上
  );
}

/** 拉丁词内部的合法字符：字母数字，以及 _ - . + #（`user-data-dir`、`bge-m3`、`c++`） */
function isTokenChar(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    cp === 0x5f || cp === 0x2d || cp === 0x2e || cp === 0x2b || cp === 0x23
  );
}

const TRIM_CHARS = new Set(['-', '.', '_', '+', '#']);

/**
 * 分词：CJK 出单字 + 相邻 bigram；拉丁出整串，并在含分隔符时补发各片段
 * （`user-data-dir` → `user-data-dir` + `user`/`data`/`dir`），兼顾精确与召回。
 * 查询与文档走同一函数，保证切法对称。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cjkRun: string[] = [];
  let latinRun = '';

  const flushCjk = (): void => {
    if (cjkRun.length === 0) return;
    for (const ch of cjkRun) out.push(ch);
    for (let i = 0; i + 1 < cjkRun.length; i++) out.push(cjkRun[i] + cjkRun[i + 1]);
    cjkRun = [];
  };
  const flushLatin = (): void => {
    if (latinRun === '') return;
    let s = latinRun;
    let a = 0;
    let b = s.length;
    while (a < b && TRIM_CHARS.has(s[a])) a++;
    while (b > a && TRIM_CHARS.has(s[b - 1])) b--;
    s = s.slice(a, b);
    if (s !== '') {
      out.push(s);
      if (s.length > 2) {
        for (const part of s.split(/[-._+#]+/)) {
          if (part.length >= 2 && part !== s) out.push(part);
        }
      }
    }
    latinRun = '';
  };

  for (const ch of text.toLowerCase()) {
    const cp = ch.codePointAt(0)!;
    if (isCJK(cp)) {
      flushLatin();
      cjkRun.push(ch);
    } else if (isTokenChar(cp)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  return out;
}

/* ───────────────────────── 查询 ───────────────────────── */

const FIELD_ALIAS: Record<string, FieldName> = {
  name: 'name', title: 'name',
  desc: 'description', description: 'description', about: 'description',
  content: 'content', body: 'content',
  note: 'note', notes: 'note',
  flow: 'flow', io: 'flow', input: 'flow', inputs: 'flow', output: 'flow', outputs: 'flow',
  loop: 'loop', op: 'op',
  hash: 'hash',
};

export interface QueryWord {
  /** 用户原样输入的这个词（做整串包含判断时用） */
  raw: string;
  /** 该词切出的全部 token；全部命中才算这个词命中（词内 AND） */
  tokens: string[];
  /** 字段限定（`name:foo`）；无限定则不限定 */
  field?: FieldName;
}

export interface Query {
  raw: string;
  words: QueryWord[];
  /** 纯 hex 查询（≥4 位）额外按哈希前缀召回 */
  hashPrefix?: string;
}

/**
 * 解析查询词。语义（help 文本同步说明）：
 *  - 多词 = **AND**：每个词都要命中，但可分布在不同字段（不再拼成一个整串）；
 *  - `field:value` 限定字段，支持 name/desc/content/note/flow/loop/op/hash 及其别名；
 *  - 单词查询行为与旧版一致；纯 hex 仍走哈希前缀。
 */
export function parseQuery(input: string[]): Query {
  const raw = input.join(' ').trim();
  const words: QueryWord[] = [];
  let hashPrefix: string | undefined;

  for (const w of input) {
    if (w === '') continue;
    const m = /^([A-Za-z]+):(.*)$/.exec(w);
    const alias = m === null ? undefined : FIELD_ALIAS[m[1].toLowerCase()];
    if (m !== null && alias !== undefined && m[2] !== '') {
      if (alias === 'hash') {
        if (/^[0-9a-fA-F]{4,64}$/.test(m[2])) hashPrefix = m[2].toLowerCase();
        continue;
      }
      words.push({ raw: m[2], tokens: tokenize(m[2]), field: alias });
      continue;
    }
    words.push({ raw: w, tokens: tokenize(w) });
  }

  // 纯 hex 且未加字段限定时，额外按哈希前缀召回（与文本匹配并存，不互斥）
  if (hashPrefix === undefined && /^[0-9a-fA-F]{4,64}$/.test(raw)) hashPrefix = raw.toLowerCase();
  return { raw, words, ...(hashPrefix !== undefined ? { hashPrefix } : {}) };
}

/* ───────────────────────── 索引 ───────────────────────── */

export interface DocEntry {
  hash: string;
  name: string;
  /** 各字段的索引文本；缺省字段不参与索引 */
  fields: Partial<Record<FieldName, string>>;
}

interface Posting {
  doc: number;
  /** 字段加权词频：Σ 字段权重 × 该字段出现次数 */
  wtf: number;
  /** 命中字段位图（FieldName → bit） */
  mask: number;
}

export interface Index {
  n: number;
  postings: Map<string, Posting[]>;
  /** 每篇文档的字段加权长度 */
  dl: Float64Array;
  avgdl: number;
}

/**
 * 从节点抽取索引文本。**派生数据**：不写回节点、不进哈希。
 * 规格要求索引纳入 declared inputs/outputs（pop-spec §9.1：index text derived by
 * §7 aggregation, including declared inputs/outputs）——CLI 侧过去缺这一块，
 * 于是「谁产出 boiling water」永远搜不到。loop 的 until 散文与 op 值同理纳入。
 */
export function nodeIndexFields(hash: string, node: PNode, note?: string): DocEntry {
  const fields: Partial<Record<FieldName, string>> = { name: node.name };
  if (node.description !== undefined && node.description !== '') fields.description = node.description;
  if (node.content !== '') fields.content = node.content;

  if (node.type === 'action') {
    const flows = [...(node.inputs ?? []), ...(node.outputs ?? [])]
      .map((f) => (f.spec !== undefined && f.spec !== '' ? `${f.name} ${f.spec}` : f.name));
    if (flows.length > 0) fields.flow = flows.join('\n');
  } else {
    fields.op = node.op;
    const loop = node.loop;
    if (loop !== undefined) {
      fields.loop = loop.mode === 'until'
        ? `until ${loop.until}`
        : `count ${loop.count} 重复 ${loop.count} 次`;
    }
  }
  if (note !== undefined && note !== '') fields.note = note;
  return { hash, name: node.name, fields };
}

const K1 = 1.2;
const B = 0.75;

/** 子树哈希闭包（沿 children；用于 similar 排除目标自身与其后代） */
export function subtreeHashes(rootHash: string, nodes: Map<string, PNode>): Set<string> {
  const seen = new Set<string>();
  const stack = [rootHash];
  while (stack.length > 0) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    seen.add(h);
    const n = nodes.get(h);
    if (n?.type === 'practice') for (const c of n.children) stack.push(c.hash);
  }
  return seen;
}

/**
 * 子树聚合索引文本（检索期派生）：practice 的「内容」其实是整棵树——根节点常常
 * 只有一句话，真正的信息在步骤里。similar 以它为目标文本，才能回答「这棵树在讲
 * 什么，还有哪些节点像它」。`name` 仍是根的名字（给人看），字段文本是聚合的。
 */
export function subtreeIndexFields(rootHash: string, nodes: Map<string, PNode>, note?: string): DocEntry {
  const parts: Record<FieldName, string[]> = {
    name: [], description: [], flow: [], note: [], loop: [], op: [], content: [], hash: [],
  };
  const seen = new Set<string>();
  const stack = [rootHash];
  let rootName = rootHash;
  while (stack.length > 0) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    seen.add(h);
    const n = nodes.get(h);
    if (n === undefined) continue;
    if (h === rootHash) rootName = n.name;
    const e = nodeIndexFields(h, n);
    for (const f of FIELD_ORDER) {
      const text = e.fields[f];
      if (text !== undefined && text !== '') parts[f].push(text);
    }
    if (n.type === 'practice') for (const c of n.children) stack.push(c.hash);
  }
  const fields: Partial<Record<FieldName, string>> = {};
  for (const f of FIELD_ORDER) {
    if (parts[f].length > 0) fields[f] = parts[f].join('\n');
  }
  if (note !== undefined && note !== '') {
    fields.note = fields.note === undefined ? note : `${fields.note}\n${note}`;
  }
  return { hash: rootHash, name: rootName, fields };
}
export function buildIndex(docs: DocEntry[]): Index {
  const postings = new Map<string, Posting[]>();
  const dl = new Float64Array(docs.length);
  let total = 0;

  for (let doc = 0; doc < docs.length; doc++) {
    const per = new Map<string, { wtf: number; mask: number }>();
    let len = 0;
    for (const f of FIELD_ORDER) {
      const w = FIELD_WEIGHT[f];
      if (w === 0) continue; // hash 不参与 BM25（走前缀命中）
      const text = docs[doc].fields[f];
      if (text === undefined || text === '') continue;
      const toks = tokenize(text);
      len += w * toks.length;
      const bit = FIELD_BIT[f];
      for (const t of toks) {
        const cur = per.get(t);
        if (cur === undefined) per.set(t, { wtf: w, mask: bit });
        else {
          cur.wtf += w;
          cur.mask |= bit;
        }
      }
    }
    dl[doc] = len;
    total += len;
    // 逐篇推进 → 每个 token 的 postings 天然按 doc 升序，无需再排
    for (const [t, v] of per) {
      const list = postings.get(t);
      const p: Posting = { doc, wtf: v.wtf, mask: v.mask };
      if (list === undefined) postings.set(t, [p]);
      else list.push(p);
    }
  }

  return { n: docs.length, postings, dl, avgdl: docs.length > 0 ? total / docs.length : 0 };
}

/* ───────────────────────── 打分与排序 ───────────────────────── */

/**
 * 分层加分（title-first，规格 pop-spec §9.1）。
 *
 * 字段分层按「多可信」排：名字 > 摘要 > 声明流 > 笔记 > 正文 > loop/op。
 * 同一字段内再分两档：**整串出现在该字段** 强于 **各 token 散落该字段**——中文
 * 单字 token 极易散落命中（查「断点续传」时「拉取中断」里的「断」），若不区分，
 * 一个偶然的单字就会把 name 档点亮，压过真正整串命中摘要的记录。
 * 降档惩罚固定，保证全序且可解释。
 */
const FIELD_TIER: Record<FieldName, number> = {
  name: 1000, description: 300, flow: 150, note: 120, content: 60, loop: 40, op: 30, hash: 0,
};
/** 评估顺序 = 分层降序；高档位短路，避免为每篇候选取 token 集 */
const TIER_ORDER: readonly FieldName[] = ['name', 'description', 'flow', 'note', 'content', 'loop', 'op'];
const LOOSE_PENALTY = 150;
const NAME_EXACT = 2000;

/** 其余加分：direct 根更可能被当成入口；哈希前缀命中另算 */
const BONUS = {
  hashPrefix: 300,
  directRoot: 25,
} as const;

export interface SearchOptions {
  directSet: ReadonlySet<string>;
  /** 树内深度（direct 根 = 0）；不可达节点不入表 */
  depthOf: ReadonlyMap<string, number>;
}

export interface ScoredDoc {
  hash: string;
  score: number;
  matchedIn: FieldName[];
  direct: boolean;
  /** 不可达节点为 Number.MAX_SAFE_INTEGER（排序垫底，JSON 里省略） */
  depth: number;
}

export interface SearchResult {
  hits: ScoredDoc[];
  /** and = 每个词都命中；or = 放宽后（原 AND 零命中时按多数词匹配）的结果 */
  mode: 'and' | 'or';
}

function bitsToFields(mask: number): FieldName[] {
  return FIELD_ORDER.filter((f) => (mask & FIELD_BIT[f]) !== 0);
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** 参与 AND 判定的查询词（token 为空的词——纯标点——不参与） */
interface EffectiveWord {
  wi: number;
  tokens: string[];
  raw: string;
  field?: FieldName;
}

/** 分层加分：整串命中某字段 > 各 token 散落该字段；字段之间按可信度降序 */
function tierBonus(d: DocEntry, query: Query, effective: EffectiveWord[]): number {
  if (effective.length === 0) return 0;
  let tier = 0;
  if (effective.length === 1 && effective[0].field === undefined
    && d.name.toLowerCase() === query.raw.toLowerCase()) {
    tier = NAME_EXACT;
  }
  for (const f of TIER_ORDER) {
    // 低档位即使整串命中（FIELD_TIER[f]）也追不上当前分 → 后面的更追不上，收工
    if (FIELD_TIER[f] - LOOSE_PENALTY <= tier) break;
    const text = d.fields[f];
    if (text === undefined || text === '') continue;
    const applies = (w: EffectiveWord): boolean => w.field === undefined || w.field === f;
    if (!effective.some(applies)) continue;
    const lower = text.toLowerCase();
    if (effective.every((w) => applies(w) && lower.includes(w.raw.toLowerCase()))) {
      tier = Math.max(tier, FIELD_TIER[f]);
      continue;
    }
    const toks = new Set(tokenize(text));
    if (effective.every((w) => applies(w) && w.tokens.every((t) => toks.has(t)))) {
      tier = Math.max(tier, FIELD_TIER[f] - LOOSE_PENALTY);
    }
  }
  return tier;
}

/**
 * 召回 + 打分 + 排序。严格档（每个词的每个 token 都命中）零命中时，退到**严格多数
 * 多字 token** 命中一档，并在输出里逐行标记为 partial——个人语料里「词序记反」比
 * 「拼错词」常见，但放宽必须看得出来，否则会被当成答案（见下面放宽档的实测教训）。
 */
export function searchDocs(docs: DocEntry[], query: Query, opts: SearchOptions): SearchResult {
  const index = buildIndex(docs);
  const acc = new Map<number, { bm25: number; mask: number; tokens: Set<string>; words: Set<number> }>();
  const avgdl = index.avgdl > 0 ? index.avgdl : 1;

  const touch = (doc: number) => {
    let cur = acc.get(doc);
    if (cur === undefined) {
      cur = { bm25: 0, mask: 0, tokens: new Set(), words: new Set() };
      acc.set(doc, cur);
    }
    return cur;
  };

  query.words.forEach((word, wi) => {
    for (const t of new Set(word.tokens)) {
      const list = index.postings.get(t);
      if (list === undefined) continue;
      const df = list.length;
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      for (const p of list) {
        let wtf = p.wtf;
        let mask = p.mask;
        if (word.field !== undefined) {
          const bit = FIELD_BIT[word.field];
          if ((mask & bit) === 0) continue;
          // 字段限定：用该字段自身的词频近似（wtf 是跨字段加权和，除以权重即该字段词频的上界）
          wtf = wtf / FIELD_WEIGHT[word.field];
          mask = bit;
        }
        const cur = touch(p.doc);
        const norm = wtf + K1 * (1 - B + (B * index.dl[p.doc]) / avgdl);
        cur.bm25 += (idf * (wtf * (K1 + 1))) / norm;
        cur.mask |= mask;
        cur.tokens.add(t);
        cur.words.add(wi);
      }
    }
  });

  // 哈希前缀命中：与文本命中并存（同一节点可能两者都中）
  const hashHits = new Set<number>();
  if (query.hashPrefix !== undefined) {
    const p = query.hashPrefix;
    docs.forEach((d, i) => {
      if (d.hash.slice('sha256:'.length).startsWith(p)) {
        hashHits.add(i);
        const cur = touch(i);
        cur.mask |= FIELD_BIT.hash;
      }
    });
  }

  // 词级 AND：一个词的全部 token 都命中，这个词才算命中
  const effective: EffectiveWord[] = query.words
    .map((w, wi) => ({ wi, tokens: w.tokens, raw: w.raw, ...(w.field !== undefined ? { field: w.field } : {}) }))
    .filter((w) => w.tokens.length > 0);
  /** 去重后的全部查询 token（严格档要求每个词的 token 全中） */
  const allTokens = [...new Set(effective.flatMap((w) => w.tokens))];
  /** 放宽档的计数池：只用多字 token（bigram / 拉丁词）——单字不算召回闸门 */
  const gate = allTokens.filter((t) => t.length >= SIM_MIN_LEN);

  const finish = (accept: (matchedWords: EffectiveWord[], matchedTokens: number, gateHits: number) => boolean): ScoredDoc[] => {
    const out: ScoredDoc[] = [];
    for (const [doc, cur] of acc) {
      const matchedWords = effective.filter((w) => w.tokens.every((t) => cur.tokens.has(t)));
      const matchedTokens = allTokens.reduce((n, t) => n + (cur.tokens.has(t) ? 1 : 0), 0);
      // 放宽档的计数只算多字 token（单字太容易散落共享，凑得出假多数）
      const gateHits = gate.reduce((n, t) => n + (cur.tokens.has(t) ? 1 : 0), 0);
      // 哈希前缀是**地址**而非过滤条件：命中即入选，不被文本词的 AND 门挡住
      // （纯 hex 查询词切出的 token 通常一个文档都不含，否则 `practi search <hex>` 永远零命中）
      const ok = hashHits.has(doc) || (effective.length > 0 && accept(matchedWords, matchedTokens, gateHits));
      if (!ok) continue;

      // 分层加分只在候选上算（按需分词，不占索引内存）
      const d = docs[doc];
      const tier = tierBonus(d, query, effective);

      const direct = opts.directSet.has(d.hash);
      const score = cur.bm25
        + tier
        + (hashHits.has(doc) ? BONUS.hashPrefix : 0)
        + (direct ? BONUS.directRoot : 0);

      out.push({
        hash: d.hash,
        score: round4(score),
        matchedIn: bitsToFields(cur.mask),
        direct,
        depth: opts.depthOf.get(d.hash) ?? Number.MAX_SAFE_INTEGER,
      });
    }
    return out;
  };

  const byRank = (a: ScoredDoc, b: ScoredDoc): number =>
    b.score - a.score
    || (a.direct === b.direct ? 0 : a.direct ? -1 : 1)
    || a.depth - b.depth
    || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

  const strict = finish((mw) => mw.length === effective.length).sort(byRank);
  // 严格档有结果就直接用；哈希命中已入选时同理不再放宽（放宽只会引入噪声）
  if (strict.length > 0 || hashHits.size > 0) return { hits: strict, mode: 'and' };

  /**
   * 放宽只有一档，而且是**严格多数 token** 命中——不是「命中多数词」。
   *
   * 实测教训：原来那档「多数词命中」对两个词的查询退化成 OR，于是
   * 「科学上网」（语料里写的是翻墙/代理/节点）把「品牌静帧微动动画」排到了第一，
   * 还带着 `← name, description · score 52` 的权威外观。**自信的错误比没有结果更糟**：
   * 用户会照着它去 show 一个完全无关的节点。
   *
   * 保留这一档是因为它确实救得回一类中文查询：词序颠倒（查「配置目录」，正文写
   * 「目录配置」）——bigram 共享 配置/目录 等，过半即可命中。多数门要求严格过半，
   * 噪声词再也凑不出来。
   *
   * 计数只算**多字 token**（bigram 与拉丁词）：中文单字太容易散落共享，把
   * 配/置/目/录 这类单字算进门里，一条只写着「配置」和「目录」（两处无关）的记录
   * 也能凑够半数。单字仍留在索引里参与打分，只是不当召回闸门。
   */
  const strictMajority = Math.floor(gate.length / 2) + 1;
  if (effective.length > 0 && gate.length >= 2) {
    const relaxed = finish((_mw, tok, gateHits) => gateHits >= strictMajority).sort(byRank);
    if (relaxed.length > 0) return { hits: relaxed, mode: 'or' };
  }
  return { hits: [], mode: 'and' };
}

/* ───────────────────────── 融合排序 ───────────────────────── */

/**
 * 倒数排名融合（RRF）：每个榜单按名次贡献 1/(k+rank)，k=60（文献里的常用值）。
 *
 * 用**名次**而不是分数，是因为 BM25 与余弦的量纲根本不可比：任何线性加权都要先
 * 各自归一化，而归一化会引入各自的偏差（BM25 的分布随查询词数变化，余弦的分布
 * 随模型变化）。RRF 只用名次，天然免疫，也没有需要调的权重。
 *
 * 全序：融合分降序 → 单榜最好名次升序 → hash 升序。
 */
export function fuseRankings(lists: readonly (readonly string[])[], k = 60): string[] {
  const score = new Map<string, number>();
  const best = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hash, i) => {
      score.set(hash, (score.get(hash) ?? 0) + 1 / (k + i + 1));
      const b = best.get(hash);
      if (b === undefined || i < b) best.set(hash, i);
    });
  }
  return [...score.keys()].sort((a, b) =>
    (score.get(b)! - score.get(a)!)
    || ((best.get(a) ?? 0) - (best.get(b) ?? 0))
    || (a < b ? -1 : a > b ? 1 : 0));
}

/* ───────────────────────── 近邻（similar） ───────────────────────── */

/**
 * 相似度只用**长度 ≥2 的 token**：中文单字在任意两篇中文文档间都大量共享
 * （「的」「是」「中」…），把它们算进来只会制造噪声；bigram 才是中文的最小
 * 有义单位。拉丁词本身就是 ≥2 的 token。
 */
const SIM_MIN_LEN = 2;

export interface SimilarHit {
  hash: string;
  /** 相对目标自身得分的比例（1.0 = 内容完全相同），4 位小数 */
  score: number;
  /** 贡献最大的共享 token（按对得分的实际贡献降序），给人判断「像在哪」 */
  shared: string[];
}

/**
 * 共享 token 取样：按**对点积的实际贡献**降序，而不是按 idf 降序。
 * 只看 idf 会挑出最罕见的 bigram——它们往往是跨词边界的碎片（「时封」「续猛」），
 * 看着像噪声；贡献值把词频也算进来，浮出来的才是真正把两条记录拉到一起的词。
 */
function topShared(contrib: Map<string, number>, n = 5): string[] {
  return [...contrib.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([term]) => term);
}

/**
 * 按内容找近邻：把**目标节点的内容当成一次查询**，对语料里每个节点做 BM25，
 * 再除以目标对自身的得分归一化（1.0 = 内容完全相同，越大越像）。
 *
 * 为什么不是余弦：余弦按文档长度归一化，于是「换个说法的长文」会被大量非共享词
 * 稀释，反倒是「只共享一个罕见词的短文」分数更高（实测把近乎无关的一条排到了
 * 近义记录前面）。BM25 按词的**存在与否**给分、长度归一很轻，正是这里要的行为。
 * 分数天然不对称——这是查询，不是距离度量，也正是它的用处。
 *
 * 边界：纯字面近邻（字符 bigram + 拉丁词），**不做语义理解**；零依赖、确定性。
 *
 * @param exclude 目标自身与其后代（它们本来就在目标的聚合文本里，必然满分）
 */
export function similarDocs(
  docs: DocEntry[],
  target: DocEntry,
  exclude: ReadonlySet<string>,
  limit: number,
): SimilarHit[] {
  const index = buildIndex(docs);
  const idf = new Map<string, number>();
  for (const [term, list] of index.postings) {
    if (term.length < SIM_MIN_LEN) continue;
    idf.set(term, Math.log(1 + (index.n - list.length + 0.5) / (list.length + 0.5)));
  }

  // 目标向量（字段加权词频）与目标长度
  const tf = new Map<string, number>();
  let targetLen = 0;
  for (const f of FIELD_ORDER) {
    const fw = FIELD_WEIGHT[f];
    if (fw === 0) continue;
    const text = target.fields[f];
    if (text === undefined || text === '') continue;
    let n = 0;
    for (const t of tokenize(text)) {
      n++;
      if (t.length < SIM_MIN_LEN) continue;
      tf.set(t, (tf.get(t) ?? 0) + fw);
    }
    targetLen += fw * n;
  }

  const avgdl = index.avgdl > 0 ? index.avgdl : 1;
  const termScore = (wtf: number, dl: number, w: number): number =>
    (w * (wtf * (K1 + 1))) / (wtf + K1 * (1 - B + (B * dl) / avgdl));

  // 目标对自身的得分 = 上界（1.0）
  let self = 0;
  for (const [term, freq] of tf) {
    const w = idf.get(term);
    if (w === undefined) continue; // 语料里没有这个词：不参与（否则会虚增上界）
    self += termScore(freq, targetLen, w);
  }
  if (self === 0) return [];

  const score = new Map<number, number>();
  /** doc → (token → 该 token 对这条得分的贡献)，供取样「像在哪」 */
  const contrib = new Map<number, Map<string, number>>();
  for (const term of tf.keys()) {
    const w = idf.get(term);
    if (w === undefined) continue;
    for (const p of index.postings.get(term)!) {
      const c = termScore(p.wtf, index.dl[p.doc], w);
      score.set(p.doc, (score.get(p.doc) ?? 0) + c);
      let perDoc = contrib.get(p.doc);
      if (perDoc === undefined) {
        perDoc = new Map<string, number>();
        contrib.set(p.doc, perDoc);
      }
      perDoc.set(term, c);
    }
  }

  const out: SimilarHit[] = [];
  for (const [doc, d] of score) {
    const h = docs[doc].hash;
    if (exclude.has(h)) continue;
    const sim = d / self;
    if (sim <= 0) continue;
    out.push({ hash: h, score: round4(sim), shared: topShared(contrib.get(doc) ?? new Map()) });
  }
  // 全序：分数降序 → hash 升序（同分也不受迭代顺序影响）
  out.sort((a, b) => (b.score - a.score) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out.slice(0, limit);
}
