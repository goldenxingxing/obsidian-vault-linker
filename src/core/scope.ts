/**
 * scope.ts — 扫描范围：目录剪枝、排除规则、通配匹配
 *
 * 规则：
 *   - 顶层目录名命中 excludeTopDirs → 整棵剪掉（只看第一级目录）
 *   - 任意层级的 . 开头目录 / excludeAnyDirs（默认 node_modules）→ 剪掉
 *   - 只有 .md 参与
 *
 * 一个需要说明的行为：excluded 计数器**恒为 0** ——
 * 因为目录剪枝的条件与文件排除的条件是同一套，凡是能被访问到的文件都不满足排除条件。
 * 只有配置了 excludeGlobs 时该计数才会有值。
 */

import { pySort } from "./pycompat.ts";
import { detectDomainsFromDirs, type Settings } from "./settings.ts";
import { safeDirPath } from "./moc.ts";

export interface ScanResult {
  /** 在范围 .md（已按 code point 排序） */
  inScope: string[];
  excludedCount: number;
}

/** 通配匹配：* 不跨 /，** 跨 /；不含通配符时按"目录前缀"匹配 */
export function globMatch(pattern: string, rel: string): boolean {
  if (pattern === "") return false;
  if (!/[*?]/.test(pattern)) return rel === pattern || rel.startsWith(pattern + "/");
  return globToRegExp(pattern).test(rel);
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

function isDotDir(name: string, s: Settings): boolean {
  return s.scan.excludeHidden && name.startsWith(".");
}

/**
 * 是否在索引页目录里。生成的索引页不是笔记：若被扫描进来，会被追加区块、
 * 又在下次生成时被整页覆盖，永远收敛不了，还会出现在别的笔记的「相关文档」里。
 * 默认的 `_moc` 本就在 excludeTopDirs 里；这里保证改了目录名之后依然排除。
 */
function inMocFolder(rel: string, s: Settings): boolean {
  if (!s.moc.enabled) return false;
  const dir = safeDirPath(s.moc.folder);
  return rel === dir || rel.startsWith(dir + "/");
}

/** 目录是否应被剪枝 */
export function isPrunedDir(dirRel: string, s: Settings): boolean {
  const parts = dirRel.split("/");
  if (s.scan.excludeTopDirs.includes(parts[0])) return true;
  if (inMocFolder(dirRel, s)) return true;
  return parts.some((p) => isDotDir(p, s) || s.scan.excludeAnyDirs.includes(p));
}

/** 文件级排除 */
export function isExcludedFile(rel: string, s: Settings): boolean {
  const parts = rel.split("/");
  for (const p of parts.slice(0, -1)) {
    if (isDotDir(p, s) || s.scan.excludeAnyDirs.includes(p)) return true;
  }
  if (s.scan.excludeTopDirs.includes(parts[0])) return true;
  for (const g of s.scan.excludeGlobs) if (globMatch(g, rel)) return true;
  return false;
}

/**
 * 给定 vault 内**全部文件路径**，算出逐层遍历目录时会得到的结果。
 * 纯函数，便于在 Node 里对副本 vault 复跑。
 */
export function collectInScope(allFiles: readonly string[], s: Settings): ScanResult {
  const inScope: string[] = [];
  let excludedCount = 0;
  for (const f of allFiles) {
    if (!f.endsWith(".md")) continue;
    const parts = f.split("/");
    const ancestors = parts.slice(0, -1);
    const pruned =
      s.scan.excludeTopDirs.includes(parts[0]) ||
      inMocFolder(f, s) ||
      ancestors.some((p) => isDotDir(p, s) || s.scan.excludeAnyDirs.includes(p));
    if (pruned) continue; // 遍历时根本不会进到这里
    if (isExcludedFile(f, s)) excludedCount++;
    else inScope.push(f);
  }
  return { inScope: pySort(inScope), excludedCount };
}

/** 顶层目录名列表（供首次运行向导自动探测领域用） */
export function topLevelDirs(allFiles: readonly string[]): string[] {
  const set = new Set<string>();
  for (const f of allFiles) {
    const i = f.indexOf("/");
    if (i > 0) set.add(f.slice(0, i));
  }
  return pySort([...set]);
}

/**
 * 首次运行（domains 为空）时按顶层目录自动生成领域规则。
 * 设置页上写着「留空则首次运行时按顶层目录自动探测」——这就是那个实现。
 * 返回是否发生了变更（调用方据此决定要不要落盘 + 提示用户）。
 */
export function ensureDomains(s: Settings, allFiles: readonly string[]): boolean {
  if (s.domains.length > 0) return false;
  // 只看有在范围笔记的目录：只放图片、附件的目录不该变成一个空索引页
  const detected = detectDomainsFromDirs(topLevelDirs(collectInScope(allFiles, s).inScope));
  if (detected.length === 0) return false;
  s.domains = detected;
  return true;
}

/**
 * 从 Obsidian 配置里找出模板所在：核心「模板」插件的目录、Templater 的目录、日记模板文件。
 * `read` 读 vault 内相对路径（读不到返回 null）；configDir 通常是 `.obsidian`。
 * 返回的是相对 vault 根的目录或文件路径（文件带 .md）。
 */
export function templatePaths(read: (rel: string) => string | null, configDir: string): string[] {
  const out: string[] = [];
  const field = (rel: string, key: string): string | null => {
    const raw = read(`${configDir}/${rel}`);
    if (raw === null) return null;
    try {
      const v = (JSON.parse(raw) as Record<string, unknown>)[key];
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const clean = (p: string): string => p.split("/").filter((x) => x !== "" && x !== "." && x !== "..").join("/");
  for (const [rel, key, isFile] of [
    ["templates.json", "folder", false],
    ["plugins/templater-obsidian/data.json", "templates_folder", false],
    ["daily-notes.json", "template", true],
  ] as const) {
    const v = field(rel, key);
    if (!v) continue;
    const p = clean(v);
    if (p === "") continue;
    out.push(isFile && !p.endsWith(".md") ? p + ".md" : p);
  }
  return [...new Set(out)];
}

/** 本次运行实际生效的配置：在用户配置之上加上运行时探测到的排除项（不落盘） */
export function withRuntimeExcludes(s: Settings, templates: readonly string[]): Settings {
  if (!s.scan.excludeTemplates || templates.length === 0) return s;
  return { ...s, scan: { ...s.scan, excludeGlobs: [...s.scan.excludeGlobs, ...templates] } };
}
