/**
 * daily.ts — 日报 ↔ 产出 双向追溯
 *
 * 通用化：日报目录前缀、文件名正则、产出路径前缀、允许的扩展名全部可配；
 * 默认**关闭**（别的 vault 没有这套目录约定）。
 */

import { PY_WS_CLASS, pyBasename, pyReEscape, pySort, pyStrip } from "./pycompat.ts";
import type { Settings } from "./settings.ts";

export interface Deliverables {
  existing: string[];
  missing: string[];
}

/** 剥掉结尾的中英文标点 */
const TRAILING_PUNCT_RE = /[.,;:!?，。；：、）)\]}」』"']+$/g;
const TRAILING_LINE_NO_RE = /:\d+$/g;

/**
 * 把一段候选文本规范化为 vault 相对路径；不合格返回 null。
 * 剥反引号/尾标点/`:行号`、剥绝对路径前缀与配置的路径前缀、
 * 拒绝 vault 外绝对路径、拒绝裸文件名、拒绝含 `..`、校验扩展名白名单。
 */
export function normalizeCandidate(raw: string, s: Settings, vaultAbsPath?: string): string | null {
  let t = pyStrip(raw);
  t = pyStrip(t.replace(/^`+/, "").replace(/`+$/, ""));
  t = t.replace(TRAILING_PUNCT_RE, "");
  t = t.replace(TRAILING_LINE_NO_RE, "");
  if (vaultAbsPath) {
    const abs = vaultAbsPath.endsWith("/") ? vaultAbsPath : vaultAbsPath + "/";
    if (t.startsWith(abs)) t = t.slice(abs.length);
    else if (t.startsWith("/")) return null;
  } else if (t.startsWith("/")) {
    return null;
  }
  for (const p of s.daily.stripPathPrefixes) {
    if (p && t.startsWith(p)) {
      t = t.slice(p.length);
      break;
    }
  }
  if (!t || t.startsWith("/") || t.split("/").includes("..")) return null;
  if (!t.includes("/")) return null; // 裸文件名不算路径引用
  const base = pyBasename(t);
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  if (!s.daily.allowedExtensions.includes(ext)) return null;
  return t;
}

/** 从日报正文抽取产出引用，并按"文件是否存在"分成 existing / missing */
export function extractDeliverables(
  content: string,
  allFiles: ReadonlySet<string>,
  s: Settings,
  vaultAbsPath?: string,
): Deliverables {
  const cands = new Set<string>();

  if (s.daily.scanBackticks) {
    for (const m of content.matchAll(/`([^`\n]+)`/g)) {
      const t = normalizeCandidate(m[1], s, vaultAbsPath);
      if (t) cands.add(t);
    }
  }

  if (s.daily.scanBarePaths && s.daily.barePathPrefixes.length > 0) {
    const alt = s.daily.barePathPrefixes.map(pyReEscape).join("|");
    const re = new RegExp(`(?:${alt})[^${PY_WS_CLASS}\`，。；、）)」』"']+`, "g");
    for (const m of content.matchAll(re)) {
      const t = normalizeCandidate(m[0], s, vaultAbsPath);
      if (t) cands.add(t);
    }
  }

  const existing: string[] = [];
  const missing: string[] = [];
  for (const t of pySort([...cands])) {
    if (allFiles.has(t)) existing.push(t);
    else missing.push(t);
  }
  return { existing, missing };
}
