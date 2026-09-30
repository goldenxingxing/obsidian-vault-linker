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

/**
 * 去掉成对的强调标记（`**` / `~~`），只保留内容。
 *
 * 不用 lookbehind：iOS 16.4 之前的 JavaScriptCore 不支持，打包产物会被社区版的
 * 静态扫描拦下来（解析期直接 SyntaxError，插件整个加载不出来），
 * 改成手工边界检查——和 entities.ts 的 matcherFallbackHit 同一套路。
 *
 * 语义与原来的两条正则完全一致，包括它们的「宽松」之处：
 *   粗体   ：前一字符不能是 \w；** 后紧跟非空白；内容到下一个 ** 为止，且那个 ** 前不是空白；闭标记后不能是 \w
 *   删除线 ：同上，但前后不加 \w 限制
 * 闭标记的搜索起点是开标记的正后方，所以 `****`（空内容）也算一对；
 * 开标记的 `(?=\S)` 只在开标记成立时检查，之后就不再回头重查。
 */
function stripPairs(s: string, mark: string, wordGuard: boolean): string {
  const n = s.length;
  const mlen = mark.length;
  const isWord = (ch: string | undefined): boolean =>
    !!ch && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_");
  let out = "";
  let last = 0;   // 输出游标：原文里尚未写进 out 的位置
  let i = 0;      // 搜索游标（匹配失败时往前推，不能动 last）
  for (;;) {
    const at = s.indexOf(mark, i);
    if (at < 0) break;
    const before = at > 0 ? s[at - 1] : undefined;  // 字符串开头算通过
    const openOk = !wordGuard || !isWord(before);
    const bodyStart = at + mlen;
    const bodyOk = bodyStart < n && !/\s/.test(s[bodyStart]);
    if (!openOk || !bodyOk) {
      i = at + 1;
      continue;
    }
    let end = -1;
    for (let j = bodyStart; j + mlen <= n; j++) {
      if (s.indexOf(mark, j) !== j) continue;
      if (/\s/.test(s[j - 1])) continue;
      if (wordGuard && isWord(j + mlen < n ? s[j + mlen] : undefined)) continue;
      end = j;
      break;
    }
    if (end < 0) {
      i = at + 1;
      continue;
    }
    out += s.substring(last, at);
    out += s.substring(bodyStart, end);
    last = end + mlen;
    i = last;
  }
  return out + s.substring(last);
}

/** 行内标记转纯文本：行内代码 → 内容；粗体 → 内容；删除线 → 内容；HTML 标签 → 无 */
function plainInline(t: string): string {
  t = t.replace(/(`+)([^`]*?)\1/g, "$2");
  t = stripPairs(t, "**", true);   // 粗体；`__` 不处理——`__init__` 这类标识符会被误伤
  t = stripPairs(t, "~~", false);  // 删除线
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
  return wikilinkT(rel.slice(0, -3), display);
}

/** 同上，但 target 已去扩展名（shortestTargets 的产物用它，避免二次截断） */
export function wikilinkT(target: string, display?: string): string {
  if (display) return `[[${target}|${cleanAlias(display)}]]`;
  return `[[${target}]]`;
}

/**
 * 同一列表里多条笔记的显示文本撞车时加最短可区分后缀：`标题（后缀）`。
 * 第一级后缀是文件名（典型场景：两篇 H1 都叫「Kalinin」的日报，文件名带日期天然可读）；
 * 文件名也撞时往上补目录段，直到组内唯一。不撞车的条目原样返回，输出一字不变。
 * 列表按调用处的展示单位算（笔记的相关笔记区块 / 索引页的一个小节），纯函数。
 */
export function dedupeDisplays(rels: readonly string[], display: (rel: string) => string): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const rel of rels) {
    const d = display(rel);
    const list = groups.get(d);
    if (list) list.push(rel);
    else groups.set(d, [rel]);
  }
  const out = new Map<string, string>();
  for (const [d, group] of groups) {
    if (group.length === 1) {
      out.set(group[0], d);
      continue;
    }
    // 逐级加长后缀（文件名 → 上级目录/文件名 → …），直到组内每条的后缀都不同
    const segsOf = (rel: string): string[] => rel.split("/");
    const suffixFor = (rel: string, depth: number): string =>
      segsOf(rel).slice(-depth).join("/").replace(/\.md$/, "");
    const maxDepth = Math.max(...group.map((rel) => segsOf(rel).length));
    let depth = 1;
    for (; depth < maxDepth; depth++) {
      const used = new Set<string>();
      let clash = false;
      for (const rel of group) {
        const suf = suffixFor(rel, depth);
        if (used.has(suf)) {
          clash = true;
          break;
        }
        used.add(suf);
      }
      if (!clash) break;
    }
    for (const rel of group) out.set(rel, `${d}（${suffixFor(rel, depth)}）`);
  }
  return out;
}

/**
 * 计算每条 rel 的「最短唯一链接目标」：文件名（去扩展名）在 vault 里唯一就只写文件名，
 * 撞车了往上补目录段，直到在所有 md 里唯一（大小写不敏感，对齐 Obsidian 的解析）。
 * universe 是 vault 全量 md（含排除目录），防止被范围外的同名文件抢占解析。
 * 与 dedupeDisplays 是两套独立逻辑：那个管竖线后的显示文本，这个管竖线前的链接目标。
 */
export function shortestTargets(rels: readonly string[], universe: readonly string[]): Map<string, string> {
  const all = universe.length > 0 ? universe : rels;
  // 每个候选长度下的后缀计数（小写键）
  const countAt = (depth: number): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of all) {
      const segs = r.split("/");
      if (segs.length < depth) continue;
      const key = segs.slice(-depth).join("/").replace(/\.md$/i, "").toLowerCase();
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  };
  const depthCache = new Map<number, Map<string, number>>();
  const counts = (depth: number): Map<string, number> => {
    let c = depthCache.get(depth);
    if (!c) {
      c = countAt(depth);
      depthCache.set(depth, c);
    }
    return c;
  };
  const out = new Map<string, string>();
  for (const rel of rels) {
    const segs = rel.split("/");
    const maxDepth = segs.length; // 最深就是全路径（不含扩展名）
    let target = segs.join("/").replace(/\.md$/i, "");
    for (let depth = 1; depth <= maxDepth; depth++) {
      const cand = segs.slice(-depth).join("/").replace(/\.md$/i, "");
      if ((counts(depth).get(cand.toLowerCase()) ?? 0) === 1) {
        target = cand;
        break;
      }
    }
    out.set(rel, target);
  }
  return out;
}

/**
 * 渲染前最后一道：显示文本带的后缀若与缩短后的链接目标完全重复
 * （`Kalinin（D-2026-09-23）` + 目标 `D-2026-09-23`），去掉后缀——日期在目标里已经自带，
 * 不必显示两遍；标题（Kalinin）是主要语义，原样保留。
 * 撞名是靠别的后缀区分的（目标与后缀不同，如 `Kalinin（9月/D-2026-09-21）`）则原样保留。
 */
export function collapseDisplays(
  rels: readonly string[],
  displays: ReadonlyMap<string, string>,
  targets: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of rels) {
    const d = displays.get(rel) ?? "";
    const t = targets.get(rel);
    const suffix = t ? `（${t}）` : "";
    out.set(rel, suffix !== "" && d.endsWith(suffix) ? d.slice(0, d.length - suffix.length) : d);
  }
  return out;
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
