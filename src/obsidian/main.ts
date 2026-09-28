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
import type { PlanOutput } from "../core/engine.ts";
import { applyPlanObsidian, effectiveSettings, formatReport, planVault, type ApplyOutcome } from "./runner.ts";
import { ChangeWatcher } from "./watch.ts";
import { LinkerSettingTab } from "./settings-tab.ts";
import { ReportModal } from "./report-modal.ts";
import { EntityWizardModal } from "./wizard-modal.ts";

/** 影响 ChangeWatcher 行为的配置指纹：只有它变了才需要重启监听 */
function watcherKey(s: Settings): string {
  return JSON.stringify([
    s.trigger.onFileChange,
    s.trigger.pollIntervalSec,
    s.trigger.quietPeriodSec,
    s.trigger.stableScans,
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
  private lastRunAt: string | null = null;
  private pendingCount = 0;
  private busy = false;
  private watcherKey = "";
  /** 首次安装（还没有 data.json）—— 用来给一句“先预览再开自动写入”的提示 */
  private firstRun = false;

  override async onload(): Promise<void> {
    // 界面语言跟随 Obsidian（命令名、提示、设置页、运行报告）
    setUiLocale(obsidianLocale());
    await this.loadSettings();
    this.addSettingTab(new LinkerSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.updateStatus();

    if (this.firstRun) {
      new Notice(
        t("Vault Linker 已启用，它不会自己改动任何文件。打开它的设置点「预览」看看效果；" +
          "满意就点「更新链接」，想让它一直保持更新，打开「自动更新」。",
          "Vault Linker is enabled and changes nothing on its own. Open its settings and click Preview to see what it would do. " +
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
      this.registerEvent(this.app.vault.on("rename", onChange));

      this.startWatcher();
      if (this.settings.trigger.runOnStartup) {
        void this.run(this.settings.safety.dryRunByDefault ? "dry-run" : "apply", false, true);
      }
    });
  }

  override onunload(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
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
      },
      // 返回引擎自己写过的路径，让监听层能区分“运行期外部改动”与“自己的写入”
      onQuietReached: async () => await this.run(this.settings.trigger.autoApply ? "apply" : "dry-run", false, true),
      registerInterval: (id) => this.registerInterval(id),
    });
    this.watcher.start();
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const parts = ["Vault Linker"];
    parts.push(this.lastRunAt ? t(`上次 ${this.lastRunAt}`, `last run ${this.lastRunAt}`) : t("未运行", "not run yet"));
    if (this.pendingCount > 0) parts.push(t(`待处理 ${this.pendingCount}`, `${this.pendingCount} pending`));
    this.statusEl.setText(parts.join(" · "));
  }

  logPath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/vault-linker.log`;
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
      if (notify) new Notice(t("Vault Linker 正在运行中，请稍候…", "Vault Linker is already running…"));
      return [];
    }
    this.busy = true;
    try {
      // 生效配置排除了模板目录；领域为空时 planVault 按顶层文件夹自动生成（模板目录不会变成领域）
      const s = await effectiveSettings(this.app, this.settings);
      const plan = await planVault(this.app, s, todayIso());
      this.lastPlan = plan;
      let outcome: ApplyOutcome | undefined;
      if (mode === "apply") {
        outcome = await applyPlanObsidian(this.app, plan, s, { skipOpen: auto ? this.openFiles() : undefined });
      }
      this.lastOutcome = outcome;
      this.lastRunAt = new Date().toLocaleTimeString();
      const text = formatReport(plan, this.settings, mode, outcome);
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
      this.watcher?.resetBaseline();
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
    );
    new ReportModal(this.app, t("Vault Linker 运行报告", "Vault Linker report"), text).open();
  }
}
