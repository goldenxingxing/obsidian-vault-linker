/**
 * frontmatter.ts — frontmatter 检测 / 补 domain tag / opt-out / 出处区块插入
 *
 */

import type { Settings } from "./settings.ts";
import { PY_WS_CLASS } from "./pycompat.ts";

/**
 * frontmatter：文件开头 `---` … `---`，与 Obsidian 的规则一致，空 frontmatter（`---` 紧跟 `---`）也算。
 * 要求中间至少有一行的写法认不出空 frontmatter，会一路匹配到文末区块的 `---` 分隔线，
 * 把整篇正文当成 frontmatter。
 */
const FM_RE = /^---\n(?:[\s\S]*?\n)?---\n/;

// s 参数保留在签名里，调用处不必改；规则不随配置变化
function fmRe(_s?: Settings): RegExp {
  return FM_RE;
}

export function frontmatterMatch(content: string, s?: Settings): RegExpMatchArray | null {
  return content.match(fmRe(s));
}

export function hasFrontmatter(content: string, s?: Settings): boolean {
  return fmRe(s).test(content);
}

export function bodyWithoutFm(content: string, s?: Settings): string {
  const m = content.match(fmRe(s));
  return m ? content.slice(m[0].length) : content;
}

/**
 * opt-out：frontmatter 里写 `vault-linker: ignore`（键名可配）时整篇不碰。
 * 只在 frontmatter 区块内查找。
 */
export function isOptedOut(content: string, s: Settings): boolean {
  const m = content.match(fmRe(s));
  if (!m) return false;
  const key = s.frontmatter.optOutKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const val = s.frontmatter.optOutValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${key}:[${PY_WS_CLASS}]*${val}[${PY_WS_CLASS}]*$`, "m");
  return re.test(m[0]);
}

/** 给完全没有 frontmatter 的文档补 tags */
export function addTagsFrontmatter(content: string, slug: string, s: Settings): string {
  return `---\ntags: [${s.frontmatter.tagPrefix}${slug}]\n---\n\n${content}`;
}

/** 空 frontmatter：`---` 紧跟 `---` */
const EMPTY_FM = "---\n---\n";

/**
 * 按配置给（已剥离托管区块的）正文补领域标签；引擎写入与写后保护校验共用这一个函数，
 * 两边算出的「期望内容」才不会分叉。
 *   - frontmatter.enabled 关 → 原样返回
 *   - 已有 frontmatter → 不动（不改用户已有的 frontmatter）
 *   - 空 frontmatter → 标签写进去，不另叠一个
 */
export function withDomainTag(content: string, slug: string, s: Settings): string {
  if (!s.frontmatter.enabled) return content;
  if (content.startsWith(EMPTY_FM)) {
    return `---\ntags: [${s.frontmatter.tagPrefix}${slug}]\n---\n${content.slice(EMPTY_FM.length)}`;
  }
  if (hasFrontmatter(content, s)) return content;
  return addTagsFrontmatter(content, slug, s);
}

/**
 * 其他插件自己的数据文件（Excalidraw 画板、Kanban 看板）：它们按自己的格式解析整个文件，
 * 往里追加区块或补 frontmatter 可能让插件读坏它。
 */
export function isPluginDataFile(rel: string, content: string): boolean {
  if (rel.endsWith(".excalidraw.md")) return true;
  const m = content.match(FM_RE);
  return m !== null && /^(?:excalidraw-plugin|kanban-plugin):/m.test(m[0]);
}

/**
 * 插入 SOURCE-LINK 区块：
 *   - 有 frontmatter -> 紧跟 frontmatter 之后
 *   - 否则 -> 首个标题行之后；再没有 -> 文件开头
 * 注意统一在前面多加一个 "\n"。
 */
export function insertSourceLink(content: string, line: string, s: Settings): string {
  const tag = s.daily.sourceBlockTag;
  const block = `<!-- ${tag}:START -->\n${line}\n<!-- ${tag}:END -->\n`;
  const fm = content.match(fmRe(s));
  let pos: number;
  if (fm) {
    pos = fm[0].length;
  } else {
    const h = /^#{1,6}\s/m.exec(content);
    if (h) {
      const e = content.indexOf("\n", h.index);
      pos = e === -1 ? content.length : e + 1;
    } else {
      return block + content; // 文件开头
    }
  }
  return content.slice(0, pos) + "\n" + block + content.slice(pos);
}

// ---------------------------------------------------------------- tag 提取（供 E2 实体来源）

export interface ParsedFrontmatter {
  present: boolean;
  /** 顺序去重后的 tag 列表（不含 #） */
  tags: string[];
}

/**
 * 容错解析 frontmatter 里的 tags：支持
 *   tags: [a, b]        /  tags: a, b
 *   tags:\n  - a\n  - b
 * 只做够用的解析，不引 YAML 依赖（保持零运行时依赖）。
 */
export function parseFrontmatterTags(content: string, key = "tags"): ParsedFrontmatter {
  const m = content.match(FM_RE);
  if (!m) return { present: false, tags: [] };
  const lines = m[0].split("\n");
  const tags: string[] = [];
  const push = (raw: string): void => {
    const t = raw.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").trim();
    if (t && !tags.includes(t)) tags.push(t);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mm = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
    if (!mm) continue;
    const rest = mm[1].trim();
    if (rest.startsWith("[")) {
      for (const part of rest.replace(/^\[/, "").replace(/\]$/, "").split(",")) push(part);
    } else if (rest) {
      for (const part of rest.split(",")) push(part);
    } else {
      // 块序列
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j];
        if (/^\s*-\s+/.test(sub)) push(sub.replace(/^\s*-\s+/, ""));
        else if (sub.trim() === "" || /^\s*#/.test(sub)) continue;
        else break;
      }
    }
  }
  return { present: true, tags };
}
