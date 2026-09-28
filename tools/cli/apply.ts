/**
 * apply.ts — 把 plan 落到磁盘（Node 侧）：写前内容比对、原子写、写后保护校验、必要时回滚
 *
 * "预览之后是否被外部改动"比对的是**内容**，不是 (mtime, size)：只动了时间戳的文件照常写入。
 */

import { dirname, join } from "node:path";
import type { PlanOutput } from "../../src/core/engine.ts";
import type { Settings } from "../../src/core/settings.ts";
import { protectionOk } from "../../src/core/verify.ts";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { withOriginalEol } from "../../src/core/text.ts";
import { readTextOrNull, writeTextAtomic } from "./vaultFs.ts";

export interface ApplyResult {
  written: string[];
  writtenMoc: string[];
  /** 移进 vault 的 .trash/ 的旧索引页（和 Obsidian「移到 .trash 文件夹」一样） */
  removedMoc: string[];
  skippedChanged: string[];
  protectionFailed: string[];
  protectionExternal: string[];
  restored: string[];
}

export function applyPlan(
  vaultRoot: string,
  plan: PlanOutput,
  s: Settings,
): ApplyResult {
  const res: ApplyResult = {
    written: [],
    writtenMoc: [],
    removedMoc: [],
    skippedChanged: [],
    protectionFailed: [],
    protectionExternal: [],
    restored: [],
  };

  const mocKeys = new Set(plan.mocChanges.keys());

  // ---- 写前二次校验：内容变了就跳过（不覆盖外部改动）
  const toWrite: string[] = [];
  for (const rel of plan.changedDocs) {
    const orig = plan.originals.get(rel);
    const now = readTextOrNull(join(vaultRoot, rel));
    if (!s.safety.skipIfChanged || now === orig) toWrite.push(rel);
    else res.skippedChanged.push(rel);
  }

  // ---- 写正文（按原文件的换行风格写回；原始字节留着回滚用）
  const raws = new Map<string, string>();
  for (const rel of toWrite) {
    const raw = readFileSync(join(vaultRoot, rel), "utf8");
    raws.set(rel, raw);
    writeTextAtomic(join(vaultRoot, rel), withOriginalEol(plan.writes.get(rel) as string, raw));
    res.written.push(rel);
  }

  // ---- 写 MOC
  for (const [mp, ch] of plan.mocChanges) {
    writeTextAtomic(join(vaultRoot, mp), ch.new);
    res.writtenMoc.push(mp);
  }

  // ---- 不再生成的旧索引页：计划之后被改过就不动
  for (const [mp, planned] of plan.mocRemovals) {
    if (readTextOrNull(join(vaultRoot, mp)) !== planned) continue;
    let dst = join(vaultRoot, ".trash", mp);
    for (let i = 2; existsSync(dst); i++) dst = join(vaultRoot, ".trash", mp.replace(/\.md$/, ` ${i}.md`));
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(join(vaultRoot, mp), dst);
    res.removedMoc.push(mp);
  }

  // ---- 写后保护校验（剥离托管区块后应与原文逐字节一致）
  if (s.safety.verifyStrippedBytes) {
    for (const rel of toWrite) {
      const orig = plan.originals.get(rel) as string;
      const now = readTextOrNull(join(vaultRoot, rel));
      if (now === null) continue;
      if (protectionOk(orig, now, s)) continue;
      // 我们写完又被外部改了？→ 保留现场；否则是我们自己的问题 → 恢复
      const expected = plan.writes.get(rel);
      if (now !== expected) {
        res.protectionExternal.push(rel);
      } else {
        res.protectionFailed.push(rel);
        writeTextAtomic(join(vaultRoot, rel), raws.get(rel) as string);
        res.restored.push(rel);
      }
    }
  }

  void mocKeys;
  return res;
}
