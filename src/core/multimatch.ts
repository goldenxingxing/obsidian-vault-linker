/**
 * multimatch.ts — 一次扫描找出一篇文档命中的全部实体（Aho-Corasick）
 *
 * 为什么需要：逐个实体跑正则是「实体数 × 文档数」次全文扫描。零配置下每篇笔记的标题都是
 * 实体，两者都随 vault 增长，3160 篇时仅这一步就要 79 秒，还跑在 Obsidian 主线程上。
 * 这里把全部实体编进一个自动机，每篇文档只扫一遍。
 *
 * 结果必须与 entities.ts 的逐个正则**完全一致**（单测逐例对照）：
 *   - 大小写不敏感的实体：按 JS 正则 `i` 标志（非 unicode 模式）的 Canonicalize 规则逐个
 *     UTF-16 码元折叠文本与实体——与正则引擎的比较方式相同，而且折叠前后长度不变，
 *     命中位置可以直接回到原文检查词边界
 *   - 词边界：命中前后一个码元不是 [A-Za-z0-9_]（与 lookbehind/lookahead 相同；`i` 标志下
 *     这个字符类不会多匹配任何字符，见 canon 的第二条规则）
 *   - 一个实体只要有一处命中满足边界就算命中（和 RegExp.test 一样）
 */

import type { EntityMatcher } from "./entities.ts";

/**
 * ECMAScript 非 unicode 模式下 ignoreCase 的 Canonicalize：
 * 转大写后不是单个码元、或会把非 ASCII 映射成 ASCII（如 ſ→S）的，保持原样。
 */
function canon(code: number): number {
  const ch = String.fromCharCode(code);
  const u = ch.toUpperCase();
  if (u.length !== 1) return code;
  const cu = u.charCodeAt(0);
  if (code >= 128 && cu < 128) return code;
  return cu;
}

const CANON_CACHE = new Map<number, number>();
function canonCached(code: number): number {
  if (code < 128) return code >= 97 && code <= 122 ? code - 32 : code;
  let v = CANON_CACHE.get(code);
  if (v === undefined) {
    v = canon(code);
    CANON_CACHE.set(code, v);
  }
  return v;
}

/** 逐码元折叠（规范实现；快路径不适用时用它） */
function foldSlow(text: string): string {
  let out = "";
  let chunk: number[] = [];
  for (let i = 0; i < text.length; i++) {
    chunk.push(canonCached(text.charCodeAt(i)));
    if (chunk.length === 4096) {
      out += String.fromCharCode(...chunk);
      chunk = [];
    }
  }
  return out + String.fromCharCode(...chunk);
}

/**
 * 整串 toUpperCase 与逐码元 Canonicalize 结果不同的 BMP 码元：大写不止一个码元的（ß→SS）、
 * 非 ASCII 变成 ASCII 的（ı→I、ſ→S），以及转大写后变了但 Canonicalize 不变的。启动时算一次。
 */
