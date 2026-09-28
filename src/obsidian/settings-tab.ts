/**
 * settings-tab.ts — 设置界面
 *
 * 插件的本意只是「自动给 vault 加链接」，所以设置页只留六项：
 *   运行 → 自动更新 → 每篇几条相关笔记 → 索引页 → 跳过的文件夹 → 主题词
 * 领域按顶层文件夹自动生成，文案跟随 Obsidian 的语言，其余参数用默认值。
 * 需要细调的人可以导出设置 JSON、改完再导入（引擎的全部参数都还在）。
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultLinkerPlugin from "./main.ts";
import { defaultSettings, mergeSettings, type Settings } from "../core/settings.ts";
import { migrateAutoAccepted } from "../core/config-text.ts";
import { JsonConfigModal } from "./report-modal.ts";
import { EntityWizardModal } from "./wizard-modal.ts";
import { FolderSuggest } from "./folder-suggest.ts";
import { TermsModal } from "./terms-modal.ts";
import { t } from "./i18n.ts";

/** 设置页写盘防抖窗口（毫秒） */
const SAVE_DEBOUNCE_MS = 400;

const list = (v: string): string[] => v.split(",").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);

export class LinkerSettingTab extends PluginSettingTab {
  private plugin: VaultLinkerPlugin;
  private saveTimer: number | null = null;

