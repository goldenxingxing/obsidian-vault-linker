/**
 * settings.ts — 配置模型：类型、通用默认值、预设
 *
 * 设计目标（"别人也能用"）：**零配置可用 → 精细可配 → 配置可分享**。
 * 领域映射、实体词表、区块标签、文案、日报路径……全部可配置，另有两个预设：
 *
 *   generic        —— 通用默认：零配置就能跑（领域自动探测 + 实体走标题/标签）
 *   zh-research    —— 中文研究型 vault
 *
 * 无任何 Obsidian 依赖，可在 Node 里直接跑（测试与 CLI 都依赖这一点）。
 */

import { localIsoDate } from "./pycompat.ts";

// ---------------------------------------------------------------- 类型

export interface DomainRule {
  /** slug，也是 frontmatter tag 的后缀（domain/<id>） */
  id: string;
  /** 显示名，同时是 MOC 文件名（<folder>/<name>.md） */
  name: string;
  /**
   * 匹配模式（相对 vault 根的路径）：
   *   "projects"      顶层目录 projects 下的一切
   *   "reports/daily" 子目录
   *   "reports/**"    通配（* 不跨 /，** 跨 /）
   */
  paths: string[];
  /** 根目录散落文件：文件名**包含**这些子串即命中（大小写敏感） */
  rootKeywords: string[];
  /** 同上，但先转小写再比较 */
  rootKeywordsLower: string[];
  /** 根目录散落文件：文件名以这些前缀开头即命中 */
  rootPrefixes: string[];
  /** 匹配优先级：数字小的先匹配；同值按 domains[] 顺序。默认 0 */
  priority: number;
}

export interface EntityRule {
  term: string;
  aliases: string[];
  /** 拉丁词默认大小写不敏感 */
  caseSensitive: boolean;
  /** 拉丁词默认加词边界 (?<![A-Za-z0-9_])…(?![A-Za-z0-9_]) */
  wordBoundary: boolean;
  /** 打分权重，默认 1 */
  weight: number;
  /** 可选：绑定目标笔记（该实体出现时指向此笔记） */
  target?: string;
}

/** 所有用户可见文案（生成内容里的固定文本），可按语言预设 + 逐项覆盖 */
export interface Texts {
  mocTitlePrefix: string;
  mocGeneratedNote: string;
  homeTitle: string;
  homeGeneratedNote: string;
  homeSectionTitle: string;
  homeDomainLine: string;
  homeTotalLine: string;
  mocEntryLine: string;
  dailyOtherGroup: string;
  noSummary: string;
  relatedHeading: string;
  relatedNavLine: string;
  relatedEntryLine: string;
  deliverablesHeading: string;
  deliverablesEntryLine: string;
  sourceLine: string;
  sourceRefSuffix: string;
  sourceSeparator: string;
  unmappedWarning: string;
}

export interface Settings {
  version: number;
  language: "auto" | "zh" | "en";
  /** 界面状态（随配置一起保存，不参与生成逻辑） */
  ui: {
    /** 设置页「高级设置」折叠区是否展开 */
    advancedOpen: boolean;
  };

  scan: {
    /** 顶层目录名（只作用于顶层） */
    excludeTopDirs: string[];
    /** 任意层级的目录名 */
    excludeAnyDirs: string[];
    /** 排除的路径通配（相对 vault 根） */
    excludeGlobs: string[];
    /** 是否排除所有以 . 开头的目录 */
    excludeHidden: boolean;
    /**
     * 跳过 Obsidian 模板目录（核心「模板」插件、Templater）和日记模板文件。
     * 往模板里写标签或区块，会被复制进之后用它新建的每一篇笔记。
     */
    excludeTemplates: boolean;
    /** 跳过其他插件自己的数据文件：Excalidraw 画板（*.excalidraw.md）、Kanban 看板 */
    skipPluginFiles: boolean;
  };

  domains: DomainRule[];
  fallbackDomain: DomainRule;

