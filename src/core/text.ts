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

/** 分隔线：整行只有 `-` / `_` / `*`（CommonMark 要求 ≥3 个） */
const HR_RE = /^(?:-{3,}|_{3,}|\*{3,})$/;

/**
 * 有序 / 无序列表标记；后面**必须**跟空白，避免误伤 `-5`、`1.5`。
 * 注意分组写法：闭括号要收在 `[.)]` 之后、空白类之前。
 * 若写成 `(?:[-*+]|(?:\d{1,9}[.)])[WS]+)`，闭括号落在空白类之后，
 * `[WS]+` 就只约束第二个分支，`-` 会单独命中 `-5`。
 */
const LIST_MARKER_RE = new RegExp(`^(?:[-*+]|\\d{1,9}[.)])[${PY_WS_CLASS}]+`);

/** 整行只有列表标记（`*`、`**` 这种没有内容的空要点）→ 不是摘要 */
const MARKERS_ONLY_RE = /^[-*+]+$/;

/** 粗体标记；`__` 不处理——`__init__` 这类标识符会被误伤 */
const BOLD_RE = /(?<!\w)\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*(?!\w)/g;

/** 行内标记转纯文本：行内代码 → 内容；粗体 → 内容；删除线 → 内容；HTML 标签 → 无 */
function plainInline(t: string): string {
  t = t.replace(/(`+)([^`]*?)\1/g, "$2");
  t = t.replace(BOLD_RE, "$1");
  t = t.replace(/~~(?=\S)([\s\S]*?)(?<=\S)~~/g, "$1");
  return pyStrip(t.replace(/<[^>]+>/g, ""));
}

/**
 * 摘要：正文第一个可读的行，转成纯文本后截断到 summaryMaxChars。
 * 跳过的是排版结构而不是内容：标题、表格行、代码块（含定界符）、分隔线、空要点、HTML 注释、空行。
 * 列表项只去掉标记保留内容；行内代码 / 粗体 / 删除线 / 链接转纯文本，
 * 否则索引页里会出现 `|---|`、`**` 这类排版残留。
 */
export function summaryOf(content: string, s: Settings): string {
  const body = bodyWithoutFm(stripAllBlocks(content, s), s);
  let fence: { ch: string; len: number } | null = null;  // 当前代码块的定界符
  let inComment = false;                                   // 多行 HTML 注释内
  for (const line of pySplitLines(body)) {
    const raw = pyStrip(line);

    // 代码块：同字符且长度不小于定界符的那一行才闭合
    const fm = raw.match(/^(`{3,}|~{3,})(.*)$/);
    if (fm) {
      const ch = fm[1].slice(0, 1);
      const len = fm[1].length;
      if (fence && ch === fence.ch && len >= fence.len) fence = null;
      else if (!fence) fence = { ch, len };
      continue;
    }
    if (fence) continue;

    // HTML 注释可能跨行
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      continue;
    }
    if (raw.includes("<!--")) {
      if (!raw.includes("-->")) inComment = true;
      continue;
    }

    if (!raw || raw.startsWith("#") || raw.startsWith("|") || HR_RE.test(raw) || MARKERS_ONLY_RE.test(raw)) continue;

    let t = pyStrip(pyLstripQuoteSpace(raw));
    t = t.replace(LIST_MARKER_RE, "");
    // 摘要内的 wikilink / markdown 链接转纯文本，避免 MOC 里带外链
    t = t.replace(/!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1");
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    t = plainInline(t);
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
