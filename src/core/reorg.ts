/**
 * reorg.ts — 整理检测：用户移动/重命名了文件夹之后，找出配置与现实的脱节点
 *
 * 背景与边界：
 *   - domains 为空（默认）时每个领域都是运行时按顶层目录现推的（见 runner.planVault /
 *     cli 的 ensureDomains），整理文件夹天然自愈，本模块返回空——不制造噪音。
 *   - domains 非空（用户自定义过、或从旧版/分享的配置导入）时，paths 是**首跑快照**：
 *     文件夹改名后旧路径匹配不到任何文件（死路径），新目录的笔记掉进兜底领域（孤儿目录）。
 *     本模块把两者找出来，配合 rename 事件证据（Obsidian 里整理时攒下的 old→new 路径对）
 *     配成「把领域 X 的路径 A 改成 B」的建议——只产出建议，写回配置由 UI 确认后调用
 *     applySuggestions（插件的性格：预览 → 确认 → 写入）。
 *
 * 在 Obsidian 之外的整理（AI agent、脚本、同步工具）没有 rename 事件，但死路径/孤儿目录
 * 的判定只依赖全量文件列表，照常成立；只是 rename 建议退化为「死路径 + 孤儿」两条信息，
 * 由用户在界面上自行决定怎么改。
 *
 * 纯函数、零 IO、零 Obsidian 依赖，node --test 直接可测。
 */

import { classify } from "./classify.ts";
import { collectInScope, globMatch } from "./scope.ts";
import { newDomain, type DomainRule, type Settings } from "./settings.ts";
import { pySort } from "./pycompat.ts";

/** 一次文件（或文件夹）重命名：vault 相对路径，rename 事件给的 oldPath → 新路径 */
export interface RenameEvidence {
  old: string;
  new: string;
}

export type DriftSuggestionKind = "rename" | "dead" | "orphan";

/**
 * 一条整理建议。
 *   rename —— 领域 domainId 的路径 oldPath 已无文件，rename 证据显示它现在叫 newPath
 *   dead    —— 领域 domainId 的路径 oldPath 已无文件，且没有证据能配出替代路径
 *   orphan  —— 顶层目录 dir 里有在范围笔记但没被任何领域映射（新建的目录 / 挪过来的目录）
 */
export interface DriftSuggestion {
  kind: DriftSuggestionKind;
  domainId: string | null;
  domainName: string | null;
  oldPath: string | null;
  newPath: string | null;
  dir: string | null;
  /** 该顶层目录下的在范围笔记数（rename/dead 是受影响笔记数，orphan 是孤儿数） */
  count: number;
}

export interface PathDrift {
  suggestions: DriftSuggestion[];
  /** 已被 rename 建议覆盖、不再单独重复出现的死路径与孤儿目录（报告用） */
  resolvedDeadPaths: string[];
  resolvedOrphanDirs: string[];
}

/** 某个领域路径（可含通配）在当前 vault 里是否还匹配得到文件 */
export function pathIsAlive(p: string, allFiles: readonly string[]): boolean {
  // globMatch 对不含通配符的模式按「路径前缀」匹配，正好覆盖普通目录路径
  return allFiles.some((f) => globMatch(p, f));
}

/** 文件的所在目录（去掉最后一段；根目录文件返回 ""） */
function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/**
 * 把文件级的 rename 证据聚合成目录级：old 目录 → 出现次数最多的 new 目录。
 * 文件自身的改名（所在目录没变）对领域映射没有影响，过滤掉。
 */
