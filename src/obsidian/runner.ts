/**
 * runner.ts — Obsidian 适配层：读 vault → 跑核心引擎 → 写回 vault
 *
 * 与 Node 侧（tools/cli/*）职责相同，只是 IO 换成 Obsidian API：
 *   - 读：vault.adapter.readBinary + fatal UTF-8 解码 + 通用换行归一
 *   - 写：vault.process（原子读改写，防并发覆盖）
 *   - 写后：protectionOk 校验，必要时回滚
 *
 * 设计约束：本模块**只做类型导入**（`import type`），运行时不 import "obsidian"，
 * 并且只依赖"鸭子类型"的一个小子集（见 AppLike / VaultLike）——
 * 这样它可以在 Node 里用假 vault 做端到端测试（tests/adapter.test.ts），
 * 而 Obsidian 真实的 App 在结构上天然满足这些接口。
 */

import { t } from "./i18n.ts";
import type { App, TFile } from "obsidian";
import { planSteps, type EngineInput, type PlanOutput } from "../core/engine.ts";
import { collectInScope, ensureDomains, templatePaths, withRuntimeExcludes } from "../core/scope.ts";
import { safeDirPath } from "../core/moc.ts";
import { pyUniversalNewlines } from "../core/pycompat.ts";
import { protectionOk } from "../core/verify.ts";
import { parseFrontmatterTags } from "../core/frontmatter.ts";
import { titleOf, withOriginalEol } from "../core/text.ts";
import type { DiscoverDoc } from "../core/discover.ts";
import type { Settings } from "../core/settings.ts";

// ---------------------------------------------------------------- 用到的那部分 API

export interface VaultLike {
  /** 配置目录（用户可以改名，不一定是 `.obsidian`） */
  configDir: string;
  getFiles(): Array<{ path: string; stat?: { mtime: number; size: number } }>;
  getAbstractFileByPath(path: string): unknown;
  readBinary(file: never): Promise<ArrayBuffer>;
  process(file: never, fn: (data: string) => string): Promise<string>;
  create(path: string, data: string): Promise<unknown>;
  createFolder(path: string): Promise<unknown>;
  /** 只用来读配置目录里的 JSON（模板设置）：配置目录不在 vault 索引里，Vault API 读不到 */
  adapter: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
  };
}

export interface AppLike {
  vault: VaultLike & {
    /** 旧版 API：system=true 进系统回收站，false 进 vault 的 .trash */
    trash?(file: never, system: boolean): Promise<void>;
  };
  /** 1.6.6+：按用户在「文件与链接」里选的方式删除（系统回收站 / .trash / 直接删） */
  fileManager?: { trashFile?(file: never): Promise<void> };
}

/** 鸭子类型判断"是不是一个文件"（不依赖 instanceof TFile，避免运行时依赖 obsidian） */
function isFileLike(x: unknown): x is { path: string } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.path !== "string") return false;
  if (Array.isArray(o.children)) return false; // TFolder
  return true;
}

export interface ApplyOutcome {
  written: number;
  writtenMoc: number;
  /** 正在编辑器里打开、因此这次没改写的笔记 */
  skippedOpen: string[];
  /** 写入失败的 MOC（路径被文件夹占用，或 Obsidian 拒绝写入） */
  mocFailed: string[];
  /** 移到回收站的旧索引页 */
  mocRemoved: string[];
  /** 引擎自己写过的路径（含 MOC）——监听层用它区分“外部改动”，避免白跑 */
  writtenPaths: string[];
  skipped: string[];
  protectionFailed: string[];
  protectionExternal: string[];
  restored: string[];
}

/**
 * 读文本：不存在或非法 UTF-8 返回 null。
 * 读字节再严格解码，而不是 vault.read：非 UTF-8 的文件要跳过，不能被「宽松解码」后写回、弄坏原字节。
 */
export async function readVaultText(app: AppLike, path: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!isFileLike(file)) return null;
  try {
    const buf = await app.vault.readBinary(file as never);
    const dec = new TextDecoder("utf-8", { fatal: true });
    return pyUniversalNewlines(dec.decode(new Uint8Array(buf)));
  } catch {
    return null;
  }
}

