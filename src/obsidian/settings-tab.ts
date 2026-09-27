/**
 * settings-tab.ts — 设置界面（通用化的对外入口）
 *
 * 分组：预设/语言 → 扫描范围 → 领域映射 → 实体来源 → 互链 → MOC → frontmatter →
 *       日报追溯 → 触发 → 安全 → 文案 → 运行
 */

import { App, Notice, PluginSettingTab, Setting, moment } from "obsidian";
import type VaultLinkerPlugin from "./main.ts";
import {
  PRESETS, defaultSettings, detectDomainsFromDirs, mergeSettings, resolveLanguage, retargetTexts,
  type Settings,
} from "../core/settings.ts";
import { domainsToText, entitiesToText, textToDomains, textToEntities } from "../core/config-text.ts";
import { topLevelDirs } from "../core/scope.ts";
import { JsonConfigModal, ReportModal } from "./report-modal.ts";
import { EntityWizardModal } from "./wizard-modal.ts";
import { t } from "./i18n.ts";

/** 设置页写盘防抖窗口（毫秒） */
const SAVE_DEBOUNCE_MS = 400;

/** 预设下拉里“当前不是任何预设”的哨兵值 */
const PRESET_CUSTOM = "__custom__";

/** 预设在界面上的名字（core 里的 label 只有中文） */
function presetLabel(key: string): string {
  switch (key) {
    case "generic": return t("通用默认（零配置）", "Generic (zero config)");
    case "zh-research": return t("中文研究型 vault", "Chinese research vault");
    default: return key;
  }
}

/** 当前设置匹配哪个预设（按值比较；都不匹配则视为自定义） */
function activePresetKey(s: Settings): string {
  // 忽略界面状态：展开/收起不该影响“是否等于某个预设”
  const mine = JSON.stringify({ ...s, ui: null });
  for (const [k, v] of Object.entries(PRESETS)) {
    if (JSON.stringify({ ...v.build(), ui: null }) === mine) return k;
  }
  return PRESET_CUSTOM;
}

