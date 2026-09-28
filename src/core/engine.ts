/**
 * engine.ts — 编排：plan → (由 adapter 执行 apply) → verify
 *
 * 纯函数：输入"文件集合 + 内容"，输出"要写什么 + 运行报告"，不碰任何 IO。
 * 这样同一套引擎可以：
 *   ① 在 Node 里对 vault 副本跑（测试、调试）
 *   ② 被 Obsidian 插件调用（写盘走 vault.process）
 *   ③ 被 CLI 调用（Obsidian 没开时的兜底）

 */

import type { DomainRule, Settings } from "./settings.ts";
import { pySort } from "./pycompat.ts";
import { classify } from "./classify.ts";
import { collectInScope } from "./scope.ts";
import { titleOf, summaryOf, wikilink, fillTemplate } from "./text.ts";
import { appendEndBlock, blockSeparator, stripAllBlocks } from "./blocks.ts";
import { isOptedOut, isPluginDataFile } from "./frontmatter.ts";
import { buildEntityMatchers, entitiesOf, entitySourceDoc, entityText, type EntityMatcher } from "./entities.ts";
import { EntityIndex } from "./multimatch.ts";
import { buildPostings, computeDf, linkTargets, weightMap } from "./score.ts";
import { allDomains, buildHome, buildMoc, homePath, isForeignMoc, mocPath } from "./moc.ts";
import { checkLinks } from "./verify.ts";

export interface EngineInput {
  settings: Settings;
  /** YYYY-MM-DD（本地日期；注入以保证可复跑） */
  today: string;
  /** vault 内全部文件（相对路径，含非 md） */
  allFiles: readonly string[];
  /** 在范围 md 的文本内容（已按 UTF-8 解码并做通用换行归一） */
  contents: ReadonlyMap<string, string>;
  /** 非 UTF-8 被跳过的 md */
  skippedBinary?: readonly string[];
  /** 被排除的 md 计数 */
  excludedCount?: number;
  /** 当前 _moc/*.md 的内容（这些文件在扫描范围之外，需单独读取） */
  mocContents?: ReadonlyMap<string, string>;
}

export interface EntityUsage {
  term: string;
  source: EntityMatcher["source"];
  /** 出现在多少篇文档里 */
  df: number;
}

export interface RunReport {
  scanned: number;
  excluded: number;
  skippedBinary: number;
  domains: Array<{ id: string; name: string; count: number }>;
  plannedChanges: number;
  mocPlanned: number;
  /** 目标路径被非本插件文件占用、因而**未写入**的 MOC（保护用户自己的同名文件） */
  mocConflicts: string[];
  /** 本插件以前生成、这次不再生成的索引页（文件夹删了或改名了）：移到回收站 */
  mocStale: string[];
  autoLinkTotal: number;
  warnings: string[];
  unmappedFiles: string[];
  brokenManaged: Array<[string, string]>;
  brokenPreexist: Array<[string, string]>;
  entityUsage: EntityUsage[];
  /** 从未命中的词表项（清理用） */
  unusedEntities: string[];
  /** 命中过泛的词（>80% 文档命中，建议加停用词） */
  tooBroadEntities: string[];
}

export interface PlanOutput {
  report: RunReport;
  rels: string[];
  domainById: Map<string, DomainRule>;
  domains: Map<string, string>;
  changedDocs: string[];
  mocChanges: Map<string, { old: string | null; new: string }>;
  /** 要移到回收站的旧索引页 → 计划时的内容（执行前据此确认没被改过） */
  mocRemovals: Map<string, string>;
  /** 待写入：正文变更 + MOC 变更 */
  writes: Map<string, string>;
  /** 写前原文（仅正文） */
  originals: Map<string, string>;
  /** 全部正文的最终内容（含未变更者，供校验用） */
  newContents: Map<string, string>;
  matchers: EntityMatcher[];
}

/** 实体数超过它才用 EntityIndex（实测 41 个实体时逐个正则更快，681 个时慢 5 倍） */
const ENTITY_INDEX_MIN = 64;

/** 每处理这么多篇让出一次（异步版本里把主线程还给 Obsidian，界面不冻住） */
const YIELD_EVERY = 200;

