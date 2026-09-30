/**
 * entities.ts — 实体来源合成（E1 标题/别名 · E2 tag · E3 自定义词表 · E4 已采纳候选）
 *
 * 通用化的关键：**不给用户预置领域词**，而是把"实体"做成多来源合成的管线。
 * 零配置时靠 E1+E2 就能产出链接；进阶用户再加 E3/E4。
 *
 * 匹配语义：拉丁词加词边界、大小写不敏感；中文词不加边界、大小写敏感。
 */

import type { EntityRule, Settings } from "./settings.ts";
import { pyLen, pyReEscape } from "./pycompat.ts";
import { foldCase } from "./multimatch.ts";
import { stripAllBlocks } from "./blocks.ts";
import { bodyWithoutFm, parseFrontmatterTags } from "./frontmatter.ts";

export interface EntityMatcher {
  /** 实体键（打分与去重都用它） */
  term: string;
  /** 快路径：带 lookbehind 的正则；运行环境不支持 lookbehind 时为 null */
  re: RegExp | null;
  /** 回退路径用的原文字（未转义） */
  needle: string;
  caseSensitive: boolean;
  wordBoundary: boolean;
  weight: number;
  /** 来源标记，仅用于 UI 展示 */
  source: "manual" | "auto" | "tag" | "title" | "path";
  /** 命中示例文档（向导展示用，运行时可选填充） */
  sample?: string;
}

/** 旧版「领域标签」功能写进 frontmatter 的 tag 前缀（功能已移除，笔记里可能还有） */
const LEGACY_DOMAIN_TAG = "domain/";

/** 词边界字符集：ASCII 字母、数字、下划线 */
function isBoundaryWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";
}

export interface EntitySourceDoc {
  rel: string;
  title: string;
  aliases: string[];
  tags: string[];
}

/** 判断一个词是否"拉丁型"（含 ASCII 字母且不含 CJK）——决定默认的匹配方式 */
export function isLatinTerm(term: string): boolean {
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(term)) return false;
  return /[A-Za-z]/.test(term);
}

function buildRegex(term: string, rule: Pick<EntityRule, "caseSensitive" | "wordBoundary">): RegExp | null {
  const flags = rule.caseSensitive ? "g" : "gi";
  const esc = pyReEscape(term);
  // 整词匹配要看命中位置的前一个字符。正则里只能写 lookbehind，而 iOS 16.4 以前不支持
  // （社区插件审核也不允许），所以整词匹配不用正则，走 matcherFallbackHit
  if (rule.wordBoundary) return null;
  return new RegExp(esc, flags);
}

function deriveRule(term: string): Pick<EntityRule, "caseSensitive" | "wordBoundary"> {
  return isLatinTerm(term)
    ? { caseSensitive: false, wordBoundary: true }
    : { caseSensitive: true, wordBoundary: false };
}

/** 实体去重键：拉丁词不分大小写 */
function entityKey(term: string): string {
  return isLatinTerm(term) ? term.toLowerCase() : term;
}

/** 只由数字、空白和日期分隔符组成（2026-09-20、20260920、2026年9月20日、12:30） */
function isDateLike(term: string): boolean {
  return /^[\d\s\-_./:年月日号]+$/.test(term.trim());
}

/**
 * 内置的「结构词」文件夹名：这类名字说明的是组织方式，不是笔记讲什么，
 * 当主题词只会是噪音。比较用小写（对 CJK 无影响）。
 * 用户自己的词表/停用词照常叠加生效。
 */
const GENERIC_DIR_STOPWORDS: ReadonlySet<string> = new Set([
  "notes", "note", "docs", "doc", "files", "attachments", "assets", "images", "imgs",
  "photos", "archive", "archives", "backup", "backups", "drafts", "draft", "inbox",
  "outbox", "templates", "template", "journal", "diary", "daily", "weekly", "misc",
  "unsorted", "private", "new folder", "untitled",
  "新建文件夹", "未命名", "附件", "笔记", "文档", "草稿", "归档", "模板", "日记",
  "图片", "照片", "素材", "待整理", "未分类", "其他", "临时", "杂项",
]);

/**
 * E5 的原料：一篇笔记路径里的**文件夹段**（不含文件名——文件名已经作为标题走 E1）。
 * 过滤：过短（minLength）、纯日期（2026、09、2026-09…）、内置结构词、用户停用词。
 * 深层路径会贡献多段：score 的 1/df 天然把「人人都有的顶层目录」稀释掉、
 * 把「只有几篇笔记的深层子文件夹」顶上来，不需要按层级手工调权。
 */
export function pathSegmentsOf(rel: string, s: Settings): string[] {
  const parts = rel.split("/");
  const out: string[] = [];
  for (const seg of parts.slice(0, -1)) {
    const t = seg.trim();
    if (!t) continue;
    if (pyLen(t) < s.entities.minLength) continue;
    if (isDateLike(t)) continue;
    if (GENERIC_DIR_STOPWORDS.has(t.toLowerCase())) continue;
    if (s.entities.stopwords.includes(t)) continue;
    out.push(t);
  }
  return [...new Set(out)];
}

/**
 * 合成实体匹配器。优先级（同名去重）：manual > auto > tag > title。
 */
