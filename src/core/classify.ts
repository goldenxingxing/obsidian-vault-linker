/**
 * classify.ts — 领域归类
 *
 * 规则：
 *   - 目录内文件：按 domains[] 的匹配模式（可配 priority 决定先后）命中第一个
 *   - 根目录散落文件：按 rootKeywords（大小写敏感包含）/ rootKeywordsLower（转小写包含）
 *     / rootPrefixes（前缀）命中第一个领域
 *   - 都没命中：目录内文件归 fallbackDomain 并记 WARNING；根目录文件静默归 fallback
 */

import { globMatch } from "./scope.ts";
import type { DomainRule, Settings } from "./settings.ts";

export interface ClassifyResult {
  domainId: string;
  /** 目录内文件未映射（会在报告里列出） */
  unmapped: boolean;
}

/** 按 (priority, 原顺序) 排序后的领域列表（用于目录匹配） */
function matchOrder(s: Settings): DomainRule[] {
  return s.domains
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (a.d.priority - b.d.priority) || (a.i - b.i))
    .map((x) => x.d);
}

export function classify(rel: string, s: Settings): ClassifyResult {
  const parts = rel.split("/");

  if (parts.length > 1) {
    for (const d of matchOrder(s)) {
      if (d.paths.some((p) => globMatch(p, rel))) return { domainId: d.id, unmapped: false };
    }
    return { domainId: s.fallbackDomain.id, unmapped: true };
  }

  const name = parts[0];
  const low = name.toLowerCase();
  for (const d of s.domains) {
    if (d.rootKeywords.some((k) => name.includes(k))) return { domainId: d.id, unmapped: false };
    if (d.rootKeywordsLower.some((k) => low.includes(k))) return { domainId: d.id, unmapped: false };
    if (d.rootPrefixes.some((p) => name.startsWith(p))) return { domainId: d.id, unmapped: false };
  }
  return { domainId: s.fallbackDomain.id, unmapped: false };
}