export function aggregateDirRenames(
  evidence: readonly RenameEvidence[],
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const e of evidence) {
    const oldDir = dirOf(e.old);
    const newDir = dirOf(e.new);
    if (oldDir === newDir || oldDir === "") continue;
    let m = counts.get(oldDir);
    if (!m) {
      m = new Map();
      counts.set(oldDir, m);
    }
    m.set(newDir, (m.get(newDir) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [oldDir, m] of counts) {
    let best = "";
    let bestN = -1;
    for (const [nd, n] of m) {
      if (n > bestN || (n === bestN && nd < best)) {
        best = nd;
        bestN = n;
      }
    }
    out.set(oldDir, best);
  }
  return out;
}

/**
 * 检测整理漂移。evidence 可为空（Obsidian 之外的整理没有事件）。
 * 注意 s 应传**用户保存的**配置（不是 ensureDomains 过的副本）：
 * domains 为空说明用户在用自动模式，无漂移可言。
 */
export function detectPathDrift(
  allFiles: readonly string[],
  s: Settings,
  evidence: readonly RenameEvidence[] = [],
): PathDrift {
  const empty: PathDrift = { suggestions: [], resolvedDeadPaths: [], resolvedOrphanDirs: [] };
  if (s.domains.length === 0) return empty; // 自动模式：领域每轮现推，自愈

  // ---- 死路径：领域里已匹配不到任何文件的路径
  const dead: Array<{ domain: DomainRule; path: string }> = [];
  for (const d of s.domains) {
    for (const p of d.paths) {
      if (!pathIsAlive(p, allFiles)) dead.push({ domain: d, path: p });
    }
  }

  // ---- 孤儿目录：有在范围笔记、却未被任何领域映射的顶层目录
  const orphanCount = new Map<string, number>();
  for (const rel of collectInScope(allFiles, s).inScope) {
    if (!classify(rel, s).unmapped) continue;
    const top = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : rel;
    orphanCount.set(top, (orphanCount.get(top) ?? 0) + 1);
  }

  // ---- rename 证据配对：死路径 === 证据里的旧目录 → 建议改成（多数票的）新目录
  const dirRenames = aggregateDirRenames(evidence);
  const suggestions: DriftSuggestion[] = [];
  const resolvedDead = new Set<string>();
  const resolvedOrphans = new Set<string>();
  for (const { domain, path } of dead) {
    const evidenceNew = dirRenames.get(path);
    if (evidenceNew !== undefined) {
      suggestions.push({
        kind: "rename",
        domainId: domain.id,
        domainName: domain.name,
        oldPath: path,
        newPath: evidenceNew,
        dir: null,
        // 受影响的是「现在归在新目录下」的笔记数
        count: allFiles.filter((f) => globMatch(evidenceNew, f) && f.endsWith(".md")).length,
      });
      resolvedDead.add(path);
      resolvedOrphans.add(evidenceNew.split("/")[0]);
    }
  }

  // ---- 没配上对的死路径：信息性列出（count = 0，因为这个路径下已经一篇笔记都没有了）
  for (const { domain, path } of dead) {
    if (resolvedDead.has(path)) continue;
    suggestions.push({
      kind: "dead",
      domainId: domain.id,
      domainName: domain.name,
      oldPath: path,
      newPath: null,
      dir: null,
      count: 0,
    });
    resolvedDead.add(path);
  }

  // ---- 没被 rename 建议覆盖的孤儿目录：建议建新领域（或由用户自行映射到现有领域）
  for (const dir of pySort([...orphanCount.keys()])) {
    if (resolvedOrphans.has(dir)) continue;
    suggestions.push({
      kind: "orphan",
      domainId: null,
      domainName: null,
      oldPath: null,
      newPath: null,
      dir,
      count: orphanCount.get(dir) ?? 0,
    });
  }

  return {
    suggestions,
    resolvedDeadPaths: pySort([...resolvedDead]),
    resolvedOrphanDirs: pySort([...resolvedOrphans]),
  };
}

/**
 * 应用建议（UI 上逐条或全部确认后调用）。原地修改 s，返回应用了几条。
 * 幂等：建议对应的路径已不在领域里 / 目录已有领域时，该条跳过不计数。
 */
export function applySuggestions(s: Settings, picks: readonly DriftSuggestion[]): number {
  let n = 0;
  for (const pick of picks) {
    if (pick.kind === "orphan") {
      const dir = pick.dir;
      if (dir === null) continue;
      if (s.domains.some((d) => d.paths.some((p) => globMatch(p, dir + "/x.md")))) continue;
      s.domains.push(newDomain(dir, [dir], [...s.domains, s.fallbackDomain]));
      n++;
      continue;
    }
    const domain = s.domains.find((d) => d.id === pick.domainId);
    const oldPath = pick.oldPath;
    if (!domain || oldPath === null) continue;
    if (pick.kind === "rename" && pick.newPath !== null) {
      if (!domain.paths.includes(oldPath)) continue; // 已应用过（幂等）
      domain.paths = domain.paths.map((p) => (p === oldPath ? (pick.newPath as string) : p));
      n++;
      continue;
    }
    // dead：从领域里移除这条已无文件的路径
    const before = domain.paths.length;
    domain.paths = domain.paths.filter((p) => p !== oldPath);
    if (domain.paths.length !== before) n++;
  }
  return n;
}
