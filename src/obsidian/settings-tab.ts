/**
 * settings-tab.ts — 设置界面（Obsidian 1.13+ 声明式设置 API）
 *
 * 插件的本意只是「自动给 vault 加链接」，所以设置页只留六项：
 *   运行 → 自动更新 → 每篇几条相关笔记 → 索引页 → 跳过的文件夹 → 主题词
 * 领域按顶层文件夹自动生成，文案跟随 Obsidian 的语言，其余参数用默认值。
 * 需要细调的人可以导出设置 JSON、改完再导入（引擎的全部参数都还在）。
 *
 * 简单控件用 control 定义（框架负责渲染、持久化）；
 * 带副作用或自定义控件的行（运行按钮、文件夹建议、主题词、导入导出）用 render。
 */

import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type VaultLinkerPlugin from "./main.ts";
import { defaultSettings, mergeSettings, upgradeBuiltins, type Settings } from "../core/settings.ts";
import { migrateAutoAccepted } from "../core/config-text.ts";
import { JsonConfigModal } from "./report-modal.ts";
import { EntityWizardModal } from "./wizard-modal.ts";
import { FolderSuggest } from "./folder-suggest.ts";
import { TermsModal } from "./terms-modal.ts";
import { t } from "./i18n.ts";

/** 设置页写盘防抖窗口（毫秒） */
const SAVE_DEBOUNCE_MS = 400;

const list = (v: string): string[] => v.split(",").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);

/** 「停下来多久后更新」的选项（秒） */
const WAIT_CHOICES = [30, 60, 300, 900, 1800, 3600];

function waitLabel(sec: number): string {
  if (sec < 60) return t(`${sec} 秒`, `${sec} seconds`);
  const min = Math.round(sec / 60);
  if (min < 60) return t(`${min} 分钟`, min === 1 ? "1 minute" : `${min} minutes`);
  const h = Math.round((min / 60) * 10) / 10;
  return t(`${h} 小时`, h === 1 ? "1 hour" : `${h} hours`);
}

/**
 * 按等待时间定检查间隔：检查只比对文件的修改时间和大小、不读内容，很便宜，
 * 但也没必要比等待时间密太多。取等待时间的 1/3，限定在 10–60 秒。
 */
function pollFor(quietSec: number): number {
  return Math.min(60, Math.max(10, Math.round(quietSec / 3)));
}

