import fs from 'node:fs';

/**
 * BERT WordPiece 分词（纯 JS，零依赖）。
 *
 * 为什么自己写而不是引 transformers.js：这个模型（bge-small-zh-v1.5）的词表是
 * **WordPiece 纯文本 vocab.txt**（21128 词），比引一整套运行时便宜得多，也让
 * 「分词是否正确」变成一个可以用 token id 逐位对账的问题，而不是黑盒。
 *
 * 与 HF `BertTokenizer` 的等价性已用对账夹具验证：6 段中英混合文本 **token id 完全相同**
 * （含 [UNK] 行为、CJK 逐字切分、`##` 续接、标点单独成词）。见 tests/embed.test.ts。
 */

const PUNCT_ASCII = new Set<number>();
for (const [a, b] of [[33, 47], [58, 64], [91, 96], [123, 126]]) {
  for (let c = a; c <= b; c++) PUNCT_ASCII.add(c);
}

function isPunct(cp: number): boolean {
  if (cp < 128) return PUNCT_ASCII.has(cp);
  return /\p{P}/u.test(String.fromCodePoint(cp));
}

/** HF BertTokenizer 认作「中文字符」的区段（tokenize_chinese_chars） */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x4e00, 0x9fff], [0x3400, 0x4dbf], [0x20000, 0x2a6df], [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f], [0x2b820, 0x2ceaf], [0xf900, 0xfaff], [0x2f800, 0x2fa1f],
];

function isCjk(cp: number): boolean {
  return CJK_RANGES.some(([a, b]) => cp >= a && cp <= b);
}

/** 去掉控制字符与 U+FFFD，把 \t\n\r 归一成空格（HF _clean_text） */
function cleanText(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd) continue;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) { out += ' '; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

export const CLS_TOKEN = '[CLS]';
export const SEP_TOKEN = '[SEP]';
export const UNK_TOKEN = '[UNK]';

export interface TokenizerOptions {
  /** 位置编码上限；必须留出 [CLS] 与 [SEP] 两个位置 */
  maxLength?: number;
  /** 这些模型是 do_lower_case=false（中文 BERT 的惯例），默认不折叠大小写 */
  lowerCase?: boolean;
}

export class BertWordPieceTokenizer {
  readonly vocab: Map<string, number>;
  private readonly maxLength: number;
  private readonly lowerCase: boolean;
  private readonly clsId: number;
  private readonly sepId: number;
  private readonly unkId: number;
  /** 词表里最长的 token 长度，用来给贪心匹配封顶（省掉无谓的短串查找） */
  private readonly maxTokenChars: number;

  constructor(vocab: Map<string, number>, opts: TokenizerOptions = {}) {
    this.vocab = vocab;
    this.maxLength = opts.maxLength ?? 512;
    this.lowerCase = opts.lowerCase === true;
    this.clsId = vocab.get(CLS_TOKEN) ?? 101;
    this.sepId = vocab.get(SEP_TOKEN) ?? 102;
    this.unkId = vocab.get(UNK_TOKEN) ?? 100;
    let longest = 1;
    for (const t of vocab.keys()) {
      const n = [...t].length;
      if (n > longest) longest = n;
    }
    this.maxTokenChars = longest;
  }

  static fromVocabText(text: string, opts: TokenizerOptions = {}): BertWordPieceTokenizer {
    const vocab = new Map<string, number>();
    text.split('\n').forEach((raw, i) => {
      const t = raw.replace(/\r$/, '');
      if (t !== '' && !vocab.has(t)) vocab.set(t, i);
    });
    return new BertWordPieceTokenizer(vocab, opts);
  }

  static fromVocabFile(file: string, opts: TokenizerOptions = {}): BertWordPieceTokenizer {
    return BertWordPieceTokenizer.fromVocabText(fs.readFileSync(file, 'utf8'), opts);
  }

  /** 基础切分：CJK 逐字加空格 → 按空白切 → 标点单独成词 */
  private basicTokens(text: string): string[] {
    let spaced = '';
    for (const ch of (this.lowerCase ? text.toLowerCase() : text)) {
      spaced += isCjk(ch.codePointAt(0)!) ? ` ${ch} ` : ch;
    }
    const out: string[] = [];
    for (const token of cleanText(spaced).split(/\s+/)) {
      if (token === '') continue;
      let startNew = true;
      for (const ch of token) {
        if (isPunct(ch.codePointAt(0)!)) {
          out.push(ch);
          startNew = true;
        } else {
          if (startNew) out.push('');
          startNew = false;
          out[out.length - 1] += ch;
        }
      }
    }
    return out.filter((s) => s !== '');
  }

  /** 贪心最长匹配，续接加 `##`；整词无解 → [UNK] */
  private wordPiece(token: string): number[] {
    const chars = [...token];
    if (chars.length > 100) return [this.unkId];
    const ids: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let hit: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        const id = this.vocab.get(sub);
        if (id !== undefined) { hit = id; break; }
        end--;
      }
      if (hit === undefined) return [this.unkId];
      ids.push(hit);
      start = end;
    }
    return ids;
  }

  /** 文本 → token id（含 [CLS]/[SEP]，按 maxLength 截断） */
  encode(text: string): number[] {
    const limit = this.maxLength - 1; // 给结尾的 [SEP] 留位
    const ids: number[] = [this.clsId];
    for (const token of this.basicTokens(text)) {
      const pieces = this.wordPiece(token);
      for (const p of pieces) {
        ids.push(p);
        if (ids.length >= limit) break;
      }
      if (ids.length >= limit) break;
    }
    if (ids.length > limit) ids.length = limit;
    ids.push(this.sepId);
    return ids;
  }

  encodeBatch(texts: readonly string[]): number[][] {
    return texts.map((t) => this.encode(t));
  }

  /** 整批 padding 成等宽（返回 int64 视图所需的普通数组，交给调用方装箱） */
  padBatch(encoded: readonly number[][]): { ids: number[][]; mask: number[][] } {
    const width = encoded.reduce((m, e) => Math.max(m, e.length), 0);
    const ids = encoded.map((e) => {
      const row = new Array<number>(width).fill(0);
      for (let i = 0; i < e.length; i++) row[i] = e[i];
      return row;
    });
    const mask = encoded.map((e) => {
      const row = new Array<number>(width).fill(0);
      for (let i = 0; i < e.length; i++) row[i] = 1;
      return row;
    });
    return { ids, mask };
  }

  /** 这个 token 是否真的在词表里（诊断用：查 OOV 率） */
  has(token: string): boolean {
    return this.vocab.has(token);
  }

  get longestTokenChars(): number {
    return this.maxTokenChars;
  }
}