export async function buildEngineInput(app: AppLike, s: Settings, today: string): Promise<EngineInput> {
  const allFiles = app.vault.getFiles().map((f) => f.path);
  const { inScope, excludedCount } = collectInScope(allFiles, s);

  const contents = new Map<string, string>();
  const skippedBinary: string[] = [];
  for (const rel of inScope) {
    const t = await readVaultText(app, rel);
    if (t === null) skippedBinary.push(rel);
    else contents.set(rel, t);
  }

  const mocPrefix = safeDirPath(s.moc.folder) + "/";
  const mocContents = new Map<string, string>();
  for (const f of allFiles) {
    if (!f.startsWith(mocPrefix) || !f.endsWith(".md")) continue;
    const t = await readVaultText(app, f);
    if (t !== null) mocContents.set(f, t);
  }

  return {
    settings: s,
    today,
    allFiles,
    contents,
    skippedBinary,
    excludedCount,
    mocContents,
  };
}

/** 读取 Obsidian 的模板配置，得到本次运行实际生效的配置（排除模板；不落盘） */
export async function effectiveSettings(app: AppLike, s: Settings): Promise<Settings> {
  if (!s.scan.excludeTemplates) return s;
  const configDir = app.vault.configDir;
  const files = new Map<string, string>();
  for (const rel of ["templates.json", "plugins/templater-obsidian/data.json", "daily-notes.json"]) {
    const p = `${configDir}/${rel}`;
    try {
      if (await app.vault.adapter.exists(p)) files.set(p, await app.vault.adapter.read(p));
    } catch {
      /* 读不到就当没配置 */
    }
  }
  return withRuntimeExcludes(s, templatePaths((p) => files.get(p) ?? null, configDir));
}

/**
 * 算一轮计划。没有保存领域（默认）时，按当前的顶层文件夹生成领域，只用于这一轮、不写回配置：
 * 新建的文件夹自动有索引页，删掉的文件夹下一轮就不再有（旧索引页随之清理）。
 */
export async function planVault(app: AppLike, s: Settings, today: string): Promise<PlanOutput> {
  const run = { ...s };
  ensureDomains(run, app.vault.getFiles().map((f) => f.path));
  return drivePlan(await buildEngineInput(app, run, today));
}

/**
 * 异步驱动生成器：每处理 YIELD_EVERY 篇让出一次主线程。结果与 planRun 完全相同。
 * 用 window.setTimeout 而非裸 setTimeout，保证计时器挂在当前（含 popout）窗口上。
 */
export async function drivePlan(input: EngineInput): Promise<PlanOutput> {
  const it = planSteps(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
}

/** 为 E4 候选发现准备文档集（标题 / tags / 正文） */
export async function buildDiscoverDocs(app: AppLike, s: Settings): Promise<DiscoverDoc[]> {
  const allFiles = app.vault.getFiles().map((f) => f.path);
  const { inScope } = collectInScope(allFiles, s);
  const docs: DiscoverDoc[] = [];
  for (const rel of inScope) {
    const content = await readVaultText(app, rel);
    if (content === null) continue;
    docs.push({
      rel,
      title: titleOf(content, rel, s),
      tags: parseFrontmatterTags(content, "tags").tags,
      content,
    });
  }
  return docs;
}

/** 写入（或新建）一个文件；路径被文件夹等非文件对象占着时不写，返回 false */
async function writeVaultFile(app: AppLike, path: string, content: string): Promise<boolean> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (isFileLike(existing)) {
    await app.vault.process(existing as never, () => content);
    return true;
  }
  // 路径被文件夹（或其它非文件对象）占着：不能 create，否则会抛错
  if (existing !== null && existing !== undefined) return false;
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
  await app.vault.create(path, content);
  return true;
}

/**
 * @param opts.skipOpen 正在编辑器里打开的笔记（自动运行时传入）：不改写，免得你写到一半
 *   区块在眼前变了、光标跳走。关掉之后下一次运行会补上。
 */
