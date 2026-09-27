/**
 * config-text.ts — 设置界面的「配置 ↔ 文本」转换（纯函数，无 Obsidian 依赖）
 *
 * 为什么放在 core：领域表和实体词表是用户**手写 / 粘贴**的配置入口，
 * 解析错一行就会静默丢配置。放在 core 才能被 node --test 直接覆盖
 * （settings-tab.ts 依赖 obsidian 运行时，测不了）。
 */

import { isLatinTerm } from "./entities.ts";
import type { DomainRule, EntityRule } from "./settings.ts";

/** 领域列表 → 文本：`id | 显示名 | 路径(逗号) | 根关键词 | 根前缀 | 优先级`
 *
 *  「忽略大小写关键词」列只在它与根关键词的小写**不同**时才写出（7 列形式），
 *  否则省略（6 列形式）——那是实现细节，不该让用户手填。 */
export function domainsToText(domains: readonly DomainRule[]): string {
  return domains
    .map((d) => {
      const derived = d.rootKeywords.map((x) => x.toLowerCase());
      const cols = [d.id, d.name, d.paths.join(","), d.rootKeywords.join(",")];
      if (JSON.stringify(derived) !== JSON.stringify(d.rootKeywordsLower)) {
        cols.push(d.rootKeywordsLower.join(","));
      }
      cols.push(d.rootPrefixes.join(","), String(d.priority));
      return cols.join(" | ");
    })
    .join("\n");
}

/**
 * 文本 → 领域列表：空行与 `#` 开头的行忽略，列数不足 2 的行忽略。
 *
 *   - **7 列**：显式给出了「忽略大小写关键词」列（空串 = 真的不做忽略大小写匹配）
 *   - **6 列**：省略该列，自动用根关键词的小写派生
 *   - **更少**：按老位置尽力解析（兼容手工输入的残缺行）
 */
export function textToDomains(text: string): DomainRule[] {
  const out: DomainRule[] = [];
  const split = (s: string | undefined): string[] =>
    (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("|").map((c) => c.trim());
    if (cols.length < 2) continue;
    const [id, name, paths, kw] = cols;
    const rest = cols.slice(4);
    let kwLower: string[] | null; // null = 该列被省略 → 派生
    let prefixes: string[];
    let priority: number;
    if (rest.length >= 3) {
      kwLower = split(rest[0]);
      prefixes = split(rest[1]);
      priority = Number.parseInt(rest[2] ?? "0", 10) || 0;
    } else if (rest.length === 2) {
      kwLower = null;
      prefixes = split(rest[0]);
      priority = Number.parseInt(rest[1] ?? "0", 10) || 0;
    } else {
      kwLower = split(rest[0]);
      prefixes = split(rest[1]);
      priority = Number.parseInt(rest[2] ?? "0", 10) || 0;
    }
    const rootKeywords = split(kw);
    out.push({
      id: id || name,
      name: name || id,
      paths: split(paths),
      rootKeywords,
      rootKeywordsLower: kwLower ?? rootKeywords.map((x) => x.toLowerCase()),
      rootPrefixes: prefixes,
      priority,
    });
  }
  return out;
}

/** 实体词表 → 文本：`term = alias1, alias2`（无别名时只有 term） */
export function entitiesToText(rules: readonly EntityRule[]): string {
  return rules
    .map((r) => (r.aliases.length > 0 ? `${r.term} = ${r.aliases.join(", ")}` : r.term))
    .join("\n");
}

/** 文本 → 实体词表；拉丁词自动 caseSensitive=false + wordBoundary=true */
export function textToEntities(text: string): EntityRule[] {
  const out: EntityRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [termPart, aliasPart] = line.split("=");
    const term = (termPart ?? "").trim();
    if (!term) continue;
    const aliases = (aliasPart ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const latin = isLatinTerm(term);
    out.push({
      term,
      aliases,
      caseSensitive: !latin,
      wordBoundary: latin,
      weight: 1,
    });
  }
  return out;
}
