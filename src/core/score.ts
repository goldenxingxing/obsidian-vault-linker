/**
 * score.ts — 相关度打分与 top-N 选链
 *
 * score = Σ(weight/df[实体])，同领域 ×sameDomainBoost，取 top-N。
 *
 * 两处为确定性做的处理：
 *
 * 1. 共享实体固定按 code point 排序后求和：浮点加法不满足结合律，求和顺序不固定时
 *    结果在 ULP 级别上会随运行变化。
 * 2. 排序前把得分**量化到 12 位有效数字**：两篇文档得分相差不到 1 ULP 时，谁排前面本来
 *    只取决于求和顺序（真实 vault 里出现过相差 1.388e-17 的一对）。量化后这种噪声被抹平，
 *    并列时按路径排序。
 */

import { pyCompare, pySort } from "./pycompat.ts";
import type { Settings } from "./settings.ts";
import type { EntityMatcher } from "./entities.ts";

export interface ScoredTarget {
  rel: string;
  score: number;
}

/** 文档频次 df：实体 → 出现在多少篇文档里 */
export function computeDf(docEntities: ReadonlyMap<string, Set<string>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const set of docEntities.values()) {
    for (const e of set) df.set(e, (df.get(e) ?? 0) + 1);
  }
  return df;
}

function weightOf(term: string, weights: ReadonlyMap<string, number>): number {
  return weights.get(term) ?? 1;
}

/**
 * 得分量化到 12 位有效数字（纯函数、与比较对象无关，所以排序键仍是全序，不会出现
 * 两两比较不传递的问题）。目的：抹平 ULP 级噪声，使“数学上并列”的两篇文档不受浮点求和顺序影响。
 */
function quantize(x: number): number {
  return x === 0 ? 0 : Number(x.toPrecision(12));
}

interface Ranked extends ScoredTarget {
  q: number;
}

/** 倒排表：实体 → 含有它的文档。排序时只和共享实体的文档比，不必两两比较全部文档 */
export type Postings = ReadonlyMap<string, readonly string[]>;

export function buildPostings(docEntities: ReadonlyMap<string, Set<string>>): Map<string, string[]> {
  const p = new Map<string, string[]>();
  for (const [rel, set] of docEntities) {
    for (const e of set) {
      const list = p.get(e);
      if (list) list.push(rel);
      else p.set(e, [rel]);
    }
  }
  return p;
}

/** 单篇文档的相关文档排序（全量、未截断） */
export function rankRelated(
  rel: string,
  rels: readonly string[],
  docEntities: ReadonlyMap<string, Set<string>>,
  domains: ReadonlyMap<string, string>,
  df: ReadonlyMap<string, number>,
  weights: ReadonlyMap<string, number>,
  s: Settings,
  postings: Postings = buildPostings(new Map(rels.map((r) => [r, docEntities.get(r) ?? new Set<string>()]))),
  limit = Infinity,
): ScoredTarget[] {
  const mine = docEntities.get(rel);
  if (!mine || mine.size === 0) return [];
  // 与 rel 共享至少一个实体的文档 → 共享的实体
  const sharedBy = new Map<string, string[]>();
  for (const e of mine) {
    for (const other of postings.get(e) ?? []) {
      if (other === rel) continue;
      const list = sharedBy.get(other);
      if (list) list.push(e);
      else sharedBy.set(other, [e]);
    }
  }
  // 排序键：量化后的得分降序、路径升序（全序）。量化每个候选只算一次
  const before = (a: Ranked, b: Ranked): boolean => a.q > b.q || (a.q === b.q && pyCompare(a.rel, b.rel) < 0);
  const out: Ranked[] = [];
  for (const [other, shared] of sharedBy) {
    // 固定按 code point 排序后求和（确定性；见文件头说明）
    const sorted = pySort(shared);
    let score = 0;
    for (const e of sorted) {
      const d = df.get(e) ?? 1;
      score += weightOf(e, weights) / d;
    }
    if (domains.get(other) === domains.get(rel)) score *= s.related.sameDomainBoost;
    if (score <= s.related.minScore) continue;
    const item: Ranked = { rel: other, score, q: quantize(score) };
    if (limit === Infinity) {
      out.push(item);
      continue;
    }
    // 只要前 limit 名：维护一个有序的小数组（全序下与全排序后截断结果相同）
    if (out.length === limit && !before(item, out[limit - 1])) continue;
    let i = out.length;
    while (i > 0 && before(item, out[i - 1])) i--;
    out.splice(i, 0, item);
    if (out.length > limit) out.pop();
  }
  if (limit === Infinity) out.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  return out.map(({ rel: r, score }) => ({ rel: r, score }));
}

/** 最终写入托管区块的 top-N 目标 */
export function linkTargets(
  rel: string,
  rels: readonly string[],
  docEntities: ReadonlyMap<string, Set<string>>,
  domains: ReadonlyMap<string, string>,
  df: ReadonlyMap<string, number>,
  weights: ReadonlyMap<string, number>,
  s: Settings,
  postings?: Postings,
): string[] {
  if (!s.related.enabled) return [];
  const n = Math.max(0, Math.floor(s.related.topN));
  if (n === 0) return [];
  return rankRelated(rel, rels, docEntities, domains, df, weights, s, postings, n).map((x) => x.rel);
}

export function weightMap(matchers: readonly EntityMatcher[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of matchers) m.set(x.term, x.weight);
  return m;
}
