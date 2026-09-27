/**
 * blocks.ts — 托管区块（managed blocks）的剥离与追加
 *
 * append_end_block / strip_all_blocks。
 *
 * 注意：剥离要替换**全部**区块，正则必须带 g 标志（漏了只剥第一处）。
 * 区块标签由配置提供，**不做正则转义**。
 */

import type { Settings } from "./settings.ts";
import { hasFrontmatter } from "./frontmatter.ts";

/** 结尾型区块（追加在文档末尾）：AUTO-LINKS / DELIVERABLES */
export function stripEndBlock(content: string, tag: string): string {
  // 分隔线平时是 ---；笔记以 --- 开头又没有闭合时用 ***（见 blockSeparator）
  const re = new RegExp(`\\n?(?:---|\\*\\*\\*)\\n<!-- ${tag}:START -->[\\s\\S]*?<!-- ${tag}:END -->\\n?`, "g");
  return content.replace(re, "");
}

/** frontmatter 后插入的出处区块：SOURCE-LINK（文件开头 或 文件中部两种形式） */
export function stripSourceBlock(content: string, tag: string): string {
  let c = content.replace(
    new RegExp(`^<!-- ${tag}:START -->[\\s\\S]*?<!-- ${tag}:END -->\\n`, "g"),
    "",
  );
  c = c.replace(
    new RegExp(`\\n<!-- ${tag}:START -->[\\s\\S]*?<!-- ${tag}:END -->\\n`, "g"),
    "",
  );
  return c;
}

/** 剥离全部托管区块 */
export function stripAllBlocks(content: string, s: Settings): string {
  let c = stripEndBlock(content, s.related.blockTag);
  c = stripEndBlock(c, s.daily.blockTag);
  c = stripSourceBlock(c, s.daily.sourceBlockTag);
  return c;
}

/**
 * 把区块追加到文档末尾。glue 三分支：
 * 空内容 -> ""，以换行结尾 -> "\n"，否则 -> "\n\n"。
 */
export function appendEndBlock(content: string, tag: string, body: string, sep = "---"): string {
  let glue: string;
  if (content === "") glue = "";
  else if (content.endsWith("\n")) glue = "\n";
  else glue = "\n\n";
  return `${content}${glue}${sep}\n<!-- ${tag}:START -->\n${body}<!-- ${tag}:END -->\n`;
}

/**
 * 文档中所有托管区块的字符区间（用于判定失效链接是否落在托管区块内）。
 * START 与 END 两侧各自独立做标签轮换，不要求首尾标签相同。
 */
export function managedBlockSpans(content: string, s: Settings): Array<[number, number]> {
  const alt = [s.related.blockTag, s.daily.blockTag, s.daily.sourceBlockTag].join("|");
  const re = new RegExp(`<!-- (?:${alt}):START -->[\\s\\S]*?<!-- (?:${alt}):END -->`, "g");
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return spans;
}

/**
 * 区块前的分隔线。笔记以 `---` 开头却没有闭合（开头是一条分隔线，不是 frontmatter）时，
 * 追加的 `---` 会把它闭合：Obsidian 会把整篇正文当成 frontmatter 属性，正文从视图里消失。
 * 这种笔记改用 `***`（渲染出来同样是一条分隔线，但不会闭合 frontmatter）。
 */
export function blockSeparator(content: string, s: Settings): string {
  if (!content.startsWith("---\n")) return "---";
  return hasFrontmatter(content, s) ? "---" : "***";
}
