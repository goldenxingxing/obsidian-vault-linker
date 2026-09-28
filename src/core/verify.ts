/**
 * verify.ts — 写后内容保护校验 + 链接有效性检查
 */

import { managedBlockSpans } from "./blocks.ts";
import { safeDirPath } from "./moc.ts";
import { stripAllBlocks } from "./blocks.ts";
import { pySort } from "./pycompat.ts";
import type { Settings } from "./settings.ts";

export interface BrokenLinks {
  brokenManaged: Array<[string, string]>;
  brokenPreexist: Array<[string, string]>;
}

/** 链接有效性判定 */
function linkOk(target: string, fileSet: ReadonlySet<string>, basenameSet: ReadonlySet<string>): boolean {
  if (fileSet.has(target) || fileSet.has(target + ".md")) return true;
  if (!target.includes("/")) return basenameSet.has(target + ".md");
  return false;
}

const LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export function checkLinks(
  rels: readonly string[],
  mocKeys: readonly string[],
  contentsAfter: ReadonlyMap<string, string>,
  allFiles: readonly string[],
  s: Settings,
): BrokenLinks {
  const fileSet = new Set<string>(allFiles);
  for (const k of mocKeys) fileSet.add(k);

  const basenameSet = new Set<string>();
  for (const rel of rels) basenameSet.add(rel.slice(rel.lastIndexOf("/") + 1));
  for (const k of mocKeys) basenameSet.add(k.slice(k.lastIndexOf("/") + 1));

  const brokenManaged: Array<[string, string]> = [];
  const brokenPreexist: Array<[string, string]> = [];
  const mocPrefix = safeDirPath(s.moc.folder) + "/";

  for (const rel of [...rels, ...pySort([...mocKeys])]) {
    const c = contentsAfter.get(rel);
    if (c === undefined) continue;
    const spans = managedBlockSpans(c, s);
    const inMoc = rel.startsWith(mocPrefix);
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(c)) !== null) {
      const target = m[1].trim();
      if (linkOk(target, fileSet, basenameSet)) continue;
      const managed = inMoc || spans.some(([a, b]) => m !== null && a <= m.index && m.index < b);
      (managed ? brokenManaged : brokenPreexist).push([rel, target]);
    }
  }
  return { brokenManaged, brokenPreexist };
}

/**
 * 写后保护校验：剥离全部托管区块后，当前内容应与原文逐字节一致。
 *
 * 原文不以换行结尾时，追加区块用 "\n\n" 粘合，而剥离只能吃掉一个 "\n"，剥离后比原文
 * 多一个结尾换行。这是预期内的变更，校验时照此补上；否则这类笔记每次都被判失败、回滚，
 * 永远拿不到区块。
 */
export function protectionOk(
  original: string,
  current: string,
  s: Settings,
): boolean {
  const nowStripped = stripAllBlocks(current, s);
  let expected = stripAllBlocks(original, s);
  if (expected !== "" && !expected.endsWith("\n")) {
    expected += "\n";
  }
  return nowStripped === expected;
}
