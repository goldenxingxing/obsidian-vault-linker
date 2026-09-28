/**
 * wizard-modal.ts — 实体候选向导（E4 的对外入口）
 *
 * 设计依据（实测）：候选**池**的召回是 95.1%（39/41），但按排名取 top-N 只有 56%
 * —— 低频术语（实测一个排第 258 名、一个排第 6401 名）需要**搜索**才能找到。
 * 所以向导给的是"可搜索的候选池 + 勾选"，而不是"top-N 列表"。
 *
 * 候选一律**不自动生效**：只有勾选并点「应用」才会写进配置。
 */

import { t } from "./i18n.ts";
import type { DiscoverStage } from "../core/discover.ts";
import { App, Modal, Notice, Setting } from "obsidian";
import type VaultLinkerPlugin from "./main.ts";
import { discoverCandidatesAsync, type Candidate } from "../core/discover.ts";
import { buildDiscoverDocs, effectiveSettings } from "./runner.ts";
import { termRule } from "../core/config-text.ts";

export class EntityWizardModal extends Modal {
  private candidates: Candidate[] | null = null;
  private selected = new Set<string>();
  private filter = "";
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private scanning = false;
  private readonly plugin: VaultLinkerPlugin;
  /** 应用后回调（设置页用来刷新词表显示） */
  private readonly onApplied: (() => void) | undefined;

  constructor(app: App, plugin: VaultLinkerPlugin, onApplied?: () => void) {
    super(app);
    this.plugin = plugin;
    this.onApplied = onApplied;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t("从笔记里找主题词", "Find terms in your notes"));
    contentEl.createEl("p", {
      text: t(
        "从你的笔记里找出反复出现的术语（中英文都行）。勾选想用的，点「加入我的主题词」。" +
        "几千篇的 vault 可能要扫一分钟左右，期间 Obsidian 照常可用。",
        "Finds terms that recur across your notes, in English or Chinese. Tick the ones you want and click Add to my terms. " +
        "A vault with thousands of notes can take about a minute; Obsidian stays usable meanwhile."),
    });

    this.statusEl = contentEl.createDiv();
    this.statusEl.setText(t("准备中…", "Preparing…"));

    const bar = contentEl.createDiv();
    new Setting(bar)
      .addText((input) => {
        input.setPlaceholder(t("搜索候选", "Search candidates"));
        input.onChange(() => {
          this.filter = input.getValue().trim();
          this.renderList();
        });
      })
      .addButton((b) =>
        b.setButtonText(t("全选当前筛选", "Select all shown")).onClick(() => {
          for (const c of this.filtered()) this.selected.add(c.term);
          this.renderList();
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("清空勾选", "Clear selection")).onClick(() => {
          this.selected.clear();
          this.renderList();
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("重新扫描", "Rescan")).onClick(() => {
          this.candidates = null;
          void this.scan();
        }),
      );

    this.listEl = contentEl.createDiv({ cls: "vault-linker-candidates" });

    const footer = contentEl.createDiv({ cls: "modal-button-container" });
    const applyBtn = footer.createEl("button", { cls: "mod-cta", text: t("加入我的主题词", "Add to my terms") });
    applyBtn.addEventListener("click", () => void this.apply());
    const closeBtn = footer.createEl("button", { text: t("关闭", "Close") });
    closeBtn.addEventListener("click", () => this.close());

    void this.scan();
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const s = this.plugin.settings;
    try {
      this.statusEl?.setText(t("正在读取 vault…", "Reading the vault…"));
      await new Promise((r) => window.setTimeout(r, 50)); // 让弹窗先画出来
      const docs = await buildDiscoverDocs(this.app, await effectiveSettings(this.app, s));
      this.statusEl?.setText(t(`正在扫描 ${docs.length} 篇…（分块处理，界面不会冻住）`, `Scanning ${docs.length} notes…`));
      const t0 = Date.now();
      const all = await discoverCandidatesAsync(docs, s, { topN: 200000 }, (stage, done, tot) => {
        this.statusEl?.setText(`${stageLabel(stage)}: ${done}/${tot}…`);
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      this.candidates = all;
      // 默认预选：拉丁前 40 + 中文前 40（用户可再搜索补充）
      const latin = all.filter((c) => c.kind === "latin").slice(0, 40);
      const cjk = all.filter((c) => c.kind === "cjk").slice(0, 40);
      for (const c of [...latin, ...cjk]) this.selected.add(c.term);
      const nLatin = all.filter((c) => c.kind === "latin").length;
      const nCjk = all.filter((c) => c.kind === "cjk").length;
      this.statusEl?.setText(t(
        `扫描完成：候选池 ${all.length} 个（拉丁 ${nLatin} / 中文 ${nCjk}），耗时 ${secs}s。已默认预选 80 个，可搜索补充。`,
        `Done: ${all.length} candidates (${nLatin} Latin-script, ${nCjk} CJK) in ${secs}s. ` +
        `The top 80 are preselected; search to add more.`));
      this.renderList();
    } catch (e) {
      this.statusEl?.setText(t("扫描失败：", "Scan failed: ") + String(e));
    } finally {
      this.scanning = false;
    }
  }

  private filtered(): Candidate[] {
    const all = this.candidates ?? [];
    if (!this.filter) return all;
    const f = this.filter.toLowerCase();
    return all.filter((c) => c.term.toLowerCase().includes(f));
  }

  private renderList(): void {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    const items = this.filtered().slice(0, 500);
    if (items.length === 0) {
      el.createEl("p", { text: this.candidates ? t("无匹配候选", "No matching candidates") : t("扫描中…", "Scanning…") });
      return;
    }
    for (const c of items) {
      const row = el.createEl("label", { cls: "vault-linker-candidate" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = this.selected.has(c.term);
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(c.term);
        else this.selected.delete(c.term);
      });
      row.createSpan({ cls: "vault-linker-candidate-term", text: c.term });
      row.createSpan({
        cls: "vault-linker-candidate-meta",
        text: `df=${c.df} freq=${c.freq}` +
          (c.kind === "cjk"
            ? t(` 凝聚=${c.cohesion.toFixed(1)} 熵=${c.entropy.toFixed(1)}`, ` cohesion=${c.cohesion.toFixed(1)} entropy=${c.entropy.toFixed(1)}`)
            : "") +
          (c.inTitles ? t(` 标题×${c.inTitles}`, ` titles×${c.inTitles}`) : "") +
          (c.inTags ? ` tag×${c.inTags}` : ""),
      });
    }
    if (this.filtered().length > items.length) {
      el.createEl("p", { text: t(`（仅显示前 ${items.length} 个，请用搜索缩小范围）`, `(showing the first ${items.length}; search to narrow down)`) });
    }
  }

  private async apply(): Promise<void> {
    if (this.selected.size === 0) {
      new Notice(t("没有勾选任何候选", "Nothing selected"));
      return;
    }
    const s = this.plugin.settings;
    const existing = new Set(s.entities.manual.map((r) => r.term));
    let added = 0;
    for (const term of this.selected) {
      if (existing.has(term)) continue;
      existing.add(term);
      s.entities.manual.push(termRule(term));
      added++;
    }
    await this.plugin.saveSettings();
    this.onApplied?.();
    new Notice(t(`已把 ${added} 个词加入「你的主题词」，可在设置里查看和删除`,
      `Added ${added} terms to Your terms; you can review or remove them in settings`));
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

function stageLabel(stage: DiscoverStage): string {
  switch (stage) {
    case "read": return t("读取正文", "Reading notes");
    case "entropy": return t("统计邻接熵", "Measuring context");
    case "rank": return t("排序打分", "Ranking");
  }
}