export function buildEntityMatchers(s: Settings, docs: readonly EntitySourceDoc[]): EntityMatcher[] {
  const byKey = new Map<string, EntityMatcher>();
  const stop = new Set(s.entities.stopwords.map((w) => w.trim()).filter(Boolean));

  const add = (raw: string, weight: number, source: EntityMatcher["source"], rule?: Partial<EntityRule>): void => {
    const term = raw.trim();
    if (!term) return;
    if (pyLen(term) < s.entities.minLength) return;
    if (stop.has(term)) return;
    const key = entityKey(term);
    if (byKey.has(key)) return; // 先到先得
    const d = deriveRule(term);
    const caseSensitive = rule?.caseSensitive ?? d.caseSensitive;
    const wordBoundary = rule?.wordBoundary ?? d.wordBoundary;
    byKey.set(key, {
      term,
      re: buildRegex(term, { caseSensitive, wordBoundary }),
      needle: term,
      caseSensitive,
      wordBoundary,
      weight,
      source,
    });
  };

  // E3 自定义词表（含 E5 迁移进来的 39 个词）
  for (const rule of s.entities.manual) {
    const weight = rule.weight || 1;
    add(rule.term, weight, "manual", rule);
    for (const alias of rule.aliases) add(alias, weight, "manual", rule);
  }

  // E4 向导里采纳的自动候选
  for (const term of s.entities.autoAccepted) add(term, 1, "auto");

  // E2 vault 内 tag（用户自己维护的主题词，质量最高）。
  // 旧版本插件补过的领域 tag（domain/…）不算：几乎每篇都有，只会是噪音
  if (s.entities.fromTags) {
    for (const doc of docs) {
      for (const tag of doc.tags) {
        if (tag.startsWith(LEGACY_DOMAIN_TAG)) continue;
        const t = s.entities.tagMode === "top" ? tag.split("/")[0] : tag;
        add(t, 1, "tag");
      }
    }
  }

  // E1 笔记标题 + 别名。两类标题说明不了笔记讲什么，不当实体：
  //   - 与两篇以上笔记的**文件名**相同（README、SKILL、LICENSE、index…）：约定俗成的文件名，
  //     不是主题。只看文件名：两篇的一级标题一字不差，往往恰恰说明它们讲同一件事
  //   - 纯日期 / 数字（日记的 2026-09-20）：正文里提到日期不代表相关
  if (s.entities.fromTitles) {
    const nameCount = new Map<string, number>();
    for (const doc of docs) {
      const n = entityKey(doc.rel.slice(doc.rel.lastIndexOf("/") + 1).replace(/\.md$/, "").trim());
      nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
    }
    const generic = (title: string): boolean =>
      (nameCount.get(entityKey(title.trim())) ?? 0) >= 2 || isDateLike(title);
    for (const doc of docs) {
      if (!generic(doc.title)) add(doc.title, 1, "title");
      for (const alias of doc.aliases) if (!isDateLike(alias)) add(alias, 1, "title");
    }
  }

  // E5 文件夹名（词义性）：用户给文件夹起的名字是整个 vault 里质量最高的「人工策展词表」。
  // 正文**提到**某文件夹名 → 与归档在该文件夹下的笔记相关（哪怕那些笔记从没写过这四个字）。
  // 与 E1 的关系：文件夹名恰好等于某篇笔记标题时由去重合并（title 先到、path 让位）。
  if (s.entities.fromPathNames) {
    for (const doc of docs) {
      for (const seg of pathSegmentsOf(doc.rel, s)) add(seg, 1, "path");
    }
  }

  return [...byKey.values()];
}

/** 去掉代码块与行内代码（可选开关，默认关） */
export function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * 整词匹配：纯文本搜索 + 手工边界检查，等价于「term 前后都不是 [A-Za-z0-9_]」并带 `i` 标志的效果。
 * 忽略大小写用 foldCase（照搬正则 `i` 标志的比较规则，折叠前后长度不变），不用 toLowerCase：
 * 后者在 ß、İ 这类字符上和正则不一致，还可能改变长度、让边界检查错位。
 * folded：调用方已折叠好的 text（同一篇文档对多个实体复用）。
 */
export function matcherFallbackHit(text: string, m: EntityMatcher, folded?: string): boolean {
  const hay = m.caseSensitive ? text : (folded ?? foldCase(text));
  const needle = m.caseSensitive ? m.needle : foldCase(m.needle);
  if (needle === "") return false;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) return false;
    if (!m.wordBoundary) return true;
    const before = at > 0 ? hay[at - 1] : undefined;
    const after = at + needle.length < hay.length ? hay[at + needle.length] : undefined;
    if (!isBoundaryWordChar(before) && !isBoundaryWordChar(after)) return true;
    i = at + 1;
  }
}

/** 参与实体匹配的文本：剥掉 frontmatter 与托管区块 */
export function entityText(content: string, s: Settings): string {
  // 先剥区块再剥 frontmatter：反过来的话，「开头是 ---」的笔记会把区块分隔线当成 frontmatter 结尾
  let text = bodyWithoutFm(stripAllBlocks(content, s), s);
  if (s.entities.ignoreInCode) text = stripCode(text);
  return text;
}

/**
 * 抽取一篇文档命中的实体集合——逐个 matcher 匹配的参考实现。
 * 引擎用 multimatch.ts 的 EntityIndex（一次扫描，结果相同，有单测对照）。
 */
export function entitiesOf(content: string, matchers: readonly EntityMatcher[], s: Settings): Set<string> {
  const text = entityText(content, s);
  const hits = new Set<string>();
  let folded: string | undefined;
  for (const m of matchers) {
    if (m.re) {
      m.re.lastIndex = 0;
      if (m.re.test(text)) hits.add(m.term);
    } else if (matcherFallbackHit(text, m, m.caseSensitive ? undefined : (folded ??= foldCase(text)))) {
      hits.add(m.term);
    }
  }
  return hits;
}

/** 从文档收集 E1/E2 需要的原料（标题、aliases、tags） */
export function entitySourceDoc(rel: string, content: string, title: string): EntitySourceDoc {
  const fm = parseFrontmatterTags(content, "aliases");
  const tags = parseFrontmatterTags(content, "tags").tags;
  return { rel, title, aliases: fm.tags, tags };
}
