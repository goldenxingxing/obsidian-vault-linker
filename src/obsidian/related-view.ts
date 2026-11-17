/**
 * related-view.ts — 「相关笔记」侧边栏（P0-1）
 *
 * 只读视图：复用引擎 planVault 算出的 autolinks / titles，对当前活动笔记展示相关笔记。
 * 不写任何文件、不触发插件的写盘流程；vault 有变化时防抖重算，切笔记时从缓存直接查（不重算）。
 *
 * 为什么自持一份 plan 而不是只依赖插件 lastPlan：
 *   插件只在「跑一轮」时（手动 / 自动更新 / 启动对账）更新 lastPlan；若用户没开自动更新，
 *   lastPlan 会停在旧状态。视图自己按 vault 变化重算，才能保证「只读面板」始终跟得上现状。
 *   打开时先用 lastPlan 秒开（避免大库首次空白），再在后台重算一次校准。
 */

import { ItemView, MarkdownView, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "./i18n.ts";
import { effectiveSettings, planVault } from "./runner.ts";
import { todayIso } from "../core/settings.ts";
import type { PlanOutput } from "../core/engine.ts";
import type VaultLinkerPlugin from "./main.ts";

export const RELATED_VIEW_TYPE = "vault-linker-related";

/** vault 变化后重算的防抖窗口（毫秒）：合并连续改动，避免每敲一键就全库扫描 */
const RECOMPUTE_DEBOUNCE_MS = 2000;

export class RelatedView extends ItemView {
  private readonly plugin: VaultLinkerPlugin;
  private plan: PlanOutput | null = null;
  private computing = false;
  private stale = false;
  /** 计算代次：计算期间 vault 又变了/又开了一次计算，旧结果作废 */
  private gen = 0;
  private recomputeTimer: number | null = null;
  private closed = false;

  constructor(leaf: WorkspaceLeaf, plugin: VaultLinkerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return RELATED_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return t("相关笔记", "Related notes");
  }

  override getIcon(): string {
    return "link";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("vault-linker-related");
    // 先用插件最近一轮结果秒开；若没有（本次会话还没跑过）就重算
    this.plan = this.plugin.latestPlan ?? null;
    this.render();
    // 事件在 Component 里 register：onunload 时自动注销
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleRecompute()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRecompute()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRecompute()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRecompute()));
    if (!this.plan) await this.recompute();
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    if (this.recomputeTimer !== null) {
      window.clearTimeout(this.recomputeTimer);
      this.recomputeTimer = null;
    }
  }

  private scheduleRecompute(): void {
    if (this.closed) return;
    this.stale = true;
    if (this.recomputeTimer !== null) window.clearTimeout(this.recomputeTimer);
    this.recomputeTimer = window.setTimeout(() => {
      this.recomputeTimer = null;
      void this.recompute();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  private async recompute(): Promise<void> {
    if (this.closed) return;
    if (this.computing) {
      // 正在算，又来了新变化：标记过期，本轮结束后再排一次
      this.stale = true;
      return;
    }
    this.computing = true;
    this.stale = false;
    const g = ++this.gen;
    this.render();
    try {
      const s = await effectiveSettings(this.app, this.plugin.settings);
      const plan = await planVault(this.app, s, todayIso());
      // 计算期间 vault 又变了（或开始了新一轮计算）：这次结果已过期，稍后重算
      if (g !== this.gen || this.stale) {
        this.scheduleRecompute();
        return;
      }
      this.plan = plan;
      if (!this.closed) this.render();
    } catch (e) {
      console.error("[vault-linker]", e);
      if (g === this.gen && !this.closed) this.renderError(String(e));
    } finally {
      this.computing = false;
    }
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    const file = this.app.workspace.getActiveFile();
    const plan = this.plan;

    if (!file) {
      el.createEl("p", { text: t("打开一篇笔记以查看它的相关笔记。", "Open a note to see its related notes.") });
      return;
    }
    if (!plan) {
      el.createEl("p", { text: t("正在计算相关笔记…", "Computing related notes…") });
      return;
    }
    const list = plan.autolinks.get(file.path);
    if (!list || list.length === 0) {
      el.createEl("p", {
        text: t("这篇笔记没有相关笔记。", "This note has no related notes."),
      });
      return;
    }

    const title = plan.titles.get(file.path) ?? file.basename;
    el.createEl("p", {
      cls: "vault-linker-related-heading",
      text: t(`「${title}」的相关笔记：`, `Related to “${title}”:`),
    });
    const ul = el.createEl("ul", { cls: "vault-linker-related-list" });
    for (const rel of list) {
      const li = ul.createEl("li");
      const label = plan.titles.get(rel) ?? rel.replace(/\.md$/, "").split("/").pop() ?? rel;
      const a = li.createEl("a", { text: label, href: "#", cls: "vault-linker-related-link" });
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        const target = this.app.vault.getAbstractFileByPath(rel);
        if (!(target instanceof TFile)) {
          new Notice(t("目标笔记不存在（可能刚被删除或移出范围）", "Target note not found (deleted or out of scope)"));
          return;
        }
        if (ev.ctrlKey || ev.metaKey) {
          void this.app.workspace.openLinkText(rel, "", "tab");
        } else {
          const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? this.app.workspace.getLeaf(false);
          void leaf.openFile(target);
        }
      });
    }
  }

  private renderError(msg: string): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: t("计算相关笔记出错：", "Failed to compute related notes: ") + msg });
  }
}
