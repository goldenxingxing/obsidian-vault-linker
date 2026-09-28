/**
 * text.ts — 文本工具：别名清洗 / 标题提取 / 摘要提取 / wikilink 构造
 */

import { pyBasename, pyLen, pyLstripQuoteSpace, pySlice, pySplitLines, pyStrip, PY_WS_CLASS } from "./pycompat.ts";
import { stripAllBlocks } from "./blocks.ts";
import { bodyWithoutFm } from "./frontmatter.ts";
import type { Settings } from "./settings.ts";

/** 标题里 `#` 后的空白判定用 pycompat.ts 的空白集合（不是 JS 的 \s） */
const TITLE_RE = new RegExp(`^#[${PY_WS_CLASS}]+(.+?)[${PY_WS_CLASS}]*$`, "m");

export function cleanAlias(s: string): string {
  return pyStrip(s.replace(/\|/g, "/").replace(/\[/g, " ").replace(/\]/g, " "));
}

/** 标题：正文（剥掉 frontmatter 与托管区块后）第一个 `# xxx`，否则文件名去 .md */
export function titleOf(content: string, rel: string, s: Settings): string {
  const body = bodyWithoutFm(stripAllBlocks(content, s), s);
  const m = TITLE_RE.exec(body);
  if (m) return cleanAlias(m[1]);
  return pyBasename(rel).slice(0, -3);
}

/** 摘要：正文第一个非空、非标题、非分隔线、非 HTML 注释行，截断到 summaryMaxChars */
export function summaryOf(content: string, s: Settings): string {
  const body = bodyWithoutFm(stripAllBlocks(content, s), s);
  for (const line of pySplitLines(body)) {
    let t = pyStrip(line);
    if (!t || t.startsWith("#") || t === "---" || t === "***" || t === "___" || t.startsWith("<!--")) continue;
    t = pyStrip(pyLstripQuoteSpace(t));
    // 摘要内的 wikilink / markdown 链接转纯文本，避免 MOC 里带外链
    t = t.replace(/!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1");
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    if (!t) continue;
    const n = pyLen(t);
    return pySlice(t, s.moc.summaryMaxChars) + (n > s.moc.summaryMaxChars ? "…" : "");
  }
  return s.texts.noSummary;
}

/** `[[target]]` 或 `[[target|display]]`（rel 是 .md 路径，链接里去掉扩展名） */
export function wikilink(rel: string, display?: string): string {
  const target = rel.slice(0, -3);
  if (display) return `[[${target}|${cleanAlias(display)}]]`;
  return `[[${target}]]`;
}

/** 简单模板替换：{name} → 值 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole,
  );
}

/**
 * 按原文件的换行风格写回：原文用 CRLF（Windows 上常见）就把 \n 换回 \r\n。
 * 读入时已统一成 \n；不换回来的话，每篇被写过的文件在 git 里都是整篇改动。
 */
export function withOriginalEol(text: string, raw: string): string {
  if (!raw.includes("\r\n")) return text;
  return text.replace(/\r?\n/g, "\r\n");
}