const FOLD_EXCEPTIONS: RegExp = (() => {
  const bad: string[] = [];
  for (let c = 128; c < 0xd800; c++) {
    const ch = String.fromCharCode(c);
    const u = ch.toUpperCase();
    if (u.length !== 1 || u.charCodeAt(0) !== canon(c)) bad.push(ch);
  }
  for (let c = 0xe000; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    const u = ch.toUpperCase();
    if (u.length !== 1 || u.charCodeAt(0) !== canon(c)) bad.push(ch);
  }
  const esc = bad.map((ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return new RegExp(`[${esc}]`);
})();

/**
 * 按正则 `i` 标志的规则折叠大小写，长度与原文相同。
 * 快路径：原生 toUpperCase。它与逐码元 Canonicalize 只在两类字符上不同——上面的例外表，
 * 以及有大小写的四字节字符（toUpperCase 按码点转，Canonicalize 按码元、不转）——
 * 文本里出现这两类时走逐码元的慢路径。
 */
export function foldCase(text: string): string {
  if (FOLD_EXCEPTIONS.test(text)) return foldSlow(text);
  const u = text.toUpperCase();
  if (u.length !== text.length) return foldSlow(text);
  if (/[\uD800-\uDFFF]/.test(text)) {
    const re = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (u.charCodeAt(m.index) !== text.charCodeAt(m.index) || u.charCodeAt(m.index + 1) !== text.charCodeAt(m.index + 1)) {
        return foldSlow(text);
      }
    }
  }
  return u;
}

function isWordCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

interface Node {
  next: Map<number, number>;
  fail: number;
  /** 在此结束的模式：[实体下标, 模式长度] */
  out: Array<[number, number]>;
}

class Automaton {
  private readonly nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }];
  /** 根节点的跳转表（码元 → 节点，0 = 留在根）：文本里绝大多数字符在这里一步判定 */
  private root = new Int32Array(0);

  add(pattern: string, id: number): void {
    let cur = 0;
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern.charCodeAt(i);
      let nxt = this.nodes[cur].next.get(c);
      if (nxt === undefined) {
        nxt = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, out: [] });
        this.nodes[cur].next.set(c, nxt);
      }
      cur = nxt;
    }
    this.nodes[cur].out.push([id, pattern.length]);
  }

  build(): void {
    this.root = new Int32Array(65536);
    for (const [c, v] of this.nodes[0].next) this.root[c] = v;
    const queue: number[] = [];
    for (const n of this.nodes[0].next.values()) queue.push(n);
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const [c, v] of this.nodes[u].next) {
        let f = this.nodes[u].fail;
        while (f !== 0 && !this.nodes[f].next.has(c)) f = this.nodes[f].fail;
        const cand = this.nodes[f].next.get(c);
        this.nodes[v].fail = cand !== undefined && cand !== v ? cand : 0;
        this.nodes[v].out.push(...this.nodes[this.nodes[v].fail].out);
        queue.push(v);
      }
    }
  }

  get empty(): boolean {
    return this.nodes.length === 1;
  }

  /** 对每一处命中回调（结束位置之后的下标 end、模式长度、实体下标） */
  scan(text: string, hit: (id: number, start: number, end: number) => void): void {
    const nodes = this.nodes;
    const root = this.root;
    let cur = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      while (cur !== 0 && !nodes[cur].next.has(c)) cur = nodes[cur].fail;
      cur = cur === 0 ? root[c] : (nodes[cur].next.get(c) as number);
      if (cur === 0) continue;
      const out = nodes[cur].out;
      for (let k = 0; k < out.length; k++) hit(out[k][0], i + 1 - out[k][1], i + 1);
    }
  }
}

export class EntityIndex {
  private readonly matchers: readonly EntityMatcher[];
  private readonly exact = new Automaton();
  private readonly folded = new Automaton();

  constructor(matchers: readonly EntityMatcher[]) {
    this.matchers = matchers;
    matchers.forEach((m, id) => {
      if (m.needle === "") return;
      if (m.caseSensitive) this.exact.add(m.needle, id);
      else this.folded.add(foldCase(m.needle), id);
    });
    this.exact.build();
    this.folded.build();
  }

  /** 文本里命中的实体（term 集合）；与对每个 matcher 跑 RegExp.test 的结果相同 */
  hits(text: string): Set<string> {
    const found = new Set<number>();
    const onHit = (id: number, start: number, end: number): void => {
      if (found.has(id)) return;
      const m = this.matchers[id];
      if (m.wordBoundary) {
        if (start > 0 && isWordCode(text.charCodeAt(start - 1))) return;
        if (end < text.length && isWordCode(text.charCodeAt(end))) return;
      }
      found.add(id);
    };
    if (!this.exact.empty) this.exact.scan(text, onHit);
    if (!this.folded.empty) this.folded.scan(foldCase(text), onHit);
    // 按 matcher 顺序输出，和逐个匹配时 Set 的插入顺序一致
    const out = new Set<string>();
    for (const id of [...found].sort((a, b) => a - b)) out.add(this.matchers[id].term);
    return out;
  }
}
