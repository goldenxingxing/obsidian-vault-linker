/**
 * main.ts — 插件入口：命令 / 事件 / 轮询 / 状态栏 / 日志
 */

import { setUiLocale, t } from "./i18n.ts";
import { MarkdownView, Notice, Plugin, type TAbstractFile } from "obsidian";
import { obsidianLocale } from "./locale.ts";
import {
  applyAutoTexts, defaultSettings, mergeSettings, todayIso, upgradeBuiltins, type Settings,
} from "../core/settings.ts";
import { migrateAutoAccepted } from "../core/config-text.ts";
import { applySuggestions, detectPathDrift, type PathDrift, type RenameEvidence } from "../core/reorg.ts";
import type { PlanOutput } from "../core/engine.ts";
import { applyPlanObsidian, effectiveSettings, formatReport, planVault, type ApplyOutcome } from "./runner.ts";
import { ChangeWatcher } from "./watch.ts";
import { deserializeQueue, serializeQueue } from "./queue.ts";
import { LinkerSettingTab } from "./settings-tab.ts";
import { ReportModal } from "./report-modal.ts";
import { EntityWizardModal } from "./wizard-modal.ts";

/** rename 证据上限：够覆盖一次数千文件的大整理，又不至于无界增长 */
const MAX_RENAME_EVIDENCE = 5000;

/**
 * 影响 ChangeWatcher 行为的配置指纹：只有它变了才需要重启监听。
 * 时机相关的那几项（轮询间隔、静置时长、是否自动写入）不在这里：监听器每次排下一次
 * 检查时都现读设置，改它们立刻生效，也不该为此重启（重启会重拍基线）。
 */
function watcherKey(s: Settings): string {
  return JSON.stringify([
    s.trigger.onFileChange,
    s.scan.excludeTopDirs,
    s.scan.excludeAnyDirs,
    s.scan.excludeHidden,
    s.scan.excludeGlobs,
  ]);
}

export default class VaultLinkerPlugin extends Plugin {
  override settings: Settings = defaultSettings();
  private watcher: ChangeWatcher | null = null;
  private statusEl: HTMLElement | null = null;
  private lastPlan: PlanOutput | null = null;
  private lastOutcome: ApplyOutcome | undefined;
  private lastDrift: PathDrift | null = null;
  /**
   * rename 事件攒下的 old→new 路径对（仅文件名变化不影响映射，聚合时会过滤）。
   * 只做整理建议的「配对证据」，不做决定——外部整理没有事件，漂移检测必须独立成立。
   */
  private renameEvidence: RenameEvidence[] = [];
  private lastRunAt: string | null = null;
  /**
   * 待更新集（路径 → 它最后一次变化的时刻）。放在插件上而不是监听器里：
   * 改设置会重启监听、开关插件会重建监听器，待更新的东西不该跟着一起丢。
   */
  private readonly watchDirty = new Map<string, number>();
  private queueSaveTimer: number | null = null;
  private pendingCount = 0;
  private busy = false;
  private watcherKey = "";
  /** 首次安装（还没有 data.json）—— 用来给一句“先预览再开自动写入”的提示 */
  private firstRun = false;

