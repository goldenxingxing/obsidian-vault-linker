/**
 * pending-modal.ts — 「待处理笔记」弹窗
 *
 * 把当前待更新集（watchDirty）按篇列出来：路径 + 改动时刻 + 静置到期时刻 + 剩余时间。
 * 纯展示，打开瞬间的快照；不在这里触发任何运行/写入。
 */

import { t } from "./i18n.ts";
import { App, Modal, Setting, TFile } from "obsidian";

export interface PendingItem {
  path: string;
  /** 队列里的计时基准 ms（静置到期 = changedAt + quietMs；打开中的笔记被重试时会延后） */
  changedAt: number;
  /** 文件真实改动时刻 ms（mtime）——显示用，避免把"重试延时"当成"改动时间" */
  mtime: number;
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 剩余时间的简短表示：53s / 53m / 1h5m */
function fmtRemain(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${m > 0 ? `${m}m` : ""}`;
}

/** 待处理笔记列表弹窗 */
export class PendingModal extends Modal {
  private readonly title: string;
  private readonly items: readonly PendingItem[];
  private readonly quietMs: number;

  constructor(app: App, title: string, items: readonly PendingItem[], quietMs: number) {
    super(app);
    this.title = title;
    this.items = items;
    this.quietMs = quietMs;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.title);

    if (this.items.length === 0) {
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: t("当前没有待处理的笔记。", "No notes are waiting to be processed."),
      });
    } else {
      const list = contentEl.createEl("ul", { cls: "vault-linker-pending" });
      const now = Date.now();
      for (const it of this.items) {
        const due = it.changedAt + this.quietMs;
        const remain = Math.max(0, due - now);
        const li = list.createEl("li", {
          cls: "vault-linker-pending-row is-clickable",
          attr: { "aria-label": t("打开笔记", "Open note") },
        });
        li.createSpan({ cls: "vault-linker-pending-path", text: it.path });
        li.createDiv({
          cls: "vault-linker-pending-meta",
          text: t(
            `改动 ${fmtTs(it.mtime)} · 静置至 ${fmtTs(due)} · 剩 ${fmtRemain(remain)}`,
            `changed ${fmtTs(it.mtime)} · quiet until ${fmtTs(due)} · ${fmtRemain(remain)} left`,
          ),
        });
        li.addEventListener("click", () => this.openNote(it.path));
      }
    }

    new Setting(contentEl).addButton((b) =>
      b.setButtonText(t("关闭", "Close")).onClick(() => this.close()),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /** 点击待处理条目：在 Obsidian 里打开该笔记，并关闭弹窗 */
  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
      this.close();
    }
  }
}
