/**
 * moc.ts — MOC 枢纽页与导航主页生成
 */

import { DEFAULT_MOC_FOLDER, textsFor, type DomainRule, type Settings } from "./settings.ts";
import { fillTemplate, wikilink, wikilinkT, dedupeDisplays, collapseDisplays } from "./text.ts";
import { pySort } from "./pycompat.ts";

/**
 * 把配置里的名字压成**单层**文件名：配置可以被用户手改，也可以从别人分享的
 * JSON 导入，因此不能直接拼进写盘路径（`../` 会逃出 MOC 目录）。
 * 只做安全化，不改变正常名字（ASCII/中文/空格/连字符原样保留）。
 */
export function safeFileName(name: string): string {
  // 分隔符压平 → 保证只是一层文件名；去掉开头点 → 不生成隐藏文件（隐藏文件在 Obsidian 里默认不显示）
  const cleaned = name.replace(/[\\/]/g, "-").trim().replace(/^\.+/, "");
  return cleaned === "" ? "_" : cleaned;
}

/** 把配置里的目录压成安全的相对目录：丢掉空段、`.` 与 `..` 段 */
export function safeDirPath(dir: string): string {
  const parts = dir.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  return parts.length > 0 ? parts.join("/") : DEFAULT_MOC_FOLDER;
}

/**
 * 目标 MOC 路径是否已被「不是本插件生成的」文件占用。
 *
 * 为什么需要：MOC 是整文件覆盖写入的。如果用户自己的 `_moc/Home.md`（同名但内容是自己的）
 * 被无条件覆盖，就是**数据丢失**——对第一次装插件的人来说尤其不可接受。
 *
 * 判据：文件已存在，且缺少我们生成时写下的标记——frontmatter 的 `type: moc`，以及
 * 标题下那行「本页由 … 自动生成」说明（当前文案，或中/英内置文案）。只看 `tags: [moc]`
 * 不够：很多人自己的索引页就是这么打标签的。
 * 命中则**不写**，只在运行报告里列出来（宁可少建一个索引页，不可覆盖别人的文件）。
 * 用户改过「自动生成」说明的文案后，旧页面会被当成别人的文件跳过——偏向安全的一侧。
 *
 * 注意：这是**写前检查**，不影响任何输出字节。
 */
export function isForeignMoc(path: string, existing: ReadonlyMap<string, string>, s: Settings): boolean {
  const cur = existing.get(path);
  if (cur === undefined) return false; // 不存在 → 可以新建
  if (!/^type:\s*moc\s*$/m.test(cur)) return true;
  const notes = [s.texts, textsFor("zh"), textsFor("en")].flatMap((t) => [
    t.mocGeneratedNote,
    t.homeGeneratedNote.split("{date}")[0],
  ]).filter((n) => n.trim() !== "");
  const lines = cur.split("\n");
  return !notes.some((n) => lines.some((l) => l.startsWith(n)));
}