  override async onload(): Promise<void> {
    // 界面语言跟随 Obsidian（命令名、提示、设置页、运行报告）
    setUiLocale(obsidianLocale());
    await this.loadSettings();
    await this.restoreQueue();
    this.addSettingTab(new LinkerSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.updateStatus();

    if (this.firstRun) {
      new Notice(
        t("Vault Linker Auto 已启用，它不会自己改动任何文件。打开它的设置点「预览」看看效果；" +
          "满意就点「更新链接」，想让它一直保持更新，打开「自动更新」。",
          "Vault Linker Auto is enabled and changes nothing on its own. Open its settings and click Preview to see what it would do. " +
          "If you like it, click Update links, and turn on Update automatically to keep links current."),
        12000,
      );
    }

    this.addCommand({
      id: "preview",
      name: t("预览（不改任何文件）", "Preview (changes nothing)"),
      callback: () => void this.run("dry-run", true),
    });
    this.addCommand({
      id: "apply",
      name: t("立即更新链接", "Update links now"),
      callback: () => void this.run("apply", true),
    });
    this.addCommand({
      id: "report",
      name: t("显示上次运行报告", "Show last run report"),
      callback: () => this.showReport(),
    });
    this.addCommand({
      id: "entity-wizard",
      name: t("从笔记里找主题词", "Find terms in your notes"),
      callback: () => new EntityWizardModal(this.app, this).open(),
    });

    // 等 vault 索引完成再挂监听：布局就绪前 Obsidian 会为库里每个文件触发一次 create，
    // 此时拍的基线也不完整，会把整个库误判成“有变更”
    this.app.workspace.onLayoutReady(() => {
      // 事件只作"立刻看一眼"的提示；真正的判定在 ChangeWatcher 的轮询里
      const onChange = (f: TAbstractFile): void => {
        if (f.path.endsWith(".md")) this.watcher?.notifyChange();
      };
      this.registerEvent(this.app.vault.on("modify", onChange));
      this.registerEvent(this.app.vault.on("create", onChange));
      this.registerEvent(this.app.vault.on("delete", onChange));
      // rename 额外攒下 old→new 证据，供整理检测把死路径和孤儿目录配成对
      this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.renameEvidence.push({ old: oldPath, new: file.path });
        if (this.renameEvidence.length > MAX_RENAME_EVIDENCE) {
          this.renameEvidence.splice(0, this.renameEvidence.length - MAX_RENAME_EVIDENCE);
        }
        onChange(file);
      }));

      this.startWatcher();
      // 加载留痕：让「插件到底加载了没有、当时什么配置」从日志上直接可查，
      // 不用等出问题后靠 workspace.json 的 mtime 这类旁证倒推
      void this.appendLog(
        `\n===== ${new Date().toISOString()} session =====\n` +
          t(
            `插件加载 v${this.manifest.version}：监听=${this.settings.trigger.onFileChange ? "开" : "关"}，` +
              `自动写入=${this.settings.trigger.autoApply ? "开" : "关"}，` +
              `启动即跑=${this.settings.trigger.runOnStartup ? "开" : "关"}，` +
              `恢复待处理 ${this.watchDirty.size} 篇`,
            `plugin loaded v${this.manifest.version}: watch=${this.settings.trigger.onFileChange ? "on" : "off"}, ` +
              `autoApply=${this.settings.trigger.autoApply ? "on" : "off"}, ` +
              `runOnStartup=${this.settings.trigger.runOnStartup ? "on" : "off"}, ` +
              `${this.watchDirty.size} pending restored`,
          ) +
          "\n",
      );
      if (this.settings.trigger.runOnStartup) {
        void this.run(this.settings.safety.dryRunByDefault ? "dry-run" : "apply", false, true);
      } else {
        // 开着自动更新才需要对账（没开监听就没有"待处理"这回事）
        void this.reconcileOnStartup();
      }
    });
  }

  override onunload(): void {
    this.watcher?.stop();
    this.watcher = null;
    if (this.queueSaveTimer !== null) window.clearTimeout(this.queueSaveTimer);
    // 关 vault 前把待更新集落盘：否则对账入队后秒关 vault，这批就无声丢了
    void this.saveQueue();
  }

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    this.firstRun = data === null || data === undefined;
    this.settings = mergeSettings(defaultSettings(), data);
    // 首次安装：language: auto → 按 Obsidian 的语言选文案，并落盘（下次加载不再是“首次”）
    if (this.firstRun) applyAutoTexts(this.settings, obsidianLocale());
    // 旧版向导采纳的词挪进设置页上看得见的词表；没改过的旧版内置文案换成新版的
    const movedTerms = migrateAutoAccepted(this.settings);
    const migrated = upgradeBuiltins(this.settings) || movedTerms;
    if (this.firstRun || migrated) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // 只有影响监听行为的配置变了才重启 watcher：重启会重置基线，
    // 把待处理的变更悄悄吞掉（设置页已做防抖，但改个无关字段也不该重启）
    if (watcherKey(this.settings) !== this.watcherKey) this.startWatcher();
  }

  startWatcher(): void {
    this.watcher?.stop();
    this.watcherKey = watcherKey(this.settings);
    if (!this.settings.trigger.onFileChange) return;
    this.watcher = new ChangeWatcher(this.app, this.settings, {
      onPendingChange: (n) => {
        this.pendingCount = n;
        this.updateStatus();
        this.scheduleQueueSave();
      },
      // 返回引擎自己写过的路径，让监听层能区分“运行期外部改动”与“自己的写入”
      onQuietReached: async () => await this.run(this.settings.trigger.autoApply ? "apply" : "dry-run", false, true),
    }, this.watchDirty);
    this.watcher.start();
    this.updateStatus();
  }

  /**
   * 启动对账：只算不写，把和现状不一致的笔记投进待处理集。
   *
   * 为什么需要：快照基线是启动那一刻现拍的，光靠它会把「Obsidian 关着的时候被改过的笔记」
   * 当成已处理，那批改动就永远丢了。这里算一遍「现在应该是什么样」，不一致的按各自 mtime
   * 起算静置——很久没动过的那些立刻到点，重启后马上就补上。
   */
  private async reconcileOnStartup(): Promise<void> {
    if (this.busy || !this.watcher) return;
    try {
      const s = await effectiveSettings(this.app, this.settings);
      const plan = await planVault(this.app, s, todayIso());
      const stale = plan.changedDocs.length;
      this.watcher.reconcile(plan.changedDocs);
      this.scheduleQueueSave();
      // 无论有没有待更新都留痕：0 篇也是一次真实跑过的对账，是和「对账根本没执行」区分的唯一凭据
      await this.appendLog(
        `\n===== ${new Date().toISOString()} startup-reconcile =====\n` +
          t(
            stale > 0 ? `启动对账：${stale} 篇笔记还没更新，已加入待处理` : "启动对账：无待更新笔记",
            stale > 0 ? `${stale} notes are out of date and were queued` : "startup reconcile: nothing pending",
          ) +
          "\n",
      );
    } catch (e) {
      console.error("[vault-linker]", e);
      // 异常也要落盘：只进 console 的报错在 Obsidian 里等于丢进黑洞，事后无法区分「没找到」和「崩了」
      await this.appendLog(`\n===== ${new Date().toISOString()} reconcile ERROR =====\n${String(e)}\n${(e as Error).stack ?? ""}\n`);
    }
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const parts = ["Vault Linker Auto"];
    parts.push(this.lastRunAt ? t(`上次 ${this.lastRunAt}`, `last run ${this.lastRunAt}`) : t("未运行", "not run yet"));
    if (this.pendingCount > 0) parts.push(t(`待处理 ${this.pendingCount}`, `${this.pendingCount} pending`));
    this.statusEl.setText(parts.join(" · "));
  }

  logPath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/vault-linker.log`;
  }

  queuePath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/queue.json`;
  }

  /** 把上次会话没跑完的待更新读回来（queue.ts 里坏文件/未来时刻都已兜底） */
  private async restoreQueue(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const p = this.queuePath();
      if (!(await adapter.exists(p))) return;
      const restored = deserializeQueue(await adapter.read(p));
      for (const [path, ts] of restored) {
        if (!this.watchDirty.has(path)) this.watchDirty.set(path, ts);
      }
    } catch {
      /* 恢复失败不阻塞加载：下一轮轮询照样能发现变更 */
    }
  }

  /** 待更新集有变化后延迟落盘（合并连续抖动），vault 关掉也不丢队列 */
  private scheduleQueueSave(): void {
    if (this.queueSaveTimer !== null) window.clearTimeout(this.queueSaveTimer);
    this.queueSaveTimer = window.setTimeout(() => {
      this.queueSaveTimer = null;
      void this.saveQueue();
    }, 3000);
  }

  private async saveQueue(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.queuePath(), serializeQueue(this.watchDirty));
    } catch {
      /* 存失败下次再存；队列只是加速器，丢了不致命 */
    }
  }

  private async appendLog(text: string): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const p = this.logPath();
      if (await adapter.exists(p)) {
        const old = await adapter.read(p);
        // 简单截断，避免日志无限增长
        const merged = (old.length > 1_000_000 ? old.slice(old.length - 200_000) : old) + text;
        await adapter.write(p, merged);
      } else {
        await adapter.write(p, text);
      }
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 编辑器里打开着的笔记 */
  private openFiles(): Set<string> {
    const out = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const f = leaf.view instanceof MarkdownView ? leaf.view.file : null;
      if (f) out.add(f.path);
    }
    return out;
  }

  /**
   * 跑一轮；返回**引擎自己写过**的路径（供监听层区分外部改动）
   * @param auto 自动触发（监听 / 启动时）：跳过正在打开的笔记；手动运行则全部写
   */
  async run(mode: "dry-run" | "apply", notify: boolean, auto = false): Promise<readonly string[]> {
    if (this.busy) {
      if (notify) new Notice(t("Vault Linker Auto 正在运行中，请稍候…", "Vault Linker Auto is already running…"));
      return [];
    }
    this.busy = true;
    try {
      // 生效配置排除了模板目录；领域为空时 planVault 按顶层文件夹自动生成（模板目录不会变成领域）
      const s = await effectiveSettings(this.app, this.settings);
      const plan = await planVault(this.app, s, todayIso());
      this.lastPlan = plan;
      // 整理检测：自定义过分组的用户改了文件夹后，映射与现实脱节 → 报告里给确认后可应用的更新
      this.lastDrift = detectPathDrift(
        this.app.vault.getFiles().map((f) => f.path),
        s,
        this.renameEvidence,
      );
      let outcome: ApplyOutcome | undefined;
      if (mode === "apply") {
        outcome = await applyPlanObsidian(this.app, plan, s, { skipOpen: auto ? this.openFiles() : undefined });
      }
      this.lastOutcome = outcome;
      this.lastRunAt = new Date().toLocaleTimeString();
      const text = formatReport(plan, this.settings, mode, outcome, this.lastDrift);
      await this.appendLog(`\n===== ${new Date().toISOString()} ${mode} =====\n${text}\n`);
      if (notify) {
        new Notice(
          mode === "apply"
            ? t(`Vault Linker：写入 ${outcome?.written ?? 0} 篇正文 / ${outcome?.writtenMoc ?? 0} 个 MOC`,
              `Vault Linker: updated ${outcome?.written ?? 0} notes and ${outcome?.writtenMoc ?? 0} index pages`)
            : t(`Vault Linker：计划修改 ${plan.report.plannedChanges} 篇 / MOC ${plan.report.mocPlanned} 个`,
              `Vault Linker: would update ${plan.report.plannedChanges} notes and ${plan.report.mocPlanned} index pages`),
        );
      }
      // 目标位置已有别的文件（或只差大小写）：没覆盖，要让人知道（明细已在日志的报告里）
      const conflicts = plan.report.mocConflicts;
      if (conflicts.length > 0 && notify) {
        new Notice(
          t(`Vault Linker：${conflicts.length} 个索引页的位置已有同名文件（或只差大小写），未覆盖：${conflicts.slice(0, 3).join("、")}`,
            `Vault Linker: ${conflicts.length} index pages were not written because a file with the same name ` +
              `(or differing only in case) already exists: ${conflicts.slice(0, 3).join(", ")}`),
          10000,
        );
      }
      const driftCount = this.lastDrift.suggestions.length;
      if (driftCount > 0 && notify) {
        new Notice(
          t(`Vault Linker：检测到 ${driftCount} 条文件夹整理带来的分组映射变化，打开运行报告可确认更新`,
            `Vault Linker: ${driftCount} folder mappings no longer match after you reorganized folders. Open the run report to update them`),
          10000,
        );
      }
      // 这一轮（含手动运行）写过的内容当作已应用：待处理清零，基线跟到写完之后
      this.watcher?.markApplied();
      this.scheduleQueueSave();
      this.updateStatus();
      return outcome?.writtenPaths ?? [];
    } catch (e) {
      console.error("[vault-linker]", e);
      await this.appendLog(`\n===== ${new Date().toISOString()} ERROR =====\n${String(e)}\n${(e as Error).stack ?? ""}\n`);
      new Notice(t("Vault Linker 运行出错，详情见插件日志", "Vault Linker failed; see the plugin log"));
      return [];
    } finally {
      this.busy = false;
    }
  }

  showReport(): void {
    if (!this.lastPlan) {
      new Notice(t("Vault Linker：本次会话还没有运行记录", "Vault Linker: no run yet in this session"));
      return;
    }
    const text = formatReport(
      this.lastPlan,
      this.settings,
      this.lastOutcome ? "apply" : "dry-run",
      this.lastOutcome,
      // 与 run() 的报告保持一致：命令里复制走的文本也该带上整理检测那一段
      this.lastDrift ?? undefined,
    );
    new ReportModal(this.app, t("Vault Linker 运行报告", "Vault Linker report"), text, {
      suggestions: this.lastDrift?.suggestions ?? [],
      onApply: async (picks) => {
        const n = applySuggestions(this.settings, picks);
        if (n === 0) return;
        // 用过的证据清掉：映射已更新，避免旧证据在下一轮重复配对
        this.renameEvidence = [];
        await this.saveSettings();
        new Notice(t(`已更新 ${n} 条分组映射，正在重新生成链接…`, `Updated ${n} mappings; regenerating links…`));
        void this.run("apply", true);
      },
    }).open();
  }
}