  entities: {
    /** E1：笔记标题 + aliases */
    fromTitles: boolean;
    /** E2：vault 内 tag */
    fromTags: boolean;
    /** 层级 tag 取法 */
    tagMode: "top" | "full";
    /** E3：手写/导入词表 */
    manual: EntityRule[];
    /** E4：向导里勾选采纳的自动候选 */
    autoAccepted: string[];
    stopwords: string[];
    /** 词长下限（code point 计） */
    minLength: number;
    /** 是否忽略代码块/行内代码内的命中（默认关） */
    ignoreInCode: boolean;
  };

  related: {
    enabled: boolean;
    topN: number;
    sameDomainBoost: number;
    minScore: number;
    blockTag: string;
  };

  moc: {
    enabled: boolean;
    folder: string;
    homeFile: string;
    includeSummary: boolean;
    summaryMaxChars: number;
    /** home 总行里 "已排除 …" 的文案片段 */
    excludedNote: string;
  };

  frontmatter: {
    enabled: boolean;
    tagPrefix: string;
    optOutKey: string;
    optOutValue: string;
  };

  daily: {
    enabled: boolean;
    /** 日报所在目录前缀（含结尾 /） */
    dirPrefix: string;
    /** 这个领域在 MOC 里按“子目录”再分组（通常是月份） */
    domainId: string;
    /** 从文件路径提取日期的正则（group 1 = 日期） */
    fileRegex: string;
    blockTag: string;
    sourceBlockTag: string;
    /** 产出路径的允许扩展名 */
    allowedExtensions: string[];
    /** 识别产出的路径前缀（如 "output/"），提取时会被剥掉 */
    stripPathPrefixes: string[];
    /** 产出引用出现在正文里的形式：反引号 / 裸路径 */
    scanBackticks: boolean;
    scanBarePaths: boolean;
    /** 裸路径识别的起始前缀 */
    barePathPrefixes: string[];
  };

  trigger: {
    onFileChange: boolean;
    /** 自动运行时是否直接写入（false = 只出预览报告） */
    autoApply: boolean;
    pollIntervalSec: number;
    quietPeriodSec: number;
    stableScans: number;
    runOnStartup: boolean;
  };

  safety: {
    dryRunByDefault: boolean;
    skipIfChanged: boolean;
    verifyStrippedBytes: boolean;
  };

  texts: Texts;
}

// ---------------------------------------------------------------- 文案预设

const TEXTS_ZH: Texts = {
  mocTitlePrefix: "# MOC：",
  mocGeneratedNote: "> 本页由 Vault Linker 自动生成，请勿手工编辑。",
  homeTitle: "# Vault 导航主页",
  homeGeneratedNote: "> 本页由 Vault Linker 自动生成，请勿手工编辑。生成日期：{date}。",
  homeSectionTitle: "## 领域导航",
  homeDomainLine: "- {link} — {count} 篇",
  homeTotalLine: "**在范围文档总数：{total} 篇**",
  mocEntryLine: "- {link} — {summary}",
  dailyOtherGroup: "其他",
  noSummary: "（无摘要）",
  relatedHeading: "## 相关文档",
  relatedNavLine: "- 导航：{link}",
  relatedEntryLine: "- {link}",
  deliverablesHeading: "## 当日产出链接",
  deliverablesEntryLine: "- {link}",
  sourceLine: "> 📍 出处：{refs}",
  sourceRefSuffix: " 日报",
  sourceSeparator: "、",
  unmappedWarning: "未映射目录归入根目录待归档: {rel}",
};

const TEXTS_EN: Texts = {
  mocTitlePrefix: "# MOC: ",
  mocGeneratedNote: "> This page is generated by Vault Linker. Do not edit by hand.",
  homeTitle: "# Vault Home",
  homeGeneratedNote: "> This page is generated by Vault Linker. Do not edit by hand. Generated on {date}.",
  homeSectionTitle: "## Domains",
  homeDomainLine: "- {link} — {count} notes",
  homeTotalLine: "**Notes in scope: {total}**",
  mocEntryLine: "- {link} — {summary}",
  dailyOtherGroup: "Other",
  noSummary: "(no summary)",
  relatedHeading: "## Related notes",
  relatedNavLine: "- Index: {link}",
  relatedEntryLine: "- {link}",
  deliverablesHeading: "## Deliverables",
  deliverablesEntryLine: "- {link}",
  sourceLine: "> 📍 Source: {refs}",
  sourceRefSuffix: " daily",
  sourceSeparator: ", ",
  unmappedWarning: "Unmapped folder → fallback domain: {rel}",
};