export async function applyPlanObsidian(
  app: AppLike,
  plan: PlanOutput,
  s: Settings,
  opts: { skipOpen?: ReadonlySet<string> } = {},
): Promise<ApplyOutcome> {
  const out: ApplyOutcome = {
    written: 0,
    writtenMoc: 0,
    mocFailed: [],
    mocRemoved: [],
    writtenPaths: [],
    skipped: [],
    protectionFailed: [],
    protectionExternal: [],
    restored: [],
    skippedOpen: [],
  };

  for (const rel of plan.changedDocs) {
    if (opts.skipOpen?.has(rel)) {
      out.skippedOpen.push(rel);
      continue;
    }
    const file = app.vault.getAbstractFileByPath(rel);
    if (!isFileLike(file)) continue;
    const orig = plan.originals.get(rel) as string;
    const target = plan.writes.get(rel) as string;

    let skipped = false;
    let raw = orig;
    await app.vault.process(file as never, (cur) => {
      // vault.process 在写前发现文件被并发修改时会**重跑回调**，
      // 因此每次都重置标记，否则上一次的 skipped 会污染本次结果
      skipped = false;
      raw = cur;
      if (s.safety.skipIfChanged && pyUniversalNewlines(cur) !== orig) {
        skipped = true;
        return cur;
      }
      return withOriginalEol(target, cur);
    });
    if (skipped) {
      out.skipped.push(rel);
      continue;
    }
    out.written++;
    out.writtenPaths.push(rel);

    if (s.safety.verifyStrippedBytes) {
      const now = await readVaultText(app, rel);
      if (now !== null && !protectionOk(orig, now, s)) {
        if (now !== target) {
          out.protectionExternal.push(rel);
        } else {
          out.protectionFailed.push(rel);
          await writeVaultFile(app, rel, raw); // 原始字节（含原换行）
          out.restored.push(rel);
        }
      }
    }
  }

  // 一个 MOC 写不进去不该拖垮其余的：记下来，继续写下一个
  for (const [mp, ch] of plan.mocChanges) {
    try {
      if (!(await writeVaultFile(app, mp, ch.new))) {
        out.mocFailed.push(mp);
        continue;
      }
    } catch {
      out.mocFailed.push(mp);
      continue;
    }
    out.writtenMoc++;
    out.writtenPaths.push(mp);
  }

  // 不再生成的旧索引页：计划之后被人改过（或已不在）就不动
  for (const [mp, planned] of plan.mocRemovals) {
    const file = app.vault.getAbstractFileByPath(mp);
    if (!isFileLike(file) || (await readVaultText(app, mp)) !== planned) continue;
    try {
      if (app.fileManager?.trashFile) await app.fileManager.trashFile(file as never);
      else if (app.vault.trash) await app.vault.trash(file as never, true);
      else continue;
    } catch {
      continue;
    }
    out.mocRemoved.push(mp);
    out.writtenPaths.push(mp);
  }
  return out;
}