/** control 定义的扁平键（多数字段在 settings 里是嵌套的，读写都经手这两个重写） */
type ControlKey = "autoUpdate" | "quietPeriodSec" | "relatedTopN" | "mocEnabled";

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

  override getControlValue(key: string): unknown {
    switch (key as ControlKey) {
      case "autoUpdate":
        return this.s.trigger.onFileChange && this.s.trigger.autoApply;
      case "quietPeriodSec":
        return this.s.trigger.quietPeriodSec;
      case "relatedTopN":
        return this.s.related.enabled ? this.s.related.topN : 0;
      case "mocEnabled":
        return this.s.moc.enabled;
    }
    return undefined;
  }

  override setControlValue(key: string, value: unknown): void {
    switch (key as ControlKey) {
      case "autoUpdate": {
        const v = Boolean(value);
        this.s.trigger.onFileChange = v;
        this.s.trigger.autoApply = v;
        break;
      }
      case "quietPeriodSec": {
        const sec = Number(value);
        this.s.trigger.quietPeriodSec = sec;
        this.s.trigger.pollIntervalSec = pollFor(sec);
        break;
      }
      case "relatedTopN": {
        const n = Number(value);
        this.s.related.enabled = n > 0;
        if (n > 0) this.s.related.topN = n;
        break;
      }
      case "mocEnabled":
        this.s.moc.enabled = Boolean(value);
        break;
    }
    this.save();
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.s;
    // 导入的配置或旧版本可能是别的等待值：原样显示，不悄悄改掉
    const quiet = s.trigger.quietPeriodSec;
    const waitOptions: Record<string, string> = {};
    for (const sec of WAIT_CHOICES) waitOptions[String(sec)] = waitLabel(sec);
    if (!WAIT_CHOICES.includes(quiet)) waitOptions[String(quiet)] = waitLabel(quiet);

    return [
      {
        // 页首说明（无控件的一行）
        name: "",
        desc: t(
          "在每篇笔记末尾加上几篇相关笔记的链接，并给每个顶层文件夹生成一个索引页。链接是普通 Markdown，" +
          "只写在插件自己的区块里，你写的内容不会被改动。",
          "Adds links to related notes at the end of each note, and an index page for each top-level folder. " +
          "Links are plain Markdown, written only inside the plugin's own block; your own text is never changed."),
      },
      {
        name: t("立即运行", "Run now"),
        desc: t("预览只出报告，不改任何文件。", "Preview shows what would change without changing anything."),
        render: (setting: Setting) => {
          setting
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
        },
      },
      {
        name: t("自动更新", "Update automatically"),
        desc: t("笔记改完、停下来一段时间后自动更新链接。正在编辑的笔记等你关掉后再更新。",
          "Updates links once your notes have stopped changing for a while. The note you are editing is updated after you close it."),
        control: { type: "toggle", key: "autoUpdate" },
      },
      {
        name: t("停下来多久后更新", "Wait after the last change"),
        desc: t("这段时间里没有新的改动才更新。写得多、vault 大，可以设长一些。",
          "Links are updated only after this long without new changes. Choose longer for large vaults or long writing sessions."),
        visible: () => this.s.trigger.onFileChange && this.s.trigger.autoApply,
        control: { type: "dropdown", key: "quietPeriodSec", options: waitOptions },
      },
      {
        name: t("每篇笔记的相关链接数", "Related links per note"),
        desc: t("设为 0 就不加相关笔记。", "Set to 0 to add none."),
        control: { type: "slider", key: "relatedTopN", min: 0, max: 20, step: 1 },
      },
      {
        name: t("索引页", "Index pages"),
        // 旧版会把第一次探测到的领域存进配置，导入的配置也可能带着：那样新建的顶层文件夹就不会自动有索引页
        desc: s.domains.length > 0
          ? t(`按设置里保存的 ${s.domains.length} 个分组生成索引页（新建的顶层文件夹不会自动加入）。`,
            `Index pages follow the ${s.domains.length} groups saved in your settings, so new top-level folders are not added.`)
          : t(`每个顶层文件夹一个索引页，外加一个总主页，放在 ${s.moc.folder}/ 文件夹里。`,
            `One page per top-level folder listing its notes, plus a home page, in the ${s.moc.folder}/ folder.`),
        control: { type: "toggle", key: "mocEnabled" },
      },
      {
        name: t("改回按顶层文件夹自动分组", "Go back to one page per top-level folder"),
        desc: t("清除设置里保存的分组，恢复每个顶层文件夹一个索引页。", "Clear the saved groups and give every top-level folder its own index page again."),
        visible: () => this.s.domains.length > 0,
        action: () => {
          this.s.domains = [];
          void this.saveNow().then(() => this.update());
        },
      },
      {
        name: t("跳过的文件夹", "Folders to skip"),
        desc: t("这些文件夹里的笔记不加链接，也不进索引页。多个用逗号分开。模板文件夹会自动跳过。",
          "Notes in these folders get no links and are left off index pages. Separate several with commas. " +
          "Template folders are always skipped."),
        render: (setting: Setting) => {
          setting.addText((c) => {
            c.setPlaceholder(t("例如 归档, 日记/私密", "e.g. Archive, Journal/Private"));
            c.setValue(this.s.scan.excludeGlobs.join(", "));
            c.onChange((v) => {
              this.s.scan.excludeGlobs = list(v);
              this.save();
            });
            new FolderSuggest(this.app, c.inputEl, true);
          });
        },
      },
      {
        name: t("主题词（可选）", "Topic terms (optional)"),
        desc: s.entities.manual.length > 0
          ? t(`已有 ${s.entities.manual.length} 个。除了标题和标签，两篇笔记都提到同一个词也算相关。`,
            `${s.entities.manual.length} terms. Besides titles and tags, two notes that mention the same term are related.`)
          : t("默认按笔记标题和标签判断相关。想更准，可以让插件从笔记里找出常用术语。",
            "Notes are related by their titles and tags. For better results, let the plugin find the terms you use."),
        render: (setting: Setting) => {
          setting
            .addButton((b) =>
              b.setButtonText(t("从笔记里找…", "Find in my notes…")).onClick(() => {
                new EntityWizardModal(this.app, this.plugin, () => this.update()).open();
              }),
            )
            .addExtraButton((b) =>
              b.setIcon("pencil").setTooltip(t("编辑", "Edit")).onClick(() => {
                new TermsModal(this.app, this.s.entities.manual, (terms) => {
                  this.s.entities.manual = terms;
                  void this.saveNow().then(() => this.update());
                }).open();
              }),
            );
        },
      },
      {
        name: t("导入 / 导出设置", "Import / export settings"),
        desc: t("全部设置的 JSON，可分享；更细的参数（打分、文案、时机等）也在里面，改完再导入即可。",
          "All settings as JSON, to share or keep. Finer options (scoring, generated text, timing) are in there too; " +
          "edit and import it back."),
        render: (setting: Setting) => {
          setting
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
                    upgradeBuiltins(next);
                    this.plugin.settings = next;
                    void this.saveNow().then(() => {
                      this.update();
                      new Notice(t("设置已导入", "Settings imported"));
                    });
                  } catch (e) {
                    new Notice(t("JSON 解析失败：", "Could not parse JSON: ") + String(e));
                  }
                }).open();
              }),
            );
        },
      },
    ];
  }
}
