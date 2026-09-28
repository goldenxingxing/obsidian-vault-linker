import { t } from "./i18n.ts";
import { App, Modal, Setting } from "obsidian";

/** 纯文本报告弹窗（运行结果 / 错误详情） */
export class ReportModal extends Modal {
  private readonly title: string;
  private readonly body: string;

  constructor(app: App, title: string, body: string) {
    super(app);
    this.title = title;
    this.body = body;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.title);
    const pre = contentEl.createEl("pre", { cls: "vault-linker-report" });
    pre.setText(this.body);
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
      btn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(ta.value);
        btn.setText(t("已复制", "Copied"));
      });
    }
    const cancel = row.createEl("button", { text: t("关闭", "Close") });
    cancel.addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
