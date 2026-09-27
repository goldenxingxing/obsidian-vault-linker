/**
 * fixture.ts — 测试用的完整配置：把各种规则都用上的一个虚构 vault
 *
 * 通用默认值只有「按顶层目录一个领域 + 标题/tag 作实体」，覆盖不到这些规则：
 * 多个目录合成一个领域、子目录领域抢在父目录前面（priority）、根目录散落文件按关键词和
 * 前缀归类、手写词表（拉丁词带词边界、中文词不带）、日报 ↔ 产出追溯。
 */

import { defaultSettings, textsFor, type Settings } from "../src/core/settings.ts";

export function samplePreset(): Settings {
  const s = defaultSettings();
  s.language = "zh";
  s.texts = {
    ...textsFor("zh"),
    homeTotalLine: "**在范围文档总数：{total} 篇**（已排除 {excluded} 等目录）",
  };
  s.trigger = { ...s.trigger, onFileChange: true, autoApply: true };
  s.scan = {
    excludeTopDirs: ["videos", "_tmp", "_archive", "_moc"],
    excludeAnyDirs: ["node_modules"],
    excludeGlobs: [],
    excludeHidden: true,
    excludeTemplates: true,
    skipPluginFiles: true,
  };
  s.domains = [
    { id: "engineering", name: "工程", paths: ["eng", "eng_perf", "infra"], rootKeywords: ["缓存", "评估报告"], rootKeywordsLower: ["eng", "infra"], rootPrefixes: [], priority: 0 },
    { id: "hardware", name: "硬件", paths: ["hw", "hw_test"], rootKeywords: [], rootKeywordsLower: [], rootPrefixes: ["样机"], priority: 0 },
    { id: "research", name: "调研", paths: ["research", "papers"], rootKeywords: [], rootKeywordsLower: [], rootPrefixes: [], priority: 0 },
    { id: "review-report", name: "评审与汇报", paths: ["reviews", "reports"], rootKeywords: [], rootKeywordsLower: [], rootPrefixes: [], priority: 0 },
    // 子目录抢在 reports 前面匹配
    { id: "daily", name: "日报索引", paths: ["reports/daily"], rootKeywords: [], rootKeywordsLower: [], rootPrefixes: [], priority: -1 },
    { id: "product", name: "产品与项目", paths: ["projects"], rootKeywords: [], rootKeywordsLower: [], rootPrefixes: [], priority: 0 },
  ];
  s.fallbackDomain = { ...s.fallbackDomain, id: "root-unsorted", name: "根目录待归档" };
  s.entities = {
    fromTitles: false,
    fromTags: false,
    tagMode: "top",
    manual: [
      ...["API", "Redis", "Kafka", "SQL", "gRPC"].map((term) => ({ term, aliases: [], caseSensitive: false, wordBoundary: true, weight: 1 })),
      ...["缓存", "分布式", "延迟"].map((term) => ({ term, aliases: [], caseSensitive: true, wordBoundary: false, weight: 1 })),
    ],
    autoAccepted: [],
    stopwords: [],
    minLength: 2,
    ignoreInCode: false,
  };
  s.moc = { enabled: true, folder: "_moc", homeFile: "00-主页", includeSummary: true, summaryMaxChars: 60, excludedNote: "videos/、_tmp/、_archive/" };
  s.frontmatter = { enabled: true, tagPrefix: "domain/", optOutKey: "vault-linker", optOutValue: "ignore" };
  s.daily = {
    ...s.daily,
    enabled: true,
    dirPrefix: "reports/daily/",
    fileRegex: "D-(\\d{4}-\\d{2}-\\d{2})\\.md$",
    stripPathPrefixes: ["output/"],
    barePathPrefixes: ["output/"],
  };
  return s;
}
