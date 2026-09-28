/**
 * terms-modal.ts — 编辑「你的主题词」
 *
 * 设置页上只显示词数，词表本身在这个弹窗里改，免得一大块文本框占满设置页。
 */

import { Modal, Setting, type App } from "obsidian";
import type { EntityRule } from "../core/settings.ts";
import { entitiesToText, textToEntities } from "../core/config-text.ts";
import { t } from "./i18n.ts";

/**
 * 文本 → 规则，保留已有同名词的权重、匹配方式和绑定目标
 * （文本里只写得出词和别名，直接替换会把导入配置里的这些字段悄悄丢掉）。
 */
export function mergeTerms(text: string, old: readonly EntityRule[]): EntityRule[] {
  const byTerm = new Map(old.map((r) => [r.term, r]));
  return textToEntities(text).map((r) => {
    const prev = byTerm.get(r.term);
    return prev ? { ...prev, aliases: r.aliases } : r;
  });
}

export class TermsModal extends Modal {
  private readonly terms: readonly EntityRule[];
  private readonly onSave: (terms: EntityRule[]) => void;

  constructor(app: App, terms: readonly EntityRule[], onSave: (terms: EntityRule[]) => void) {
    super(app);
    this.terms = terms;
    this.onSave = onSave;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t("你的主题词", "Your terms"));
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("每行一个词；别名写成「词 = 别名1, 别名2」。两篇笔记都出现同一个词，就算相关。",
        "One term per line; add aliases as \"term = alias1, alias2\". Two notes that both contain a term are related."),
    });
    const ta = contentEl.createEl("textarea", { cls: "vault-linker-json" });
    ta.value = entitiesToText(this.terms);
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("取消", "Cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText(t("保存", "Save")).setCta().onClick(() => {
          this.onSave(mergeTerms(ta.value, this.terms));
          this.close();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