  constructor(app: App, plugin: VaultLinkerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private get s(): Settings {
    return this.plugin.settings;
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.plugin.saveSettings();
  }

  /** 防抖保存：连续输入时不该每个按键都写盘（写盘还会触发 watcher 指纹比对） */
  private save(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 关闭设置页时把待保存的改动落盘（防抖窗口内退出不丢配置） */
  override hide(): void {
    if (this.saveTimer === null) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.plugin.saveSettings();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      cls: "setting-item-description vault-linker-note",
      text: t(
        "在每篇笔记末尾加上几篇相关笔记的链接，并给每个顶层文件夹生成一个索引页。链接是普通 Markdown，" +
        "只写在插件自己的区块里，你写的内容不会被改动。",
        "Adds links to related notes at the end of each note, and an index page for each top-level folder. " +
        "Links are plain Markdown, written only inside the plugin's own block; your own text is never changed."),
    });

    new Setting(containerEl)
      .setName(t("立即运行", "Run now"))
      .setDesc(t("预览只出报告，不改任何文件。", "Preview shows what would change without changing anything."))
      .addButton((b) =>
        b.setButtonText(t("预览", "Preview")).onClick(() => {
          void this.plugin.run("dry-run", true).then(() => this.plugin.showReport());
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("更新链接", "Update links")).setCta().onClick(() => {
          void this.plugin.run("apply", true);
        }),
      );

    new Setting(containerEl)
      .setName(t("自动更新", "Update automatically"))
      .setDesc(t("笔记有改动、停下来半分钟后自动更新链接。正在编辑的笔记等你关掉后再更新。",
        "Updates links about half a minute after your notes stop changing. The note you are editing is updated after you close it."))
      .addToggle((c) =>
        c.setValue(this.s.trigger.onFileChange && this.s.trigger.autoApply).onChange((v) => {
          this.s.trigger.onFileChange = v;
          this.s.trigger.autoApply = v;
          this.save();
        }),
      );

    new Setting(containerEl)
      .setName(t("每篇笔记的相关链接数", "Related links per note"))
      .setDesc(t("设为 0 就不加相关笔记。", "Set to 0 to add none."))
      .addSlider((c) =>
        c.setLimits(0, 20, 1)
          .setValue(this.s.related.enabled ? this.s.related.topN : 0)
          .setDynamicTooltip()
          .onChange((v) => {
            this.s.related.enabled = v > 0;
            if (v > 0) this.s.related.topN = v;
            this.save();
          }),
      );

    const index = new Setting(containerEl)
      .setName(t("索引页", "Index pages"))
      .setDesc(t(`每个顶层文件夹一个索引页，外加一个总主页，放在 ${this.s.moc.folder}/ 文件夹里。`,
        `One page per top-level folder listing its notes, plus a home page, in the ${this.s.moc.folder}/ folder.`))
      .addToggle((c) =>
        c.setValue(this.s.moc.enabled).onChange((v) => {
          this.s.moc.enabled = v;
          this.save();
        }),
      );
    // 旧版会把第一次探测到的领域存进配置，导入的配置也可能带着：那样新建的顶层文件夹就不会自动有索引页
    if (this.s.domains.length > 0) {
      index.setDesc(t(`按设置里保存的 ${this.s.domains.length} 个分组生成索引页（新建的顶层文件夹不会自动加入）。`,
        `Index pages follow the ${this.s.domains.length} groups saved in your settings, so new top-level folders are not added.`));
      index.addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip(t("改回按顶层文件夹自动分组", "Go back to one page per top-level folder")).onClick(() => {
          this.s.domains = [];
          void this.saveNow().then(() => this.display());
        }),
      );
    }

    new Setting(containerEl)
      .setName(t("跳过的文件夹", "Folders to skip"))
      .setDesc(t("这些文件夹里的笔记不加链接，也不进索引页。多个用逗号分开。模板文件夹会自动跳过。",
        "Notes in these folders get no links and are left off index pages. Separate several with commas. " +
        "Template folders are always skipped."))
      .addText((c) => {
        c.setPlaceholder(t("例如 归档, 日记/私密", "e.g. Archive, Journal/Private"));
        c.setValue(this.s.scan.excludeGlobs.join(", "));
        c.onChange((v) => {
          this.s.scan.excludeGlobs = list(v);
          this.save();
        });
        new FolderSuggest(this.app, c.inputEl, true);
      });

    const n = this.s.entities.manual.length;
    new Setting(containerEl)
      .setName(t("主题词（可选）", "Topic terms (optional)"))
      .setDesc(n > 0
        ? t(`已有 ${n} 个。除了标题和标签，两篇笔记都提到同一个词也算相关。`,
          `${n} terms. Besides titles and tags, two notes that mention the same term are related.`)
        : t("默认按笔记标题和标签判断相关。想更准，可以让插件从笔记里找出常用术语。",
          "Notes are related by their titles and tags. For better results, let the plugin find the terms you use."))
      .addButton((b) =>
        b.setButtonText(t("从笔记里找…", "Find in my notes…")).onClick(() => {
          new EntityWizardModal(this.app, this.plugin, () => this.display()).open();
        }),
      )
      .addExtraButton((b) =>
        b.setIcon("pencil").setTooltip(t("编辑", "Edit")).onClick(() => {
          new TermsModal(this.app, this.s.entities.manual, (terms) => {
            this.s.entities.manual = terms;
            void this.saveNow().then(() => this.display());
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName(t("导入 / 导出设置", "Import / export settings"))
      .setDesc(t("全部设置的 JSON，可分享；更细的参数（打分、文案、时机等）也在里面，改完再导入即可。",
        "All settings as JSON, to share or keep. Finer options (scoring, generated text, timing) are in there too; " +
        "edit and import it back."))
      .addButton((b) =>
        b.setButtonText(t("导出", "Export")).onClick(() => {
          new JsonConfigModal(this.app, t("导出设置", "Export settings"), JSON.stringify(this.s, null, 2), null).open();
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("导入", "Import")).onClick(() => {
          new JsonConfigModal(this.app, t("导入设置", "Import settings"), "", (text) => {
            try {
              const obj = JSON.parse(text) as Partial<Settings>;
              // 必须走 mergeSettings（与 loadSettings 同一条路径）：分享的配置可能来自旧版本、
              // 少一整段配置，浅合并会让 s.trigger / s.moc 等直接变 undefined
              const next = mergeSettings(defaultSettings(), obj);
              migrateAutoAccepted(next);
              this.plugin.settings = next;
              void this.saveNow().then(() => {
                this.display();
                new Notice(t("设置已导入", "Settings imported"));
              });
            } catch (e) {
              new Notice(t("JSON 解析失败：", "Could not parse JSON: ") + String(e));
            }
          }).open();
        }),
      );
  }
}