// ---------------------------------------------------------------- 设置页

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
    await this.plugin.saveSettings();
  }

  /** 防抖保存：设置页连续输入时不该每个按键都写盘（写盘还会触发 watcher 指纹比对） */
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

  private text(
    container: HTMLElement, name: string, desc: string,
    get: () => string, set: (v: string) => void, multiline = false,
  ): void {
    new Setting(container).setName(name).setDesc(desc).addTextArea((t) => {
      t.setValue(get());
      if (!multiline) t.inputEl.rows = 1;
      t.onChange(async (v) => {
        set(v);
        this.save();
      });
    });
  }

  private num(
    container: HTMLElement, name: string, desc: string,
    get: () => number, set: (v: number) => void,
  ): void {
    new Setting(container).setName(name).setDesc(desc).addText((t) => {
      t.setValue(String(get()));
      t.onChange(async (v) => {
        const n = Number.parseFloat(v);
        if (!Number.isNaN(n)) {
          set(n);
          this.save();
        }
      });
    });
  }

  private toggle(
    container: HTMLElement, name: string, desc: string,
    get: () => boolean, set: (v: boolean) => void,
  ): void {
    new Setting(container).setName(name).setDesc(desc).addToggle((t) => {
      t.setValue(get());
      t.onChange(async (v) => {
        set(v);
        this.save();
      });
    });
  }

  private heading(container: HTMLElement, text: string): void {
    container.createEl("h3", { text });
  }

  /** 说明文字（不依赖 Setting 排版） */
  private note(container: HTMLElement, text: string): void {
    container.createEl("p", { text });
  }

  /**
   * 高级设置折叠区。日常要改的只有领域表与实体词表，其余 50 多项
   * （扫描范围 / 日报细则 / 触发参数 / 安全校验 / 文案模板…）都收在这里，展开状态随配置保存。
   */
  private advanced(containerEl: HTMLElement): HTMLElement {
    const details = containerEl.createEl("details");
    if (this.s.ui.advancedOpen) details.setAttribute("open", "");
    details.createEl("summary", {
      text: t("高级设置（扫描范围 / 日报细则 / 触发参数 / 安全校验 / 文案模板…）",
        "Advanced (scan scope, daily reports, triggers, safety checks, generated text…)"),
    });
    details.addEventListener("toggle", () => {
      this.s.ui.advancedOpen = details.open;
      this.save();
    });
    return details.createDiv();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t("Vault Linker 设置", "Vault Linker settings") });
    this.note(containerEl, t(
      "日常只需要改「领域映射」和「实体来源」；其余项都在页面底部的高级设置里。",
      "Day to day you only need Domains and Entity sources; everything else is under Advanced at the bottom."));

    // ---------- 预设与语言
    this.heading(containerEl, t("预设与语言", "Preset and language"));
    const active = activePresetKey(this.s);
    new Setting(containerEl)
      .setName(t("载入预设", "Load preset"))
      .setDesc(t("generic = 零配置通用；zh-research = 中文研究型",
        "generic = works with zero configuration; zh-research = Chinese-language research vault"))
      .addDropdown((d) => {
        for (const k of Object.keys(PRESETS)) d.addOption(k, presetLabel(k));
        d.addOption(PRESET_CUSTOM, t("（自定义 / 已修改）", "(custom / modified)"));
        d.setValue(active);
        d.onChange((v) => {
          if (v === PRESET_CUSTOM) return;
          const preset = PRESETS[v];
          if (!preset) return;
          const ui = this.s.ui; // 预设不该重置界面状态
          this.plugin.settings = preset.build();
          this.plugin.settings.ui = ui;
          void this.saveNow().then(() => {
            this.display();
            new Notice(t(`已载入预设：${presetLabel(v)}`, `Loaded preset: ${presetLabel(v)}`));
          });
        });
      });
    new Setting(containerEl)
      .setName(t("生成内容的语言", "Language of generated text"))
      .setDesc(t("写进笔记和索引页的标题、说明用哪种语言。auto = 跟随 Obsidian 的界面语言。切换后下次运行会重写所有区块",
        "Language of the headings and notes written into your notes and index pages. auto = follow Obsidian's language. " +
        "Changing it rewrites every block on the next run"))
      .addDropdown((d) => {
        d.addOption("auto", "auto");
        d.addOption("zh", "中文");
        d.addOption("en", "English");
        d.setValue(this.s.language);
        d.onChange((v) => {
          this.s.language = (v === "zh" || v === "en" ? v : "auto") as Settings["language"];
          this.s.texts = retargetTexts(this.s.texts, resolveLanguage(this.s.language, moment.locale()));
          this.save();
        });
      });
    new Setting(containerEl)
      .setName(t("配置导入 / 导出", "Import / export settings"))
      .setDesc(t("导出即「分享码」：把当前全部设置（含领域映射与实体词表）变成一段 JSON，别人可直接导入",
        "Export turns all current settings (including domains and entity lists) into JSON that someone else can import"))
      .addButton((b) =>
        b.setButtonText(t("导出", "Export")).onClick(() => {
          new JsonConfigModal(this.app, t("导出配置（可分享）", "Export settings (shareable)"), JSON.stringify(this.s, null, 2), null).open();
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("导入", "Import")).onClick(() => {
          new JsonConfigModal(this.app, t("导入配置", "Import settings"), "", (text) => {
            try {
              const obj = JSON.parse(text) as Partial<Settings>;
              // 必须走 mergeSettings（与 loadSettings 同一条路径）：分享码可能来自旧版本、
              // 少一整段配置，浅合并会让 s.trigger / s.moc 等直接变 undefined
              this.plugin.settings = mergeSettings(defaultSettings(), obj);
              void this.saveNow().then(() => {
                this.display();
                new Notice(t("配置已导入", "Settings imported"));
              });
            } catch (e) {
              new Notice(t("JSON 解析失败：", "Could not parse JSON: ") + String(e));
            }
          }).open();
        }),
      );

    // ---------- 运行
    this.heading(containerEl, t("运行", "Run"));
    new Setting(containerEl)
      .setName(t("立即运行", "Run now"))
      .setDesc(t("预览不会写盘；写入会修改 vault（有内容保护校验与回滚）",
        "Preview writes nothing; Apply changes your vault (every write is verified and rolled back if it touched anything outside the managed blocks)"))
      .addButton((b) =>
        b.setButtonText(t("预览", "Preview")).onClick(() => {
          void this.plugin.run("dry-run", true);
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("写入", "Apply")).setWarning().onClick(() => {
          void this.plugin.run("apply", true);
        }),
      )
      .addButton((b) =>
        b.setButtonText(t("上次报告", "Last report")).onClick(() => {
          this.plugin.showReport();
        }),
      );
    new Setting(containerEl)
      .setName(t("实体候选向导", "Entity candidate wizard"))
      .setDesc(t("扫全库挖出候选术语（可搜索的候选池），勾选的词进入「自定义实体词表」",
        "Scans the vault for candidate terms (searchable); the ones you tick go into the custom entity list"))
      .addButton((b) =>
        b.setButtonText(t("打开向导", "Open wizard")).onClick(() => {
          new EntityWizardModal(this.app, this.plugin).open();
        }),
      );
    new Setting(containerEl)
      .setName(t("查看插件日志", "Plugin log"))
      .setDesc(t("每次运行的结果都会追加到插件目录下的 vault-linker.log，便于事后核查",
        "Every run is appended to vault-linker.log in the plugin folder"))
      .addButton((b) =>
        b.setButtonText(t("打开日志", "Open log")).onClick(async () => {
          const dir = this.plugin.manifest.dir ?? ".obsidian/plugins/vault-linker";
          const p = `${dir}/vault-linker.log`;
          const adapter = this.app.vault.adapter;
          if (!(await adapter.exists(p))) {
            new Notice(t("还没有日志", "No log yet"));
            return;
          }
          const text = await adapter.read(p);
          new ReportModal(this.app, t("Vault Linker 日志", "Vault Linker log"), text.slice(-20000)).open();
        }),
      );

    // ---------- 自动运行
    this.heading(containerEl, t("自动运行", "Automatic runs"));
    this.toggle(containerEl, t("监听文件变更（轮询兜底）", "Watch for changes"),
      t("关闭后只能手动运行；开着时按周期全量快照对比，静默一段时间后自动运行",
        "Off = manual runs only. On = the vault is checked periodically and a run starts once changes have settled"),
      () => this.s.trigger.onFileChange, (v) => { this.s.trigger.onFileChange = v; });
    this.toggle(containerEl, t("自动运行时直接写入", "Apply on automatic runs"),
      t("关掉则自动运行只出预览报告，不写盘", "Off = automatic runs only produce a preview report"),
      () => this.s.trigger.autoApply, (v) => { this.s.trigger.autoApply = v; });
    this.toggle(containerEl, t("Obsidian 启动时运行一次", "Run once when Obsidian starts"), "",
      () => this.s.trigger.runOnStartup, (v) => { this.s.trigger.runOnStartup = v; });

    // ---------- 领域映射
    this.heading(containerEl, t("领域映射（决定 MOC 分组）", "Domains (how index pages are grouped)"));
    this.note(containerEl, t(
      "每行一个领域：id | 显示名 | 路径 | 根关键词 | 根前缀 | 优先级。路径可以是目录名（projects）或通配（reports/**）；" +
      "优先级数字小的先匹配。某个领域若需要另一组「忽略大小写」的关键词，再补一列即可：" +
      "id | 显示名 | 路径 | 根关键词 | 忽略大小写关键词 | 根前缀 | 优先级。",
      "One domain per line: id | name | paths | root keywords | root prefixes | priority. A path is a folder (projects) " +
      "or a glob (reports/**); lower priority numbers match first. For a separate set of case-insensitive keywords, " +
      "add a column: id | name | paths | root keywords | case-insensitive keywords | root prefixes | priority."));
    this.text(containerEl, t("领域列表", "Domain list"),
      t("留空则首次运行时按顶层目录自动探测", "Leave empty to detect from top-level folders on the first run"),
      () => domainsToText(this.s.domains), (v) => { this.s.domains = textToDomains(v); }, true);
    new Setting(containerEl)
      .setName(t("从顶层目录自动探测", "Detect from top-level folders"))
      .setDesc(t("把 vault 的每个顶层目录变成一个领域（会覆盖上面的列表）",
        "Makes each top-level folder a domain (replaces the list above)"))
      .addButton((b) =>
        b.setButtonText(t("探测", "Detect")).onClick(() => {
          const dirs = topLevelDirs(this.app.vault.getFiles().map((f) => f.path));
          this.s.domains = detectDomainsFromDirs(dirs);
          void this.saveNow().then(() => {
            this.display();
            new Notice(t(`已按 ${this.s.domains.length} 个顶层目录生成领域`,
              `Created ${this.s.domains.length} domains from top-level folders`));
          });
        }),
      );

    // ---------- 实体来源
    this.heading(containerEl, t("实体来源（决定「相关文档」怎么算）", "Entity sources (how related notes are found)"));
    this.toggle(containerEl, t("E1 用笔记标题 + 别名当实体", "E1: note titles and aliases"),
      t("零配置即可工作；适合正文里会提到别的笔记名的情况", "Works with zero configuration; good when notes mention each other by name"),
      () => this.s.entities.fromTitles, (v) => { this.s.entities.fromTitles = v; });
    this.toggle(containerEl, t("E2 用 vault 内 tag 当实体", "E2: tags in the vault"),
      t("用户自己维护的主题词，质量最高", "Topics you maintain yourself; usually the best signal"),
      () => this.s.entities.fromTags, (v) => { this.s.entities.fromTags = v; });
    this.note(containerEl, t(
      "E3 自定义词表：每行一个词，可用「词 = 别名1, 别名2」给别名。" +
      "拉丁词自动加词边界且大小写不敏感；中文词自动不加边界。" +
      "不知道填什么就用上面的「实体候选向导」。",
      "E3 custom terms: one per line; give aliases as \"term = alias1, alias2\". " +
      "Latin-script terms match whole words, case-insensitively; CJK terms match anywhere. " +
      "Not sure what to add? Use the entity candidate wizard above."));
    this.text(containerEl, t("自定义实体词表", "Custom terms"), t("领域术语（如 Kubernetes、缓存、机器学习）", "Domain terms, e.g. Kubernetes, caching, machine learning"),
      () => entitiesToText(this.s.entities.manual), (v) => { this.s.entities.manual = textToEntities(v); }, true);

    // ---------- 相关文档
    this.heading(containerEl, t("相关文档（文末托管区块）", "Related notes (managed block at the end of each note)"));
    this.toggle(containerEl, t("启用自动互链", "Add related notes"), "",
      () => this.s.related.enabled, (v) => { this.s.related.enabled = v; });
    this.num(containerEl, t("每篇最多几条", "Links per note"), t("默认 5", "Default 5"),
      () => this.s.related.topN, (v) => { this.s.related.topN = v; });

    // ---------- MOC
    this.heading(containerEl, t("MOC 索引页", "Index pages (MOC)"));
    this.toggle(containerEl, t("启用 MOC 生成", "Generate index pages"),
      t("每个领域一个索引页，外加一个主页", "One index page per domain, plus a home page"),
      () => this.s.moc.enabled, (v) => { this.s.moc.enabled = v; });

    // ---------- 日报追溯
    this.heading(containerEl, t("日报 ↔ 产出 追溯", "Daily report ↔ deliverable links"));
    this.toggle(containerEl, t("启用", "Enable"),
      t("日报文末列出当日产出、产出文首标注出处；别的 vault 通常没有这套目录约定，故默认关闭",
        "Lists each day's deliverables at the end of the daily report and links deliverables back to it. " +
        "Needs a specific folder layout, so it is off by default"),
      () => this.s.daily.enabled, (v) => { this.s.daily.enabled = v; });

    // ---------- 安全
    this.heading(containerEl, t("安全", "Safety"));
    this.toggle(containerEl, t("启动时只预览", "Preview only at startup"),
      t("「Obsidian 启动时运行一次」只出预览，不写盘", "The run at Obsidian startup only previews and writes nothing"),
      () => this.s.safety.dryRunByDefault, (v) => { this.s.safety.dryRunByDefault = v; });

    // ================================================================ 高级设置
    const adv = this.advanced(containerEl);
    const list = (v: string): string[] => v.split(",").map((x) => x.trim()).filter(Boolean);

    this.heading(adv, t("扫描范围", "Scan scope"));
    this.text(adv, t("排除顶层目录", "Excluded top-level folders"),
      t("逗号分隔，只作用于顶层", "Comma-separated; top level only"),
      () => this.s.scan.excludeTopDirs.join(", "), (v) => { this.s.scan.excludeTopDirs = list(v); });
    this.text(adv, t("排除任意层级目录", "Excluded folder names (any depth)"),
      t("逗号分隔，任意层级都排除（默认 node_modules）", "Comma-separated; excluded at any depth (default node_modules)"),
      () => this.s.scan.excludeAnyDirs.join(", "), (v) => { this.s.scan.excludeAnyDirs = list(v); });
    this.text(adv, t("排除路径通配", "Excluded path globs"),
      t("逗号分隔，如 archive/**、**/tmp/*", "Comma-separated, e.g. archive/**, **/tmp/*"),
      () => this.s.scan.excludeGlobs.join(", "), (v) => { this.s.scan.excludeGlobs = list(v); });
    this.toggle(adv, t("排除隐藏目录", "Exclude hidden folders"),
      t("排除所有以 . 开头的目录（.obsidian/.tools 等）", "Skip every folder whose name starts with a dot"),
      () => this.s.scan.excludeHidden, (v) => { this.s.scan.excludeHidden = v; });
    this.toggle(adv, t("排除模板", "Exclude templates"),
      t("跳过「模板」「Templater」设置里的模板目录和日记模板。往模板里写的标签和区块会被复制进之后新建的每一篇笔记",
        "Skip the folders set in Templates and Templater, and the daily note template. " +
        "Anything written into a template is copied into every note created from it"),
      () => this.s.scan.excludeTemplates, (v) => { this.s.scan.excludeTemplates = v; });
    this.toggle(adv, t("跳过其他插件的文件", "Skip other plugins' files"),
      t("Excalidraw 画板（*.excalidraw.md）和 Kanban 看板：它们按自己的格式读整个文件，写进去可能读坏",
        "Excalidraw drawings (*.excalidraw.md) and Kanban boards parse the whole file; writing into them can break them"),
      () => this.s.scan.skipPluginFiles, (v) => { this.s.scan.skipPluginFiles = v; });

    this.heading(adv, t("兜底领域（未命中任何规则的文件）", "Fallback domain (files no rule matches)"));
    this.text(adv, t("兜底领域 id", "Fallback domain id"), "",
      () => this.s.fallbackDomain.id, (v) => { this.s.fallbackDomain.id = v; });
    this.text(adv, t("兜底领域显示名", "Fallback domain name"), t("同时是 MOC 文件名", "Also the index page file name"),
      () => this.s.fallbackDomain.name, (v) => { this.s.fallbackDomain.name = v; });

    this.heading(adv, t("实体识别细则", "Entity matching"));
    this.text(adv, t("层级 tag 取法", "Nested tags"),
      t("top = 只取第一段（#a/b 取 a）；full = 全取", "top = first segment only (#a/b → a); full = the whole tag"),
      () => this.s.entities.tagMode, (v) => { this.s.entities.tagMode = v === "full" ? "full" : "top"; });
    this.text(adv, t("停用词", "Stopwords"), t("逗号分隔，出现这些词不计入实体", "Comma-separated terms that never count as entities"),
      () => this.s.entities.stopwords.join(", "), (v) => { this.s.entities.stopwords = list(v); });
    this.num(adv, t("词长下限", "Minimum term length"), t("按字符（code point）计", "In characters"),
      () => this.s.entities.minLength, (v) => { this.s.entities.minLength = v; });
    this.toggle(adv, t("忽略代码块内的命中", "Ignore matches inside code"), "",
      () => this.s.entities.ignoreInCode, (v) => { this.s.entities.ignoreInCode = v; });

    this.heading(adv, t("互链细则", "Related-note scoring"));
    this.num(adv, t("同领域加权", "Same-domain boost"), t("默认 1.5", "Default 1.5"),
      () => this.s.related.sameDomainBoost, (v) => { this.s.related.sameDomainBoost = v; });
    this.num(adv, t("最低得分阈值", "Minimum score"), t("不高于此分不写（默认 0）", "Links scoring at or below this are left out (default 0)"),
      () => this.s.related.minScore, (v) => { this.s.related.minScore = v; });
    this.text(adv, t("托管区块标签", "Managed block tag"),
      t("改动后旧的区块不会被自动识别，慎改", "Existing blocks are no longer recognized after a change; change with care"),
      () => this.s.related.blockTag, (v) => { this.s.related.blockTag = v; });

    this.heading(adv, t("MOC 细则", "Index pages"));
    this.text(adv, t("MOC 目录", "Index folder"),
      t("默认 _moc。无论叫什么，都不会被当成笔记扫描", "Default _moc. Whatever it is called, it is never scanned as notes"),
      () => this.s.moc.folder, (v) => { this.s.moc.folder = v; });
    this.text(adv, t("主页文件名", "Home page file name"), t("不含 .md", "Without .md"),
      () => this.s.moc.homeFile, (v) => { this.s.moc.homeFile = v; });
    this.toggle(adv, t("包含摘要", "Include summaries"), "",
      () => this.s.moc.includeSummary, (v) => { this.s.moc.includeSummary = v; });
    this.num(adv, t("摘要长度上限", "Summary length"), t("按字符计", "In characters"),
      () => this.s.moc.summaryMaxChars, (v) => { this.s.moc.summaryMaxChars = v; });

    this.heading(adv, "frontmatter");
    this.toggle(adv, t("给无 frontmatter 的文档补领域 tag", "Add a domain tag to notes without frontmatter"),
      t("默认关。只补给还没有 frontmatter 的笔记，已有 frontmatter 的不补，笔记挪了目录也不更新，所以别拿它筛选笔记",
        "Off by default. Only notes with no frontmatter get the tag, and it is not updated when a note moves, " +
        "so don't rely on it to filter notes"),
      () => this.s.frontmatter.enabled, (v) => { this.s.frontmatter.enabled = v; });
    this.text(adv, t("tag 前缀", "Tag prefix"), t("默认 domain/", "Default domain/"),
      () => this.s.frontmatter.tagPrefix, (v) => { this.s.frontmatter.tagPrefix = v; });
    this.text(adv, t("opt-out 键", "Opt-out key"),
      t("frontmatter 里写「键: 值」即整篇不碰", "A note with \"key: value\" in its frontmatter is left alone"),
      () => this.s.frontmatter.optOutKey, (v) => { this.s.frontmatter.optOutKey = v; });
    this.text(adv, t("opt-out 值", "Opt-out value"), "",
      () => this.s.frontmatter.optOutValue, (v) => { this.s.frontmatter.optOutValue = v; });

    this.heading(adv, t("日报追溯细则", "Daily report details"));
    this.text(adv, t("日报目录前缀", "Daily report folder"), t("含结尾 /", "With trailing /"),
      () => this.s.daily.dirPrefix, (v) => { this.s.daily.dirPrefix = v; });
    this.text(adv, t("日报文件名正则", "Daily report file regex"), t("group 1 = 日期", "Group 1 = the date"),
      () => this.s.daily.fileRegex, (v) => { this.s.daily.fileRegex = v; });
    this.text(adv, t("日报所属领域 id", "Daily report domain id"),
      t("该领域的 MOC 会按子目录再分组", "That domain's index page is grouped by subfolder"),
      () => this.s.daily.domainId, (v) => { this.s.daily.domainId = v; });
    this.text(adv, t("产出路径前缀（剥离）", "Deliverable path prefixes to strip"),
      t("逗号分隔，如 output/", "Comma-separated, e.g. output/"),
      () => this.s.daily.stripPathPrefixes.join(", "), (v) => { this.s.daily.stripPathPrefixes = list(v); });
    this.text(adv, t("裸路径识别前缀", "Bare path prefixes"),
      t("逗号分隔；正文里以此开头的路径会被当成产出引用", "Comma-separated; paths in the text starting with these count as deliverables"),
      () => this.s.daily.barePathPrefixes.join(", "), (v) => { this.s.daily.barePathPrefixes = list(v); });
    this.text(adv, t("允许的产出扩展名", "Deliverable extensions"), t("逗号分隔", "Comma-separated"),
      () => this.s.daily.allowedExtensions.join(", "), (v) => { this.s.daily.allowedExtensions = list(v); });
    this.text(adv, t("日报侧区块标签", "Daily report block tag"), "",
      () => this.s.daily.blockTag, (v) => { this.s.daily.blockTag = v; });
    this.text(adv, t("产出侧区块标签", "Deliverable block tag"), "",
      () => this.s.daily.sourceBlockTag, (v) => { this.s.daily.sourceBlockTag = v; });

    this.heading(adv, t("触发细则", "Trigger timing"));
    this.num(adv, t("轮询周期（秒）", "Poll interval (seconds)"), t("默认 20", "Default 20"),
      () => this.s.trigger.pollIntervalSec, (v) => { this.s.trigger.pollIntervalSec = v; });
    this.num(adv, t("静默期（秒）", "Quiet period (seconds)"),
      t("最后一次改动后等这么久才运行（默认 30）", "How long after the last change to wait before running (default 30)"),
      () => this.s.trigger.quietPeriodSec, (v) => { this.s.trigger.quietPeriodSec = v; });
    this.num(adv, t("连续稳定次数", "Stable checks"), t("默认 2", "Default 2"),
      () => this.s.trigger.stableScans, (v) => { this.s.trigger.stableScans = v; });

    this.heading(adv, t("安全与校验", "Safety checks"));
    this.toggle(adv, t("写前内容比对（外部改动就跳过）", "Skip notes changed since the preview"), "",
      () => this.s.safety.skipIfChanged, (v) => { this.s.safety.skipIfChanged = v; });
    this.toggle(adv, t("写后剥离区块逐字节校验", "Verify every write"),
      t("校验失败且非外部改动则自动回滚", "If anything outside the managed blocks changed, the note is restored"),
      () => this.s.safety.verifyStrippedBytes, (v) => { this.s.safety.verifyStrippedBytes = v; });

    this.heading(adv, t("生成内容的文案（支持 {date} {total} {excluded} {link} {summary} {count} {rel} {refs} 占位符）",
      "Generated text (placeholders: {date} {total} {excluded} {link} {summary} {count} {rel} {refs})"));
    const textKeys = Object.keys(this.s.texts) as Array<keyof Settings["texts"]>;
    for (const k of textKeys) {
      this.text(adv, k, "", () => this.s.texts[k], (v) => { this.s.texts[k] = v; });
    }
  }
}