/** 把运行报告渲染成便于人读 + agent 事后核查的文本 */
export function formatReport(
  plan: PlanOutput,
  s: Settings,
  mode: "dry-run" | "apply",
  outcome?: ApplyOutcome,
  drift?: { suggestions: ReadonlyArray<{ kind: string; domainName: string | null; oldPath: string | null; newPath: string | null; dir: string | null; count: number }> },
): string {
  const r = plan.report;
  const lines: string[] = [];
  lines.push(t("模式: ", "Mode: ") + (mode === "apply" ? "APPLY" : "DRY-RUN"));
  lines.push(t(`扫描 .md: ${r.scanned} 在范围 + ${r.excluded} 排除`, `Notes: ${r.scanned} in scope, ${r.excluded} excluded`) +
    (r.skippedBinary ? t(`（非 UTF-8 跳过 ${r.skippedBinary}）`, ` (${r.skippedBinary} skipped: not UTF-8)`) : ""));
  lines.push(t("领域分布: ", "Areas: ") + r.domains.map((d) => `${d.name}=${d.count}`).join(", "));
  lines.push(t(`计划修改文档: ${r.plannedChanges} / ${r.scanned}`, `Notes to update: ${r.plannedChanges} / ${r.scanned}`));
  lines.push(t(`MOC 新建/更新: ${r.mocPlanned}`, `Index pages to write: ${r.mocPlanned}`));
  if (r.mocStale.length > 0) {
    lines.push(t(`不再需要的旧索引页（移到回收站）: ${r.mocStale.length}: `, `Old index pages no longer needed (moved to trash): ${r.mocStale.length}: `) +
      r.mocStale.slice(0, 10).join(", "));
  }
  if (r.mocConflicts.length > 0) {
    lines.push(t(`!! 跳过同名文件 ${r.mocConflicts.length} 个（位置已有不是本插件生成的文件，或只差大小写，未覆盖）: `,
      `!! ${r.mocConflicts.length} index pages skipped (a file not made by this plugin, or differing only in case, is already there): `) +
      r.mocConflicts.slice(0, 10).join(", "));
  }
  lines.push(t(`自动互链条目: ${r.autoLinkTotal}`, `Related-note links: ${r.autoLinkTotal}`));
  lines.push(t(`实体: ${r.entityUsage.length} 个（未命中 ${r.unusedEntities.length}，过泛 ${r.tooBroadEntities.length}）`,
    `Topics: ${r.entityUsage.length} (${r.unusedEntities.length} unused, ${r.tooBroadEntities.length} too broad)`));
  lines.push(t(`链接有效性: 托管区块/MOC 内失效 ${r.brokenManaged.length}；正文既有失效 ${r.brokenPreexist.length}`,
    `Broken links: ${r.brokenManaged.length} in generated blocks and index pages; ${r.brokenPreexist.length} already in your notes`));
  if (r.unmappedFiles.length > 0) {
    lines.push(t(`未映射目录文件: ${r.unmappedFiles.length}（已归入「${s.fallbackDomain.name}」，可在设置里补目录映射）`,
      `Notes in no area: ${r.unmappedFiles.length} (listed under "${s.fallbackDomain.name}"; add their folders to an area in settings)`));
  }
  if (drift && drift.suggestions.length > 0) {
    lines.push(t(`检测到文件夹整理: ${drift.suggestions.length} 条分组映射与现实脱节（报告弹窗里可确认更新）:`,
      `Folder reorganization detected: ${drift.suggestions.length} mappings no longer match (apply them from the report):`));
    for (const sug of drift.suggestions.slice(0, 10)) {
      const what =
        sug.kind === "rename"
          ? t(`「${sug.domainName}」${sug.oldPath}/ → ${sug.newPath}/（${sug.count} 篇）`,
            `"${sug.domainName}": ${sug.oldPath}/ -> ${sug.newPath}/ (${sug.count} notes)`)
          : sug.kind === "dead"
            ? t(`「${sug.domainName}」${sug.oldPath}/ 下已无文件`,
              `"${sug.domainName}": no files left under ${sug.oldPath}/`)
            : t(`${sug.dir}/（${sug.count} 篇未映射）`, `${sug.dir}/ (${sug.count} unmapped notes)`);
      lines.push(`  - ${what}`);
    }
  }
  if (outcome) {
    lines.push(t(`写入正文 ${outcome.written} 篇（跳过 ${outcome.skipped.length} 篇：写前内容已变）`,
      `Notes written: ${outcome.written} (${outcome.skipped.length} skipped: changed since the preview)`));
    if (outcome.skippedOpen.length > 0) {
      lines.push(t(`跳过正在打开的笔记 ${outcome.skippedOpen.length} 篇（关掉后下次运行补上）`,
        `Open notes skipped: ${outcome.skippedOpen.length} (updated on a later run once closed)`));
    }
    lines.push(t(`写入 MOC ${outcome.writtenMoc} 个`, `Index pages written: ${outcome.writtenMoc}`));
    if (outcome.mocFailed.length > 0) {
      lines.push(t(`!! MOC 写入失败 ${outcome.mocFailed.length} 个: `, `!! Index pages that could not be written: ${outcome.mocFailed.length}: `) +
        outcome.mocFailed.slice(0, 10).join(", "));
    }
    if (outcome.restored.length > 0) {
      lines.push(t(`!! 内容保护校验失败并已回滚 ${outcome.restored.length} 篇`, `!! Verification failed; restored ${outcome.restored.length} notes`));
    }
    if (outcome.protectionExternal.length > 0) {
      lines.push(t(`!! 校验失败但系写入后被外部改动（保留现场）${outcome.protectionExternal.length} 篇`,
        `!! Verification failed because something else edited the note after the write (left as is): ${outcome.protectionExternal.length}`));
    }
    if (outcome.restored.length === 0 && outcome.protectionExternal.length === 0) {
      lines.push(t(`内容保护校验: PASS（${outcome.written} 篇剥离托管区块后与原文逐字节一致）`,
        `Verification: PASS (outside the managed blocks, all ${outcome.written} notes are byte-for-byte unchanged)`));
    }
  }
  return lines.join("\n");
}

/** 仅供类型标注使用（真实插件里 this.app 是 App） */
export type { App, TFile };