export function textsFor(language: "zh" | "en"): Texts {
  return language === "zh" ? { ...TEXTS_ZH } : { ...TEXTS_EN };
}

/**
 * 把 `language: "auto"` 解析成具体语言：locale 以 zh 开头 → 中文，其余 → 英文。
 * locale 由调用方提供（插件传 Obsidian 的语言，CLI 传环境变量）。
 */
export function resolveLanguage(language: Settings["language"], locale: string | undefined): "zh" | "en" {
  if (language === "zh" || language === "en") return language;
  return (locale ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * 换成另一种语言的内置文案，保留用户逐项改过的文案。
 * “改过”指既不等于中文内置值、也不等于英文内置值——只和目标语言比的话，
 * 切换语言时旧语言的每一项都会被当成自定义而留下来，切了等于没切。
 */
export function retargetTexts(current: Texts, language: "zh" | "en"): Texts {
  const zh = textsFor("zh");
  const en = textsFor("en");
  const out = textsFor(language);
  for (const k of Object.keys(out) as Array<keyof Texts>) {
    if (current[k] !== zh[k] && current[k] !== en[k]) out[k] = current[k];
  }
  return out;
}

/**
 * `language: "auto"` → 按 locale 换上对应语言的内置文案（逐项保留用户改过的）。
 * 返回是否发生了变更。插件只在首次安装和用户把语言设成 auto 时调用：
 * 已在用的 vault 不因 Obsidian 换了界面语言就把所有区块重写一遍。
 */
export function applyAutoTexts(s: Settings, locale: string | undefined): boolean {
  if (s.language !== "auto") return false;
  const next = retargetTexts(s.texts, resolveLanguage("auto", locale));
  if (JSON.stringify(next) === JSON.stringify(s.texts)) return false;
  s.texts = next;
  return true;
}

// ---------------------------------------------------------------- 通用默认值

const FALLBACK_DOMAIN: DomainRule = {
  id: "unsorted",
  name: "Unsorted",
  paths: [],
  rootKeywords: [],
  rootKeywordsLower: [],
  rootPrefixes: [],
  priority: 0,
};

/** MOC 目录默认名（moc.ts 的安全化兜底也用它，避免两处各写一个字面量） */
export const DEFAULT_MOC_FOLDER = "_moc";

export function defaultSettings(): Settings {
  return {
    version: 1,
    language: "auto",
    ui: { advancedOpen: false },
    scan: {
      excludeTopDirs: ["_tmp", "_archive", "_moc"],
      excludeAnyDirs: ["node_modules"],
      excludeGlobs: [],
      excludeHidden: true,
      excludeTemplates: true,
      skipPluginFiles: true,
    },
    // 空 → 由向导/首次运行自动探测（每个顶层目录一个领域）
    domains: [],
    fallbackDomain: { ...FALLBACK_DOMAIN },
    entities: {
      fromTitles: true,
      fromTags: true,
      tagMode: "top",
      manual: [],
      autoAccepted: [],
      stopwords: [],
      minLength: 2,
      ignoreInCode: false,
    },
    related: {
      enabled: true,
      topN: 5,
      sameDomainBoost: 1.5,
      minScore: 0,
      blockTag: "AUTO-LINKS",
    },
    moc: {
      enabled: true,
      folder: DEFAULT_MOC_FOLDER,
      homeFile: "Home",
      includeSummary: true,
      summaryMaxChars: 60,
      excludedNote: "",
    },
    frontmatter: {
      // 默认关：只给还没有 frontmatter 的笔记补，已有的和挪过目录的都不更新，
      // 这个标签既不全也不准，拿它筛选会漏；需要时再打开
      enabled: false,
      tagPrefix: "domain/",
      optOutKey: "vault-linker",
      optOutValue: "ignore",
    },
    daily: {
      enabled: false,
      dirPrefix: "reports/daily/",
      domainId: "daily",
      fileRegex: "D-(\\d{4}-\\d{2}-\\d{2})\\.md$",
      blockTag: "DELIVERABLES",
      sourceBlockTag: "SOURCE-LINK",
      allowedExtensions: [
        "md", "py", "json", "ts", "js", "jsx", "tsx", "swift", "yaml", "yml",
        "csv", "txt", "html", "sh", "sql", "dart", "kt", "toml", "ini", "xml",
      ],
      stripPathPrefixes: [],
      scanBackticks: true,
      scanBarePaths: true,
      barePathPrefixes: [],
    },
    trigger: {
      // 第三方安全默认：装完**什么都不自动做**（不轮询、不写盘）。
      // 新用户先在设置页点「预览」看过效果，再显式打开「监听文件变更」与「自动写入」。
      onFileChange: false,
      autoApply: false,
      pollIntervalSec: 20,
      quietPeriodSec: 30,
      stableScans: 2,
      runOnStartup: false,
    },
    safety: {
      dryRunByDefault: true,
      skipIfChanged: true,
      verifyStrippedBytes: true,
    },
    texts: textsFor("en"),
  };
}


/** 中文研究型 vault：中文文案 + 自动探测领域 + 标题/标签派生实体。 */
export function zhResearchPreset(): Settings {
  const s = defaultSettings();
  s.language = "zh";
  s.texts = { ...TEXTS_ZH };
  s.scan.excludeTopDirs = ["_tmp", "_archive", "_moc"];
  s.scan.excludeAnyDirs = ["node_modules"];
  return s;
}

export const PRESETS: Record<string, { label: string; build: () => Settings }> = {
  generic: { label: "通用默认（零配置）", build: defaultSettings },
  "zh-research": { label: "中文研究型 vault", build: zhResearchPreset },
};

// ---------------------------------------------------------------- 加载/合并

/** 深度合并已保存的设置（保留默认值兜底，兼容旧版本缺字段）。 */
export function mergeSettings(base: Settings, saved: unknown): Settings {
  if (!saved || typeof saved !== "object") return base;
  return mergeOneLevel(base as unknown as Record<string, unknown>, saved as Record<string, unknown>) as unknown as Settings;
}

/**
 * 合并一层配置对象（本项目的配置最深两层，一个函数就够）：
 *   - 嵌套对象再深合一层，缺的键回落到默认值（防旧版配置少一段就崩）
 *   - **数值字段只接受有限数字**：NaN / 字符串 / null 会让定时器或循环失控
 *     （如 setInterval(NaN) 会变成满速空转）
 */
function mergeOneLevel(base: Record<string, unknown>, saved: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) {
    const v = saved[key];
    if (v === undefined || v === null) continue;
    const b = base[key];
    if (b !== null && typeof b === "object" && !Array.isArray(b)) {
      // 嵌套配置：只接受对象，缺失的键回落到默认值（防旧版分享码少一段就崩）；
      // 递归合并，使嵌套层同样享有下面的类型/有限性校验
      if (typeof v === "object" && !Array.isArray(v)) {
        out[key] = mergeOneLevel(b as Record<string, unknown>, v as Record<string, unknown>);
      }
      continue;
    }
    // 标量/数组：类型不符就保留默认值。数值额外要求有限，
    // 否则 NaN 会让定时器满速空转（setInterval(NaN)）
    if (typeof v === typeof b && !(typeof b === "number" && !Number.isFinite(v as number))) out[key] = v;
  }
  return out;
}

/** 供首次运行向导使用：按顶层目录自动生成领域规则。 */
export function detectDomainsFromDirs(topDirs: readonly string[]): DomainRule[] {
  const skip = new Set(["_moc", "_tmp", "_archive", "node_modules", "videos"]);
  return topDirs
    .filter((d) => !d.startsWith(".") && !skip.has(d))
    .map((d) => ({
      id: slugify(d),
      name: d,
      paths: [d],
      rootKeywords: [],
      rootKeywordsLower: [],
      rootPrefixes: [],
      priority: 0,
    }));
}

function slugify(s: string): string {
  const ascii = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "domain";
}

export function todayIso(): string {
  return localIsoDate();
}
