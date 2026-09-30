import { t } from "./i18n.ts";
import { App, Modal, Setting } from "obsidian";
import type { DriftSuggestion } from "../core/reorg.ts";

export interface ReportModalOptions {
  /** 整理检测出的建议（可选；空则不渲染该区） */
  suggestions?: readonly DriftSuggestion[];
  /** 用户确认后应用建议（写回配置并重跑） */
  onApply?: (picks: readonly DriftSuggestion[]) => void | Promise<void>;
}

/** 一条建议的一句话说明（zh/en 跟随界面语言） */
function suggestionText(s: DriftSuggestion): string {
  if (s.kind === "rename" && s.domainName !== null && s.oldPath !== null && s.newPath !== null) {
    return t(`分组「${s.domainName}」的路径 ${s.oldPath}/ 已不存在，整理后为 ${s.newPath}/（${s.count} 篇）`,
      `Area "${s.domainName}": path ${s.oldPath}/ no longer exists; it is now ${s.newPath}/ (${s.count} notes)`);
  }
  if (s.kind === "dead" && s.domainName !== null && s.oldPath !== null) {
    return t(`分组「${s.domainName}」的路径 ${s.oldPath}/ 下已经没有文件`,
      `Area "${s.domainName}": no files are left under ${s.oldPath}/`);
  }
  if (s.kind === "orphan" && s.dir !== null) {
    return t(`目录 ${s.dir}/ 有 ${s.count} 篇笔记未映射到任何分组`,
      `${s.count} notes under ${s.dir}/ are not mapped to any area`);
  }
  return JSON.stringify(s);
}

/** 纯文本报告弹窗（运行结果 / 整理建议 / 错误详情） */
export class ReportModal extends Modal {
  private readonly title: string;
  private readonly body: string;
  private readonly suggestions: readonly DriftSuggestion[];
  private readonly onApply: ((picks: readonly DriftSuggestion[]) => void | Promise<void>) | null;

  constructor(app: App, title: string, body: string, opts: ReportModalOptions = {}) {
    super(app);
    this.title = title;
    this.body = body;
    this.suggestions = opts.suggestions ?? [];
    this.onApply = opts.onApply ?? null;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.title);
    const pre = contentEl.createEl("pre", { cls: "vault-linker-report" });
    pre.setText(this.body);

    if (this.suggestions.length > 0 && this.onApply !== null) {
      const section = contentEl.createDiv();
      section.createEl("h3", {
        text: t("检测到文件夹整理", "Vault folders were reorganized"),
      });
      section.createEl("p", {
        cls: "setting-item-description",
        text: t("笔记本身不受影响（链接每轮重算）。以下是分组映射与现实的脱节，确认后更新映射：",
          "Your notes are unaffected (links are recomputed every run). These mappings no longer match your folders; apply to update them:"),
      });
      const rows = this.suggestions.map((sug) => {
        const row = section.createDiv({ cls: "vault-linker-suggestion" });
        row.createSpan({ text: suggestionText(sug) });
        let applied = false;
        row.createEl("button", {
          text: t("应用", "Apply"),
        }).addEventListener("click", () => {
          if (applied) return;
          applied = true;
          void Promise.resolve(this.onApply?.([sug])).then(() => {
            row.querySelectorAll("button").forEach((b) => b.setAttribute("disabled", "true"));
          });
        });
        return row;
      });
      if (this.suggestions.length > 1) {
        new Setting(section).addButton((b) =>
          b.setButtonText(t("全部应用", "Apply all")).setCta().onClick(() => {
            void this.onApply?.(this.suggestions);
            rows.forEach((row) => row.querySelectorAll("button").forEach((x) => x.setAttribute("disabled", "true")));
          }),
        );
      }
    }

    new Setting(contentEl).addButton((b) =>
      b.setButtonText(t("复制", "Copy")).onClick(async () => {
        await navigator.clipboard.writeText(this.body);
        b.setButtonText(t("已复制", "Copied"));
      }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** JSON 配置导入/导出弹窗 */
export class JsonConfigModal extends Modal {
  private readonly title: string;
  private readonly initial: string;
  private readonly onApply: ((text: string) => void) | null;

  constructor(
    app: App,
    title: string,
    initial: string,
    onApply: ((text: string) => void) | null,
  ) {
    super(app);
    this.title = title;
    this.initial = initial;
    this.onApply = onApply;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.title);
    contentEl.createEl("p", {
      text: this.onApply
        ? t("粘贴配置 JSON 后点「导入」。导入会覆盖当前设置。", "Paste settings JSON and click Import. This replaces your current settings.")
        : t("这是当前配置的 JSON，可复制保存或分享给别人（「分享码」即此文本）。", "Your current settings as JSON. Copy it to keep or share."),
    });
    const ta = contentEl.createEl("textarea", { cls: "vault-linker-json" });
    ta.value = this.initial;
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    if (this.onApply) {
      const btn = row.createEl("button", { text: t("导入", "Import") });
      btn.addEventListener("click", () => {
        this.onApply?.(ta.value);
        this.close();
      });
    } else {
      const btn = row.createEl("button", { text: t("复制", "Copy") });
      btn.addEventListener("click", () => {
        void navigator.clipboard.writeText(ta.value).then(() => btn.setText(t("已复制", "Copied")));
      });
    }
    const cancel = row.createEl("button", { text: t("关闭", "Close") });
    cancel.addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