/** domains[] + fallbackDomain（按 id 去重，fallback 在最后） */
export function allDomains(s: Settings): DomainRule[] {
  const seen = new Set<string>();
  const out: DomainRule[] = [];
  for (const d of [...s.domains, s.fallbackDomain]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

export function mocPath(domain: DomainRule, s: Settings): string {
  return `${safeDirPath(s.moc.folder)}/${safeFileName(domain.name)}.md`;
}

export function homePath(s: Settings): string {
  return `${safeDirPath(s.moc.folder)}/${safeFileName(s.moc.homeFile)}.md`;
}

export interface MocInputs {
  titles: ReadonlyMap<string, string>;
  summaries: ReadonlyMap<string, string>;
  today: string;
  /** 链接目标缩短表（text.ts shortestTargets）：条目链接写最短唯一目标 */
  targets?: ReadonlyMap<string, string>;
}

/** 索引页的一条：带摘要用 mocEntryLine，关掉摘要时只列链接 */
function entryLine(link: string, rel: string, summaries: ReadonlyMap<string, string>, s: Settings): string {
  if (!s.moc.includeSummary) return fillTemplate(s.texts.relatedEntryLine, { link });
  return fillTemplate(s.texts.mocEntryLine, { link, summary: summaries.get(rel) ?? s.texts.noSummary });
}

export function buildMoc(
  domain: DomainRule,
  rels: readonly string[],
  input: MocInputs,
  s: Settings,
): string {
  const { titles, summaries, today } = input;
  const lines: string[] = [
    "---",
    "tags: [moc]",
    "type: moc",
    "domain: " + domain.name,
    "date: " + today,
    "---",
    "",
    s.texts.mocTitlePrefix + domain.name,
    "",
    s.texts.mocGeneratedNote,
    "",
  ];

  // 直接放在领域文件夹里的笔记在前，子文件夹各成一节（更深的层级归到所在的一级子文件夹）
  const groups = new Map<string, string[]>();
  for (const rel of rels) {
    const g = subfolderOf(rel, domain);
    const list = groups.get(g);
    if (list) list.push(rel);
    else groups.set(g, [rel]);
  }
  // 小节内部撞显示名的（比如两篇 H1 相同的日报）加最短可区分后缀；
  // 后缀与缩短后的链接目标重复时再去掉（日期/路径在目标里已自带）
  const line = (rel: string, displays: ReadonlyMap<string, string>): string =>
    entryLine(wikilinkT(input.targets?.get(rel) ?? rel.replace(/\.md$/, ""), displays.get(rel)), rel, summaries, s);
  const collapse = (list: readonly string[], displays: Map<string, string>): Map<string, string> =>
    collapseDisplays(list, displays, input.targets ?? new Map());
  const rootList = groups.get("") ?? [];
  const rootDisplays = collapse(rootList, dedupeDisplays(rootList, (r) => titles.get(r) ?? ""));
  for (const rel of rootList) lines.push(line(rel, rootDisplays));
  if (groups.has("")) lines.push("");
  for (const g of pySort([...groups.keys()].filter((k) => k !== ""))) {
    const list = groups.get(g) as string[];
    const displays = collapse(list, dedupeDisplays(list, (r) => titles.get(r) ?? ""));
    lines.push("## " + g, "");
    for (const rel of list) lines.push(line(rel, displays));
    lines.push("");
  }
  if (groups.size === 0) lines.push("");

  return lines.join("\n");
}

/**
 * 笔记在索引页里归到哪个小节：领域文件夹下的一级子文件夹名；直接在领域文件夹里则为 ""。
 * 兜底领域（没有文件夹）按笔记所在的顶层文件夹分；通配规则匹配到的不分节。
 */
export function subfolderOf(rel: string, domain: DomainRule): string {
  for (const p of domain.paths) {
    if (/[*?]/.test(p)) continue;
    const base = p.replace(/\/+$/, "");
    if (!rel.startsWith(base + "/")) continue;
    const rest = rel.slice(base.length + 1);
    const i = rest.indexOf("/");
    return i > 0 ? rest.slice(0, i) : "";
  }
  if (domain.paths.length > 0) return "";
  const i = rel.indexOf("/");
  return i > 0 ? rel.slice(0, i) : "";
}

export function buildHome(domainCounts: ReadonlyMap<string, number>, today: string, s: Settings): string {
  let total = 0;
  for (const n of domainCounts.values()) total += n;
  const lines: string[] = [
    "---",
    "tags: [moc]",
    "type: moc",
    "domain: index",
    "date: " + today,
    "---",
    "",
    s.texts.homeTitle,
    "",
    fillTemplate(s.texts.homeGeneratedNote, { date: today }),
    "",
    s.texts.homeSectionTitle,
    "",
  ];
  for (const d of allDomains(s)) {
    lines.push(fillTemplate(s.texts.homeDomainLine, {
      link: wikilink(mocPath(d, s), d.name),
      name: d.name,
      count: String(domainCounts.get(d.id) ?? 0),
    }));
  }
  lines.push("");
  lines.push(fillTemplate(s.texts.homeTotalLine, {
    total: String(total),
    excluded: s.moc.excludedNote,
  }));
  lines.push("");
  return lines.join("\n");
}