/** 同步跑完（CLI、测试用） */
export function planRun(input: EngineInput): PlanOutput {
  const it = planSteps(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** 异步跑：每处理 YIELD_EVERY 篇让出一次主线程。结果与 planRun 完全相同 */
export async function planRunAsync(input: EngineInput): Promise<PlanOutput> {
  const it = planSteps(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** 引擎本体：生成器，在耗时的逐篇循环里 yield（不改变任何计算） */
function* planSteps(input: EngineInput): Generator<void, PlanOutput, void> {
  const s = input.settings;
  // 其他插件的数据文件（Excalidraw、Kanban）不当笔记处理：不写入，也不参与互链
  const pluginFiles = s.scan.skipPluginFiles
    ? [...input.contents].filter(([rel, c]) => isPluginDataFile(rel, c)).map(([rel]) => rel)
    : [];
  const skip = new Set(pluginFiles);
  const rels = pySort([...input.contents.keys()].filter((rel) => !skip.has(rel)));
  const warnings: string[] = [];

  // ---- F1 领域归类
  const domains = new Map<string, string>();
  const unmappedFiles: string[] = [];
  for (const rel of rels) {
    const r = classify(rel, s);
    domains.set(rel, r.domainId);
    if (r.unmapped) unmappedFiles.push(rel);
  }
  for (const rel of unmappedFiles) warnings.push(fillTemplate(s.texts.unmappedWarning, { rel }));

  const domainById = new Map<string, DomainRule>();
  for (const d of allDomains(s)) domainById.set(d.id, d);

  // ---- 标题 / 摘要
  const titles = new Map<string, string>();
  const summaries = new Map<string, string>();
  for (const rel of rels) {
    const c = input.contents.get(rel) as string;
    titles.set(rel, titleOf(c, rel, s));
    summaries.set(rel, summaryOf(c, s));
  }

  // ---- F3 实体与互链打分
  const srcDocs = rels.map((rel) =>
    entitySourceDoc(rel, input.contents.get(rel) as string, titles.get(rel) as string),
  );
  const matchers = buildEntityMatchers(s, srcDocs);
  const weights = weightMap(matchers);
  // 实体多时一次扫描匹配全部实体（结果与逐个正则相同，见 multimatch.ts）；
  // 只有几十个时逐个正则更快
  const index = matchers.length > ENTITY_INDEX_MIN ? new EntityIndex(matchers) : null;
  const docEntities = new Map<string, Set<string>>();
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    const c = input.contents.get(rel) as string;
    docEntities.set(rel, index ? index.hits(entityText(c, s)) : entitiesOf(c, matchers, s));
    if (i % YIELD_EVERY === YIELD_EVERY - 1) yield;
  }
  const df = computeDf(docEntities);
  const postings = buildPostings(docEntities);
  const autolinks = new Map<string, string[]>();
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i];
    autolinks.set(rel, linkTargets(rel, rels, docEntities, domains, df, weights, s, postings));
    if (i % YIELD_EVERY === YIELD_EVERY - 1) yield;
  }

  const fileSet = new Set(input.allFiles);

  // ---- 逐篇改写：剥掉旧区块，按需追加「相关笔记」区块
  const transform = (rel: string, c: string): string => {
    if (isOptedOut(c, s)) return c;
    const out = stripAllBlocks(c, s);
    const sep = blockSeparator(out, s);

    if (!s.related.enabled) return out;
    const dom = domainById.get(domains.get(rel) as string) as DomainRule;
    let body = s.texts.relatedHeading + "\n\n";
    // 关掉索引页时不链过去：那一页不会生成，链接会失效
    if (s.moc.enabled) body += fillTemplate(s.texts.relatedNavLine, { link: wikilink(mocPath(dom, s)) }) + "\n";
    for (const t of autolinks.get(rel) as string[]) {
      body += fillTemplate(s.texts.relatedEntryLine, { link: wikilink(t, titles.get(t)) }) + "\n";
    }
    return appendEndBlock(out, s.related.blockTag, body, sep);
  };

  const newContents = new Map<string, string>();
  const changedDocs: string[] = [];
  let autoLinkTotal = 0;
  for (const rel of rels) {
    const orig = input.contents.get(rel) as string;
    const out = transform(rel, orig);
    newContents.set(rel, out);
    if (out !== orig) changedDocs.push(rel);
    autoLinkTotal += (autolinks.get(rel) as string[]).length;
  }

  // ---- F2 MOC
  const domainRels = new Map<string, string[]>();
  for (const d of allDomains(s)) domainRels.set(d.id, []);
  for (const rel of rels) (domainRels.get(domains.get(rel) as string) as string[]).push(rel);

  const domainCounts = new Map<string, number>();
  const mocFiles = new Map<string, string>();
  const mocReport: Array<{ id: string; name: string; count: number }> = [];
  const prevMoc = input.mocContents ?? new Map<string, string>();
  const mocConflicts: string[] = [];
  // 只差大小写的路径在 macOS / Windows 上是同一个文件：Obsidian 按原样查不到它，
  // create 会抛 "File already exists" 并中断整轮写入；在区分大小写的系统上则会多出一个
  // 几乎同名的文件。两种都不要——和“被别人的文件占用”一样跳过并报告。
  const lowerOwner = new Set(input.allFiles.map((f) => f.toLowerCase()));
  const plannedLower = new Set<string>();
  /** 目标路径已被非本插件生成的文件占用 → 不写，只记录（宁可少建索引页，不可覆盖别人的文件） */
  const putMoc = (p: string, content: string): void => {
    const key = p.toLowerCase();
    const caseClash = plannedLower.has(key) || (!fileSet.has(p) && lowerOwner.has(key));
    if (caseClash || isForeignMoc(p, prevMoc, s)) {
      mocConflicts.push(p);
      return;
    }
    plannedLower.add(key);
    mocFiles.set(p, content);
  };
  for (const d of allDomains(s)) {
    const list = domainRels.get(d.id) as string[];
    domainCounts.set(d.id, list.length);
    mocReport.push({ id: d.id, name: d.name, count: list.length });
    if (s.moc.enabled) {
      putMoc(mocPath(d, s), buildMoc(d, list, { titles, summaries, today: input.today }, s));
    }
  }
  if (s.moc.enabled) putMoc(homePath(s), buildHome(domainCounts, input.today, s));

  // 以前生成、这次不再生成的索引页：只认本插件生成的（isForeignMoc 判为自己的），别人的文件不碰。
  // 关掉索引页时一个都不删——那是「别再更新」，不是「全删掉」
  const mocStale = s.moc.enabled
    ? pySort([...prevMoc.keys()].filter((p) => !mocFiles.has(p) && !isForeignMoc(p, prevMoc, s)))
    : [];

  const mocChanges = new Map<string, { old: string | null; new: string }>();
  for (const [mp, mc] of mocFiles) {
    const old = prevMoc.get(mp) ?? null;
    if (old === mc) continue;
    // 只有日期不同（frontmatter 的 date、主页的生成日期）不算变更：否则每天第一次运行
    // 都要重写全部索引页，git / 同步里多出一堆无意义的改动
    if (old !== null && sameExceptDate(old, mc, input.today)) continue;
    mocChanges.set(mp, { old, new: mc });
  }

  // ---- 链接有效性（F6）
  const contentsAfter = new Map(newContents);
  for (const [k, v] of mocFiles) contentsAfter.set(k, v);
  const { brokenManaged, brokenPreexist } = checkLinks(
    rels,
    [...mocFiles.keys()],
    contentsAfter,
    input.allFiles,
    s,
  );

  // ---- 实体使用情况（通用化：清理无效词 / 发现过泛词）
  const entityUsage: EntityUsage[] = matchers.map((m) => ({
    term: m.term,
    source: m.source,
    df: df.get(m.term) ?? 0,
  }));
  const unusedEntities = entityUsage.filter((x) => x.df === 0).map((x) => x.term);
  const broadThreshold = Math.max(1, Math.floor(rels.length * 0.8));
  const tooBroadEntities = entityUsage.filter((x) => x.df >= broadThreshold).map((x) => x.term);

  // ---- 待写入
  const writes = new Map<string, string>();
  const originals = new Map<string, string>();
  for (const rel of changedDocs) {
    writes.set(rel, newContents.get(rel) as string);
    originals.set(rel, input.contents.get(rel) as string);
  }
  for (const [mp, ch] of mocChanges) writes.set(mp, ch.new);

  const report: RunReport = {
    scanned: rels.length,
    excluded: (input.excludedCount ?? 0) + pluginFiles.length,
    skippedBinary: input.skippedBinary?.length ?? 0,
    domains: mocReport,
    plannedChanges: changedDocs.length,
    mocPlanned: mocChanges.size,
    mocConflicts,
    mocStale,
    autoLinkTotal,
    warnings,
    unmappedFiles,
    brokenManaged,
    brokenPreexist,
    entityUsage,
    unusedEntities,
    tooBroadEntities,
  };

  return {
    report,
    rels,
    domainById,
    domains,
    changedDocs,
    mocChanges,
    mocRemovals: new Map(mocStale.map((p) => [p, prevMoc.get(p) as string])),
    writes,
    originals,
    newContents,
    matchers,
  };
}

/** 便捷：从"全部文件 + 读取器"直接算 plan（CLI 与测试用；Obsidian adapter 自己读） */
export function planFromFiles(
  allFiles: readonly string[],
  readText: (rel: string) => string | null,
  s: Settings,
  today: string,
  mocContents?: ReadonlyMap<string, string>,
): PlanOutput {
  const { inScope, excludedCount } = collectInScope(allFiles, s);
  const contents = new Map<string, string>();
  const skippedBinary: string[] = [];
  for (const rel of inScope) {
    const text = readText(rel);
    if (text === null) skippedBinary.push(rel);
    else contents.set(rel, text);
  }
  return planRun({
    settings: s,
    today,
    allFiles,
    contents,
    skippedBinary,
    excludedCount,
    mocContents,
  });
}

/** 新内容把今天的日期换回旧页面的日期后与旧页面一致 → 只有日期变了 */
function sameExceptDate(old: string, next: string, today: string): boolean {
  const m = /^date: (.+)$/m.exec(old);
  if (!m || m[1] === today) return false;
  return next.split(today).join(m[1]) === old;
}
