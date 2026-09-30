/**
 * core.test.ts — 核心引擎单元测试（node --test 直接跑 TS）
 * 重点覆盖字符串语义层（pycompat）与写入格式的边界情形。
 */

import { test } from "node:test";
import { samplePreset } from "./fixture.ts";
import assert from "node:assert/strict";

import {
  pyCompare, pyLen, pySlice, pySort, pySplitLines, pyStrip, pyUniversalNewlines, localIsoDate,
} from "../src/core/pycompat.ts";
import { appendEndBlock, stripEndBlock } from "../src/core/blocks.ts";
import {
  hasFrontmatter, isOptedOut, parseFrontmatterTags,
} from "../src/core/frontmatter.ts";
import { cleanAlias, summaryOf, titleOf, wikilink } from "../src/core/text.ts";
import { collectInScope, ensureDomains, globMatch, templatePaths, withRuntimeExcludes } from "../src/core/scope.ts";
import { withOriginalEol } from "../src/core/text.ts";
import { applyPlan } from "../tools/cli/apply.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync as readF, writeFileSync as writeF } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { classify } from "../src/core/classify.ts";
import { planRun, type PlanOutput } from "../src/core/engine.ts";
import {
  defaultSettings, mergeSettings, retargetTexts, applyAutoTexts, textsFor, newDomain, upgradeBuiltins, type Settings,
} from "../src/core/settings.ts";
import { homePath, isForeignMoc, mocPath, safeDirPath, safeFileName } from "../src/core/moc.ts";
import { domainsToText, entitiesToText, textToDomains, textToEntities } from "../src/core/config-text.ts";
import type { DomainRule } from "../src/core/settings.ts";
import { computeDf, rankRelated } from "../src/core/score.ts";
import { buildEntityMatchers, entitiesOf, entityText, matcherFallbackHit } from "../src/core/entities.ts";

const Q = samplePreset();
const TODAY = "2026-09-24";

// ---------------------------------------------------------------- pycompat

test("pySort 按 code point 排序（astral 字符与 UTF-16 排序不同）", () => {
  const items = ["b", "\u{1F600}", "a", "\uFFFD"];
  // code point: 'a'(0x61) < 'b'(0x62) < U+FFFD < U+1F600
  assert.deepEqual(pySort(items), ["a", "b", "\uFFFD", "\u{1F600}"]);
  // 对照：JS 默认排序把 astral 字符排到 \uFFFD 之前（UTF-16 代理对 0xD83D）
  const naive = [...items].sort();
  assert.notDeepEqual(naive, pySort(items));
});

test("pyCompare 与 Python 字符串比较一致", () => {
  assert.equal(pyCompare("a", "b"), -1);
  assert.equal(pyCompare("b", "a"), 1);
  assert.equal(pyCompare("中文", "中文"), 0);
  assert.equal(pyCompare("a", "ab"), -1);
});

test("pyStrip 用 Python 的空白集合（\uFEFF 不算空白，\x1c 算）", () => {
  assert.equal(pyStrip("\uFEFF abc \uFEFF"), "\uFEFF abc \uFEFF".trim() === "" ? "" : "\uFEFF abc \uFEFF");
  assert.equal(pyStrip("\x1c abc \x85"), "abc");
  assert.equal(pyStrip("\uFEFFabc\uFEFF"), "\uFEFFabc\uFEFF"); // JS trim 会剥掉 \uFEFF，Python 不会
});

test("pyLen / pySlice 按 code point 计数（不是 UTF-16）", () => {
  const s = "a\u{1F600}b";
  assert.equal(s.length, 4);
  assert.equal(pyLen(s), 3);
  assert.equal(pySlice(s, 2), "a\u{1F600}");
});

test("pySplitLines 的行边界比 split('\\n') 多", () => {
  assert.deepEqual(pySplitLines("a\nb\r\nc\rd"), ["a", "b", "c", "d"]);
  assert.deepEqual(pySplitLines("a\u2028b"), ["a", "b"]);
  assert.deepEqual(pySplitLines(""), []);
});

test("pySplitLines 尾换行不产生多余空元素（逐例对照 python str.splitlines）", () => {
  // 对照 python3：'a\n' -> ['a']（行边界已经关闭了前一行，末尾空串不构成新行）
  assert.deepEqual(pySplitLines("a\n"), ["a"]);
  assert.deepEqual(pySplitLines("a\r\n"), ["a"]);
  assert.deepEqual(pySplitLines("a"), ["a"]);
  // 但 'a\n\n' -> ['a','']：末尾空元素来自第二个边界，不是尾部残片
  assert.deepEqual(pySplitLines("a\n\n"), ["a", ""]);
  assert.deepEqual(pySplitLines("\n"), [""]);
  assert.deepEqual(pySplitLines("a\vb"), ["a", "b"]);
});

test("pyUniversalNewlines 复刻 Python 文本模式的通用换行", () => {
  assert.equal(pyUniversalNewlines("a\r\nb\rc\n"), "a\nb\nc\n");
});

test("localIsoDate 是本地日期而非 UTC", () => {
  const d = new Date(2026, 8, 24, 0, 30, 0); // 本地 2026-09-24 00:30
  assert.equal(localIsoDate(d), "2026-09-24");
});

// ---------------------------------------------------------------- blocks

test("appendEndBlock 的 glue 三分支", () => {
  assert.equal(appendEndBlock("", "T", "BODY\n"), "---\n<!-- T:START -->\nBODY\n<!-- T:END -->\n");
  assert.equal(appendEndBlock("x\n", "T", "BODY\n"), "x\n\n---\n<!-- T:START -->\nBODY\n<!-- T:END -->\n");
  assert.equal(appendEndBlock("x", "T", "BODY\n"), "x\n\n---\n<!-- T:START -->\nBODY\n<!-- T:END -->\n");
});

test("stripEndBlock 幂等：剥离后重新追加得到同一字节", () => {
  const body = "## 相关文档\n\n- 导航：[[_moc/A]]\n";
  const once = appendEndBlock("正文\n", "AUTO-LINKS", body);
  const twice = appendEndBlock(stripEndBlock(once, "AUTO-LINKS"), "AUTO-LINKS", body);
  assert.equal(once, twice);
});

test("stripEndBlock 全局替换（多个区块都剥掉，JS 漏 g 标志就只剥第一处）", () => {
  const one = "a\n\n---\n<!-- X:START -->\n1\n<!-- X:END -->\n";
  const two = one + "\n---\n<!-- X:START -->\n2\n<!-- X:END -->\n";
  assert.equal(stripEndBlock(two, "X"), "a\n");
});

// ---------------------------------------------------------------- frontmatter

test("hasFrontmatter / opt-out 只在 frontmatter 内生效", () => {
  assert.equal(hasFrontmatter("---\ntags: [a]\n---\n正文"), true);
  assert.equal(hasFrontmatter("正文\n---\ntags: [a]\n---\n"), false);
  assert.equal(isOptedOut("---\nvault-linker: ignore\n---\n正文", Q), true);
  assert.equal(isOptedOut("---\ntags: [a]\n---\nvault-linker: ignore\n", Q), false);
});

test("parseFrontmatterTags 支持行内与块序列", () => {
  assert.deepEqual(parseFrontmatterTags("---\ntags: [a, b]\n---\n").tags, ["a", "b"]);
  assert.deepEqual(parseFrontmatterTags("---\ntags:\n  - a\n  - b\n---\n").tags, ["a", "b"]);
  assert.deepEqual(parseFrontmatterTags("---\ntags: a, b\n---\n").tags, ["a", "b"]);
});

// ---------------------------------------------------------------- text

test("titleOf / summaryOf", () => {
  assert.equal(titleOf("# 我的标题\n正文\n", "a/b.md", Q), "我的标题");
  assert.equal(titleOf("没有标题\n", "a/b.md", Q), "b");
  assert.equal(summaryOf("# 标题\n\n> 引用行\n", Q), "引用行");
  assert.equal(summaryOf("# 标题\n", Q), Q.texts.noSummary);
  // 摘要里 wikilink / markdown 链接转纯文本
  assert.equal(summaryOf("看 [[a/b|目标]] 和 [文字](http://x)\n", Q), "看 目标 和 文字");
});

test("summaryOf 跳过表格行 / 代码块 / 注释 / 分隔线，只留可读内容", () => {
  // 表格行（含分隔行）不是摘要，继续往后找
  assert.equal(summaryOf("# 标题\n\n| 时间 | 事项 |\n|---|---|\n| 9月 | 上线 |\n真正的内容。\n", Q), "真正的内容。");
  // 代码块：定界符本身和块内内容都不取
  assert.equal(summaryOf("# 标题\n\n```\ncode\n```\n正文。\n", Q), "正文。");
  assert.equal(summaryOf("# 标题\n\n~~~\ncode\n~~~\n正文。\n", Q), "正文。");
  // HTML 注释：单行与多行
  assert.equal(summaryOf("# 标题\n\n<!-- 单行 -->\n正文。\n", Q), "正文。");
  assert.equal(summaryOf("# 标题\n\n<!-- 多行\n注释 -->\n正文。\n", Q), "正文。");
  // 整篇只有标题 + 表格 → 回落到无摘要
  assert.equal(summaryOf("# 标题\n\n| a | b |\n", Q), Q.texts.noSummary);
});

test("summaryOf 列表项去标记、行内标记转纯文本", () => {
  assert.equal(summaryOf("# 标题\n\n- 第一项要点\n正文。\n", Q), "第一项要点");
  assert.equal(summaryOf("# 标题\n\n* 第一项要点\n正文。\n", Q), "第一项要点");
  assert.equal(summaryOf("# 标题\n\n1. 第一项要点\n正文。\n", Q), "第一项要点");
  assert.equal(summaryOf("结论：**TinyLFU 最好**\n", Q), "结论：TinyLFU 最好");
  assert.equal(summaryOf("用 `MEMORY PURGE` 清理\n", Q), "用 MEMORY PURGE 清理");
  assert.equal(summaryOf("删除 ~~旧值~~ 描述\n", Q), "删除 旧值 描述");
  assert.equal(summaryOf("见 <strong>这里</strong>\n", Q), "见 这里");
  // `-` 紧跟非空白不是列表标记
  assert.equal(summaryOf("-5 度以下\n", Q), "-5 度以下");
  assert.equal(summaryOf("1.5 倍\n", Q), "1.5 倍");
  // 整行只有标记 → 继续往后找，别返回空摘要
  assert.equal(summaryOf("# 标题\n\n*\n**\n正文。\n", Q), "正文。");
  // 粗体 / 删除线不用 lookbehind 实现（iOS 16.4 之前不支持），相邻的标记也要逐个去掉
  assert.equal(summaryOf("**a** 和 **b**\n", Q), "a 和 b");
  assert.equal(summaryOf("**a****b**\n", Q), "ab");
});

test("summaryOf 按 code point 截断（不是 UTF-16）", () => {
  const s = "😀".repeat(70); // 70 code points / 140 UTF-16 units
  const out = summaryOf(s + "\n", Q);
  assert.equal(pyLen(out), 61); // 60 + 省略号
  assert.equal(out.endsWith("…"), true);
  assert.equal(out.length, 121); // 60 个 emoji = 120 UTF-16 单元 + 1
});

test("cleanAlias / wikilink", () => {
  assert.equal(cleanAlias(" a|b[c]d "), "a/b c d");
  assert.equal(wikilink("a/b.md", "显示"), "[[a/b|显示]]");
  assert.equal(wikilink("a/b.md"), "[[a/b]]");
});

// ---------------------------------------------------------------- scope / classify

test("globMatch：无通配符按目录前缀，* 不跨 /，** 跨 /", () => {
  assert.equal(globMatch("eng", "eng/x.md"), true);
  assert.equal(globMatch("eng", "eng_sub/x.md"), false);
  assert.equal(globMatch("reports/**", "reports/daily/26-9月/D-1.md"), true);
  assert.equal(globMatch("a/*/b.md", "a/x/b.md"), true);
  assert.equal(globMatch("a/*/b.md", "a/x/y/b.md"), false);
});

test("collectInScope：剪枝与逐层遍历一致，且 excluded 恒为 0", () => {
  const files = ["a.md", "dir/b.md", ".hidden/c.md", "_moc/d.md", "videos/e.md", "x/node_modules/f.md"];
  const r = collectInScope(files, Q);
  assert.deepEqual(r.inScope, ["a.md", "dir/b.md"]);
  assert.equal(r.excludedCount, 0);
});

test("classify：目录映射、reports 特例、根目录关键词", () => {
  assert.equal(classify("eng/a.md", Q).domainId, "engineering");
  assert.equal(classify("reports/daily/26-9月/D-1.md", Q).domainId, "daily");
  assert.equal(classify("reports/other.md", Q).domainId, "review-report");
  assert.equal(classify("reviews/a.md", Q).domainId, "review-report");
  assert.equal(classify("未知目录/a.md", Q).domainId, "root-unsorted");
  assert.equal(classify("未知目录/a.md", Q).unmapped, true);
  assert.equal(classify("缓存算法说明.md", Q).domainId, "engineering");
  assert.equal(classify("样机0722.md", Q).domainId, "hardware");
  assert.equal(classify("杂项.md", Q).domainId, "root-unsorted");
});

// ---------------------------------------------------------------- engine（端到端 + 幂等）

function makeVault(files: Record<string, string>): { contents: Map<string, string>; allFiles: string[] } {
  const contents = new Map<string, string>();
  const allFiles: string[] = [];
  for (const [k, v] of Object.entries(files)) {
    allFiles.push(k);
    if (k.endsWith(".md")) contents.set(k, v);
  }
  return { contents, allFiles };
}

function runOnce(
  files: Record<string, string>,
  moc: Map<string, string>,
  s: Settings,
): { out: PlanOutput; files: Record<string, string>; moc: Map<string, string> } {
  const { contents, allFiles } = makeVault(files);
  const out = planRun({
    settings: s,
    today: TODAY,
    allFiles,
    contents,
    mocContents: moc,
  });
  // 注意：只把“正文变更”写回正文，MOC 单独维护（MOC 不在扫描范围内，不能混进 contents）
  const next = { ...files };
  for (const rel of out.changedDocs) next[rel] = out.newContents.get(rel) as string;
  const nextMoc = new Map(moc);
  for (const [k, v] of out.mocChanges) nextMoc.set(k, v.new);
  return { out, files: next, moc: nextMoc };
}

test("引擎端到端：生成 MOC + 互链，且二次运行 0 修改（幂等）", () => {
  const files: Record<string, string> = {
    "eng/a.md": "# A 文档\n\n关于 API 与缓存的说明。\n",
    "eng/b.md": "# B 文档\n\n同样讨论 API 与缓存。\n",
    "reviews/c.md": "# C 文档\n\n与 API 无关，只谈评审流程。\n",
  };
  const first = runOnce(files, new Map(), Q);
  assert.equal(first.out.report.scanned, 3);
  assert.equal(first.out.report.mocPlanned, 8); // 6 个领域 + 兜底 + 主页
  assert.ok(first.out.report.autoLinkTotal > 0);
  // A 与 B 共享 API+缓存，应互链
  assert.match(first.files["eng/a.md"], /\[\[eng\/b\|B 文档\]\]/);
  // 正文原样保留在开头，不补 frontmatter
  assert.ok(first.files["eng/a.md"].startsWith(files["eng/a.md"]));
  // MOC 里按领域分组
  assert.match(first.moc.get("_moc/工程.md") as string, /^# 工程$/m);
  assert.match(first.moc.get("_moc/00-主页.md") as string, /在范围文档总数：3 篇/); // 样例配置自定义了这行

  const second = runOnce(first.files, first.moc, Q);
  assert.equal(second.out.report.plannedChanges, 0, "二次运行不应再有正文改动");
  assert.equal(second.out.report.mocPlanned, 0, "二次运行不应再有 MOC 改动");
});

test("opt-out 文档零改动", () => {
  const files: Record<string, string> = {
    "eng/opt.md": "---\nvault-linker: ignore\n---\n\n# 别碰我\n\nAPI 缓存\n",
  };
  const r = runOnce(files, new Map(), Q);
  assert.equal(r.files["eng/opt.md"], files["eng/opt.md"]);
});

test("边界：无尾换行 / 空文件 / 正文含 --- / BOM", () => {
  const files: Record<string, string> = {
    "eng/noeol.md": "# 无尾换行\n\nAPI",
    "eng/empty.md": "",
    "eng/dashes.md": "# 破折号\n\n---\n\nAPI 缓存\n",
    "eng/bom.md": "\uFEFF# 带 BOM\n\nAPI\n",
  };
  const first = runOnce(files, new Map(), Q);
  const second = runOnce(first.files, first.moc, Q);
  assert.equal(second.out.report.plannedChanges, 0);
  // 空文件：区块从第一行开始（glue 为空串分支），分隔线用 ***，不留一个没闭合的 ---
  const empty = first.files["eng/empty.md"];
  assert.ok(empty.startsWith("***\n<!-- AUTO-LINKS:START -->\n"));
  assert.ok(empty.endsWith("<!-- AUTO-LINKS:END -->\n"));
  // BOM 保留在正文开头之后（不剥 BOM）
  assert.ok(first.files["eng/bom.md"].includes("\uFEFF"));
});

test("整词匹配（不用 lookbehind）与 lookbehind 正则语义一致", () => {
  const cases = [
    "API", "api", "a API b", "x_API_y", "API_x", "x_API", "APIs", "MAPI", "API. 缓存",
    "a-API-b", "  API  ", "缓存API", "API读数", "（API）", "api\napi", "ACL S", "API_", "ΑPI", "İAPI", "straße API",
  ];
  const rules = [
    { caseSensitive: false, wordBoundary: true },
    { caseSensitive: true, wordBoundary: true },
    { caseSensitive: false, wordBoundary: false },
  ];
  for (const rule of rules) {
    const s = defaultSettings();
    s.entities.fromTitles = false;
    s.entities.fromTags = false;
    s.entities.manual = [{ term: "API", aliases: [], weight: 1, ...rule }];
    const [m] = buildEntityMatchers(s, []);
    // 对照组：测试里可以用 lookbehind（插件代码不能）
    const re = rule.wordBoundary
      ? new RegExp("(?<![A-Za-z0-9_])API(?![A-Za-z0-9_])", rule.caseSensitive ? "g" : "gi")
      : (m.re as RegExp);
    for (const text of cases) {
      re.lastIndex = 0;
      const viaRegex = re.test(text);
      assert.equal(matcherFallbackHit(text, m), viaRegex,
        "文本=" + JSON.stringify(text) + " 规则=" + JSON.stringify(rule));
    }
  }
  // 中文词（无边界、大小写敏感）
  const s2 = defaultSettings();
  s2.entities.fromTitles = false;
  s2.entities.fromTags = false;
  s2.entities.manual = [{ term: "缓存", aliases: [], weight: 1, caseSensitive: true, wordBoundary: false }];
  const [m2] = buildEntityMatchers(s2, []);
  const re2 = m2.re as RegExp;
  for (const text of ["缓存", "非缓存系统", "无"]) {
    re2.lastIndex = 0;
    assert.equal(matcherFallbackHit(text, m2), re2.test(text), text);
  }
});

test("默认设置（generic）零配置也能工作", () => {
  const s = defaultSettings();
  const files: Record<string, string> = {
    "notes/alpha.md": "# Alpha\n\nSee beta for details.\n",
    "notes/beta.md": "# Beta\n\nAlpha mentions me.\n",
  };
  const r = runOnce(files, new Map(), s);
  // 领域为空 -> 自动探测前，全部落 fallback；仍应产出 MOC 与互链
  assert.equal(r.out.report.mocPlanned, 2); // Home + 一个 fallback 领域页
  assert.ok(r.out.report.autoLinkTotal > 0);
});

// ---------------------------------------------------------------- 配置安全化

test("mocPath/homePath 对配置里的名字做安全化（防 ../ 逃出 MOC 目录）", () => {
  const s = samplePreset();
  // 正常名字不受影响
  assert.equal(mocPath(s.domains[0], s), `_moc/${s.domains[0].name}.md`);

  assert.equal(safeFileName(".."), "_");
  assert.equal(safeFileName("."), "_");
  assert.equal(safeFileName(""), "_");
  assert.equal(safeFileName("a/b"), "a-b");
  assert.equal(safeDirPath(""), "_moc");
  assert.equal(safeDirPath("../../etc"), "etc");
  assert.equal(safeDirPath("_moc/../x"), "_moc/x");

  // 恶意/手滑的领域名不能产生越界路径
  const evil = { ...s.domains[0], name: "../../evil" };
  const p = mocPath(evil, s);
  assert.equal(p, "_moc/-..-evil.md");
  assert.equal(p.split("/").length, 2);
  assert.equal(p.split("/").some((seg) => seg === ".." || seg === "."), false);

  const s2 = { ...s, moc: { ...s.moc, folder: "../../x", homeFile: ".." } };
  assert.equal(homePath(s2), "x/_.md");
});

test("mergeSettings：坏配置不破坏数值/数组/嵌套段（旧版分享码也安全）", () => {
  const d = defaultSettings();
  const m = mergeSettings(d, {
    trigger: { pollIntervalSec: "abc", quietPeriodSec: 5 },
    moc: null,
    scan: { excludeTopDirs: null },
    domains: "nope",
  });
  assert.equal(m.trigger.pollIntervalSec, d.trigger.pollIntervalSec); // 类型不符 → 保留默认
  assert.equal(m.trigger.quietPeriodSec, 5);                         // 合法值生效
  assert.equal(m.moc.folder, d.moc.folder);                          // 整段坏值 → 回落
  assert.deepEqual(m.scan.excludeTopDirs, d.scan.excludeTopDirs);    // 数组坏值 → 回落
  assert.deepEqual(m.domains, d.domains);
  // NaN 也不能进来：setInterval(NaN) 会满速空转
  const nan = mergeSettings(d, { trigger: { pollIntervalSec: Number.NaN } });
  assert.equal(nan.trigger.pollIntervalSec, d.trigger.pollIntervalSec);
});

test("domainsToText / textToDomains 往返不丢字段", () => {
  const s = samplePreset();
  // 设置页每次渲染都走 配置→文本→配置，任何丢字段都会静默改掉用户配置
  assert.deepEqual(textToDomains(domainsToText(s.domains)), s.domains);
  const text = domainsToText(s.domains);
  assert.equal(domainsToText(textToDomains(text)), text);
});

test("textToDomains 容错：注释/空行/列数不足的行被忽略", () => {
  const d = textToDomains("# 注释\n\n只有一列\nx | X 领域 | a, b\n");
  assert.equal(d.length, 1);
  assert.deepEqual(d[0], {
    id: "x", name: "X 领域", paths: ["a", "b"],
    rootKeywords: [], rootKeywordsLower: [], rootPrefixes: [], priority: 0,
  });
  assert.equal(textToDomains(" | 只有显示名")[0].id, "只有显示名");
});

test("entitiesToText / textToEntities 往返 + 拉丁词自动放宽大小写", () => {
  const rules = textToEntities("API = 应用程序接口, 接口\n缓存");
  assert.deepEqual(textToEntities(entitiesToText(rules)), rules);
  assert.deepEqual(rules[0], {
    term: "API", aliases: ["应用程序接口", "接口"],
    caseSensitive: false, wordBoundary: true, weight: 1,
  });
  assert.deepEqual(rules[1], { term: "缓存", aliases: [], caseSensitive: true, wordBoundary: false, weight: 1 });
  assert.equal(entitiesToText(rules), "API = 应用程序接口, 接口\n缓存");
});

test("领域表：忽略大小写关键词列可省略（自动派生），显式给出时不被改写", () => {
  // 6 列 = 省略该列 → 用根关键词的小写派生
  const short = textToDomains("x | X 领域 | dir | Foo,Bar | pre | 3")[0];
  assert.deepEqual(short, {
    id: "x", name: "X 领域", paths: ["dir"],
    rootKeywords: ["Foo", "Bar"], rootKeywordsLower: ["foo", "bar"],
    rootPrefixes: ["pre"], priority: 3,
  });
  // 7 列 = 显式给出，即使与派生值不同也照用（engineering 就是这种）
  assert.deepEqual(textToDomains("x | X | dir | Foo | baz | pre | 3")[0].rootKeywordsLower, ["baz"]);
  // 7 列且该列为空 = 明确表示"不做忽略大小写匹配"，不能被自动派生覆盖
  assert.deepEqual(textToDomains("x | X | dir | Foo | | pre | 3")[0].rootKeywordsLower, []);
  // 写出时只有"确实不同"才带这一列
  const explicit: DomainRule = {
    id: "a", name: "A", paths: [], rootKeywords: ["Foo"], rootKeywordsLower: ["baz"],
    rootPrefixes: [], priority: 0,
  };
  const derived: DomainRule = { ...explicit, rootKeywordsLower: ["foo"] };
  assert.equal(domainsToText([explicit]).split("|").length, 7);
  assert.equal(domainsToText([derived]).split("|").length, 6);
});

test("打分并列（<1e-12 相对差）按路径排序，不受浮点求和顺序影响", () => {
  const s = defaultSettings();
  // target 与 a/b 各共享一个实体，两者得分相差恰好 1 ULP
  const docEntities = new Map<string, Set<string>>([
    ["target.md", new Set(["e1", "e2"])],
    ["a.md", new Set(["e1"])],
    ["b.md", new Set(["e2"])],
  ]);
  const df = computeDf(docEntities); // e1/e2 各出现在 2 篇 → 两边都是 1/2
  const domains = new Map([["target.md", "d"], ["a.md", "d"], ["b.md", "d"]]);
  const weights = new Map<string, number>([["e1", 1], ["e2", 1 + 2 ** -52]]); // b 高 1 ULP
  const r = rankRelated("target.md", ["target.md", "a.md", "b.md"], docEntities, domains, df, weights, s);
  assert.deepEqual(r.map((x) => x.rel), ["a.md", "b.md"], "1 ULP 差异视为并列 → 按路径排序");
});

// ---------------------------------------------------------------- 给别人用：首次安装与已有文件

test("通用默认：装完不监听、不自动写入，不带任何 vault 专用的路径前缀", () => {
  const d = defaultSettings();
  assert.equal(d.trigger.onFileChange, false);
  assert.equal(d.trigger.autoApply, false);
});

test("用户自己的同名 MOC（也打了 moc 标签）不被覆盖；本插件生成的照常更新", () => {
  const s = defaultSettings();
  const mine = "---\ntags: [moc]\ntype: moc\n---\n\n# 我自己的首页\n";
  const home = homePath(s);
  const one = (moc: Map<string, string>) => planRun({
    settings: s, today: TODAY, allFiles: ["a.md", ...moc.keys()],
    contents: new Map([["a.md", "# A\n"]]), mocContents: moc,
  });
  const out = one(new Map([[home, mine]]));
  assert.deepEqual(out.report.mocConflicts, [home]);
  assert.equal(out.mocChanges.has(home), false);
  // 没有冲突时生成的首页，下次运行必须被认作“自己的”
  const fresh = one(new Map());
  const generated = fresh.mocChanges.get(home)?.new as string;
  assert.equal(isForeignMoc(home, new Map([[home, generated]]), s), false);
  // 语言切换后，旧语言生成的页面也仍是“自己的”
  const en = { ...s, texts: textsFor("en") };
  assert.equal(isForeignMoc(home, new Map([[home, generated]]), en), false);
});

test("只差大小写的已有文件：跳过并报告，不去新建（macOS 上会抛 File already exists）", () => {
  const s = defaultSettings();
  s.domains = [{
    id: "notes", name: "notes", paths: ["notes"],
    rootKeywords: [], rootKeywordsLower: [], rootPrefixes: [], priority: 0,
  }];
  const out = planRun({
    settings: s, today: TODAY, allFiles: ["notes/a.md", "_moc/Notes.md"],
    contents: new Map([["notes/a.md", "# A\n"]]), mocContents: new Map([["_moc/Notes.md", "old"]]),
  });
  assert.ok(out.report.mocConflicts.includes("_moc/notes.md"));
  assert.equal(out.mocChanges.has("_moc/notes.md"), false);
});

test("切换语言：换上新语言的内置文案，只保留用户逐项改过的", () => {
  const zh = textsFor("zh");
  const custom = { ...zh, relatedHeading: "## 看看这些" };
  const en = retargetTexts(custom, "en");
  assert.equal(en.mocTitlePrefix, textsFor("en").mocTitlePrefix);
  assert.equal(en.relatedHeading, "## 看看这些");
  const s = defaultSettings();
  s.language = "auto";
  s.texts = textsFor("en");
  assert.equal(applyAutoTexts(s, "zh-cn"), true);
  assert.deepEqual(s.texts, textsFor("zh"));
  assert.equal(applyAutoTexts(s, "zh-cn"), false);
});

test("自动探测领域：只放附件的目录不成为领域", () => {
  const s = defaultSettings();
  assert.equal(ensureDomains(s, ["Notes/a.md", "attachments/x.png", "b.md"]), true);
  assert.deepEqual(s.domains.map((d) => d.id), ["notes"]);
  assert.equal(ensureDomains(s, ["Other/c.md"]), false); // 已有领域 → 不动
});

// ---------------------------------------------------------------- 给别人用：不该碰的文件、收敛、写盘字节

/** 用通用默认值跑一次（MOC 当成 vault 里的文件一起传入） */
function genericRun(files: Record<string, string>, s: Settings, today = TODAY): PlanOutput {
  const all = Object.keys(files);
  const inScope = collectInScope(all, s).inScope;
  return planRun({
    settings: s, today, allFiles: all,
    contents: new Map(inScope.map((r) => [r, files[r]])),
    mocContents: new Map(all.filter((f) => f.startsWith(safeDirPath(s.moc.folder) + "/")).map((f) => [f, files[f]])),
  });
}

function converge(files: Record<string, string>, s: Settings, rounds = 3): number[] {
  const changes: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const p = genericRun(files, s);
    changes.push(p.changedDocs.length + p.mocChanges.size);
    for (const r of p.changedDocs) files[r] = p.newContents.get(r) as string;
    for (const [k, v] of p.mocChanges) files[k] = v.new;
  }
  return changes;
}

test("模板：从 Obsidian 配置里读出模板目录与日记模板，并排除出扫描范围", () => {
  const cfg: Record<string, string> = {
    ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
    ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ templates_folder: "/Tpl/" }),
    ".obsidian/daily-notes.json": JSON.stringify({ template: "Meta/daily" }),
  };
  const paths = templatePaths((p) => cfg[p] ?? null, ".obsidian");
  assert.deepEqual(paths, ["Templates", "Tpl", "Meta/daily.md"]);
  const s = withRuntimeExcludes(defaultSettings(), paths);
  const inScope = collectInScope(["Templates/a.md", "Tpl/b.md", "Meta/daily.md", "Meta/x.md", "n.md"], s).inScope;
  assert.deepEqual(inScope, ["Meta/x.md", "n.md"]);
  // 关掉开关：不排除
  const off = { ...defaultSettings(), scan: { ...defaultSettings().scan, excludeTemplates: false } };
  assert.equal(withRuntimeExcludes(off, paths), off);
  assert.equal(templatePaths(() => "not json", ".obsidian").length, 0);
});

test("Excalidraw / Kanban 文件不写入、不参与互链", () => {
  const s = defaultSettings();
  const files: Record<string, string> = {
    "a.md": "# Alpha\n\nAlpha Beta\n",
    "b.md": "# Beta\n\nAlpha Beta\n",
    "draw.excalidraw.md": "---\nexcalidraw-plugin: parsed\n---\nAlpha Beta\n",
    "board.md": "---\nkanban-plugin: basic\n---\n## Alpha\n",
  };
  const p = genericRun(files, s);
  assert.deepEqual(p.changedDocs, ["a.md", "b.md"]);
  assert.ok(!(p.newContents.get("a.md") as string).includes("board"));
  assert.equal(p.report.excluded, 2);
});

test("旧版日报区块：下一次运行删掉，写后校验照常通过", () => {
  const s = defaultSettings();
  const note = "# A\n\n<!-- SOURCE-LINK:START -->\n> 出处\n<!-- SOURCE-LINK:END -->\nAlpha\n\n" +
    "---\n<!-- DELIVERABLES:START -->\n## 产出\n\n- [[x]]\n<!-- DELIVERABLES:END -->\n";
  const dir = mkdtempSync(pjoin(tmpdir(), "vl-legacy-"));
  writeF(pjoin(dir, "a.md"), note);
  writeF(pjoin(dir, "b.md"), "# Alpha\n");
  const p = planRun({
    settings: s, today: TODAY, allFiles: ["a.md", "b.md"],
    contents: new Map([["a.md", note], ["b.md", "# Alpha\n"]]),
  });
  const r = applyPlan(dir, p, s);
  assert.deepEqual(r.restored, []);
  assert.deepEqual(r.protectionFailed, []);
  const out = readF(pjoin(dir, "a.md"), "utf8");
  assert.ok(!out.includes("SOURCE-LINK") && !out.includes("DELIVERABLES"));
  assert.ok(out.startsWith("# A\nAlpha\n"));
  assert.ok(out.includes("AUTO-LINKS"));
});

test("CRLF 文件按 CRLF 写回", () => {
  const s = defaultSettings();
  assert.equal(withOriginalEol("a\nb\n", "x\r\ny"), "a\r\nb\r\n");
  assert.equal(withOriginalEol("a\nb\n", "x\ny"), "a\nb\n");
  const dir = mkdtempSync(pjoin(tmpdir(), "vl-crlf-"));
  writeF(pjoin(dir, "a.md"), "# A\r\n\r\nAlpha B\r\n");
  writeF(pjoin(dir, "b.md"), "# B\r\n\r\nAlpha\r\n");
  const p = planRun({
    settings: s, today: TODAY, allFiles: ["a.md", "b.md"],
    contents: new Map([["a.md", "# A\n\nAlpha B\n"], ["b.md", "# B\n\nAlpha\n"]]),
  });
  const r = applyPlan(dir, p, s);
  assert.deepEqual(r.restored, []);
  const raw = readF(pjoin(dir, "a.md"), "utf8");
  assert.ok(raw.includes("AUTO-LINKS"));
  assert.equal(raw.replace(/\r\n/g, "").includes("\n"), false, "不该留下单独的 \\n");
});

test("改了 MOC 目录名：生成的索引页不被当笔记扫描，第二轮起 0 修改", () => {
  const s = defaultSettings();
  s.moc.folder = "Index/";
  const files: Record<string, string> = { "Notes/a.md": "# A\n\nAlpha B\n", "Notes/b.md": "# B\n\nAlpha\n" };
  const [first, second, third] = converge(files, s);
  assert.ok(first > 0);
  assert.equal(second, 0);
  assert.equal(third, 0);
  assert.ok(Object.keys(files).some((f) => f.startsWith("Index/")));
});

test("索引页：只有日期变了不重写", () => {
  const s = defaultSettings();
  const files: Record<string, string> = { "Notes/a.md": "# A\n\nAlpha B\n", "Notes/b.md": "# B\n\nAlpha\n" };
  converge(files, s, 2);
  assert.equal(genericRun(files, s, "2026-09-25").mocChanges.size, 0);
  // 内容真的变了（新增笔记）→ 照常重写，日期一起更新
  files["Notes/c.md"] = "# C\n";
  const p = genericRun(files, s, "2026-09-25");
  assert.ok([...p.mocChanges.values()].some((c) => c.new.includes("date: 2026-09-25")));
});

test("关掉自动互链就不写区块；关掉摘要则索引页只列链接", () => {
  const s = defaultSettings();
  s.related.enabled = false;
  s.moc.includeSummary = false;
  const files = { "Notes/a.md": "# A\n\n第一段摘要\n", "Notes/b.md": "# B\n" };
  const p = genericRun(files, s);
  assert.equal(p.changedDocs.length, 0);
  const moc = [...p.mocChanges.values()].map((c) => c.new).join("\n");
  assert.ok(moc.includes("[[Notes/a|A]]"));
  assert.ok(!moc.includes("第一段摘要"));
});

test("以 --- 开头的笔记：区块分隔线不会把正文闭合成 frontmatter，第二轮 0 修改", () => {
  const s = defaultSettings();
  const files: Record<string, string> = {
    "Notes/hr.md": "---\n\n开头是一条分隔线。Alpha Beta\n",
    "Notes/empty.md": "---\n---\n# Empty\n\nAlpha Beta\n",
    "Notes/Alpha.md": "# Alpha\n\nAlpha Beta\n",
    "Notes/Beta.md": "# Beta\n\nAlpha Beta\n",
  };
  const [, second, third] = converge(files, s);
  assert.equal(second, 0);
  assert.equal(third, 0);
  const hr = files["Notes/hr.md"];
  assert.match(hr, /\n\*\*\*\n<!-- AUTO-LINKS:START -->/);
  // 用 Obsidian 的规则看：开头的 --- 没有闭合，正文不是 frontmatter
  assert.equal(hasFrontmatter(hr, s), false);
  assert.match(files["Notes/empty.md"], /\n---\n<!-- AUTO-LINKS:START -->/);
});

test("EntityIndex 与逐个正则匹配结果一致（大小写折叠特例、词边界、重叠、四字节字符）", async () => {
  const { EntityIndex, foldCase } = await import("../src/core/multimatch.ts");
  const s = defaultSettings();
  const terms = ["API", "api-x", "Straße", "SS", "ı", "I", "ſ", "S", "Kelvin", "Kelvin", "𐐀x", "𐐨x",
    "缓存", "缓存算法", "算法", "AB", "ABC", "BC", "a_b", "é", "É", "Σ", "ς", "σ", "😀", "x😀"];
  const m = buildEntityMatchers({ ...s, entities: { ...s.entities, minLength: 1, fromTitles: false, fromTags: false,
    manual: terms.map((term) => ({ term, aliases: [], caseSensitive: /\p{Script=Han}/u.test(term), wordBoundary: !/\p{Script=Han}/u.test(term), weight: 1 })) } }, []);
  // 再加几条大小写敏感 + 无边界的拉丁词，覆盖四种组合
  const m2 = buildEntityMatchers({ ...s, entities: { ...s.entities, minLength: 1, fromTitles: false, fromTags: false,
    manual: ["abc", "Bcd", "ſt", "STRASSE"].map((term) => ({ term, aliases: [], caseSensitive: term !== "abc", wordBoundary: false, weight: 1 })) } }, []);
  const matchers = [...m, ...m2];
  const idx = new EntityIndex(matchers);
  const docs = [
    "api 与 API-X、api_x、xapi、APIs", "STRASSE straße Straße ss", "ı I i İ ſ s S", "Kelvin kelvin KELVIN",
    "𐐨X 𐐀x 𐐨x", "缓存算法与算法缓存", "ABC abc aBc bcd BCD xabcx", "a_b a_bc _a_b", "É é é", "ΣΣ σς",
    "😀 x😀 X😀", "", "ſt ST st", "Straße\nAPI\tapi-x\n",
  ];
  const text = (d: string) => entityText(d, s);
  for (const d of docs) {
    assert.deepEqual([...idx.hits(text(d))], [...entitiesOf(d, matchers, s)], JSON.stringify(d));
    assert.equal(foldCase(d).length, d.length);
  }
});

test("异步驱动与 planRun 结果相同（让出主线程不改变计算）", async () => {
  const { planSteps } = await import("../src/core/engine.ts");
  const drive = async (input: Parameters<typeof planSteps>[0]) => {
    const it = planSteps(input);
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  const s = defaultSettings();
  const contents = new Map<string, string>();
  for (let i = 0; i < 450; i++) contents.set(`N/n${i}.md`, `# 笔记${i}\n\n提到 笔记${(i * 7) % 450} 和 笔记${(i * 13) % 450}\n`);
  const input = { settings: s, today: TODAY, allFiles: [...contents.keys()], contents };
  const a = planRun(input);
  const b = await drive(input);
  assert.deepEqual([...b.newContents], [...a.newContents]);
  assert.deepEqual([...b.mocChanges], [...a.mocChanges]);
});

test("实体来源：不读回旧版写的领域 tag；约定俗成的文件名、日期不当标题实体；同名的具体标题保留", () => {
  const s = defaultSettings();
  const docs = [
    { rel: "a/README.md", title: "README", aliases: [], tags: ["domain/a", "project/x"] },
    { rel: "b/README.md", title: "项目 B 说明", aliases: ["2026-09-20"], tags: [] },
    { rel: "c/LICENSE.md", title: "LICENSE", aliases: [], tags: [] },
    { rel: "d/LICENSE.md", title: "LICENSE", aliases: [], tags: [] },
    { rel: "daily/2026-09-20.md", title: "2026-09-20", aliases: [], tags: [] },
    { rel: "x/one.md", title: "缓存淘汰策略对比", aliases: [], tags: [] },
    { rel: "x/two.md", title: "缓存淘汰策略对比", aliases: [], tags: [] },
  ];
  const terms = buildEntityMatchers(s, docs).map((m) => m.term);
  assert.ok(!terms.includes("domain"));
  assert.ok(terms.includes("project"));
  assert.ok(!terms.some((t) => /^(README|LICENSE|2026-09-20)$/.test(t)));
  assert.ok(terms.includes("项目 B 说明"));
  assert.ok(terms.includes("缓存淘汰策略对比"));
});

test("区块标签含正则元字符：按字面匹配，不抛异常", () => {
  const tag = "LINKS(v2).*";
  const withBlock = appendEndBlock("# T\n\nbody\n", tag, "- x\n");
  assert.equal(stripEndBlock(withBlock, tag), "# T\n\nbody\n");
  // 另一个只是“正则上能匹配”的标签不能把它剥掉
  assert.equal(stripEndBlock(withBlock, "LINKS(v2)xx"), withBlock);
});

test("按目录生成领域：中文目录名各有各的 id，不会并成同一个领域", async () => {
  const { detectDomainsFromDirs, newDomain } = await import("../src/core/settings.ts");
  const ds = detectDomainsFromDirs(["项目", "研究", "Work Notes", "work-notes"]);
  assert.deepEqual(ds.map((d) => d.id), ["项目", "研究", "work-notes", "work-notes-2"]);
  assert.equal(new Set(ds.map((d) => d.id)).size, ds.length);
  // 设置页「添加领域」同样避开已有 id
  assert.equal(newDomain("项目", ["其他"], ds).id, "项目-2");
});

test("旧版向导词迁进自定义词表：去重、清空旧字段、匹配方式按词形推导", async () => {
  const { migrateAutoAccepted } = await import("../src/core/config-text.ts");
  const s = samplePreset();
  s.entities.manual = [{ term: "缓存", aliases: ["cache"], caseSensitive: true, wordBoundary: false, weight: 2 }];
  s.entities.autoAccepted = ["缓存", "Kubernetes"];
  assert.equal(migrateAutoAccepted(s), true);
  assert.deepEqual(s.entities.autoAccepted, []);
  assert.deepEqual(s.entities.manual.map((r) => r.term), ["缓存", "Kubernetes"]);
  assert.equal(s.entities.manual[0].weight, 2, "已有的词不被覆盖");
  assert.equal(s.entities.manual[1].wordBoundary, true);
  assert.equal(s.entities.manual[1].caseSensitive, false);
  assert.equal(migrateAutoAccepted(s), false);
});

// ---------------------------------------------------------------- 索引页：分节、跟随语言、清理

test("索引页按子文件夹分节：直接在文件夹里的在前，更深的归到一级子文件夹", () => {
  const s = defaultSettings();
  s.domains = [newDomain("项目", ["项目"], [])];
  const files = {
    "项目/总览.md": "# 总览\n",
    "项目/缓存/改造.md": "# 缓存改造\n",
    "项目/缓存/深/细节.md": "# 细节\n",
    "项目/搜索/v2.md": "# 搜索 v2\n",
  };
  const page = runOnce(files, new Map(), s).moc.get("_moc/项目.md") as string;
  const body = page.slice(page.indexOf("# 项目"));
  const order = ["总览", "## 搜索", "搜索 v2", "## 缓存", "缓存改造", "细节"].map((x) => body.indexOf(x));
  assert.ok(order.every((i) => i >= 0), body);
  assert.ok(body.indexOf("总览") < body.indexOf("## "), "直接在文件夹里的笔记排在小节前");
  assert.ok(body.indexOf("缓存改造") > body.indexOf("## 缓存") && body.indexOf("细节") > body.indexOf("## 缓存"));
  assert.ok(!body.includes("## 深"), "更深的层级不另起小节");
});

test("关掉索引页：相关笔记区块里不再链向不存在的索引页", () => {
  const s = defaultSettings();
  s.moc.enabled = false;
  const r = runOnce({ "a/x.md": "# X\n\nAlpha\n", "a/y.md": "# Alpha\n" }, new Map(), s);
  assert.ok(!r.files["a/x.md"].includes("_moc/"));
  assert.equal(r.out.mocChanges.size, 0);
});

/** 和插件一样：没保存领域时，每轮按当前的顶层文件夹生成领域 */
function autoRun(files: Record<string, string>, moc: Map<string, string>, s: Settings): ReturnType<typeof runOnce> {
  const run = { ...s };
  ensureDomains(run, Object.keys(files));
  return runOnce(files, moc, run);
}

test("文件夹删了：它的旧索引页（本插件生成的）列入清理，别人的文件不碰", () => {
  const s = defaultSettings();
  const first = autoRun({ "旧/a.md": "# A\n", "新/b.md": "# B\n" }, new Map(), s);
  assert.ok(first.moc.has("_moc/旧.md"));
  const moc = new Map(first.moc);
  moc.set("_moc/我的笔记.md", "# 我自己写的\n");
  const second = autoRun({ "新/b.md": "# B\n" }, moc, s);
  assert.deepEqual([...second.out.mocRemovals.keys()], ["_moc/旧.md"]);
  assert.deepEqual(second.out.report.mocStale, ["_moc/旧.md"]);
  // 关掉索引页时一个都不删
  const off = { ...s, moc: { ...s.moc, enabled: false } };
  assert.equal(autoRun({ "新/b.md": "# B\n" }, moc, off).out.mocRemovals.size, 0);
});

test("Node 写盘：旧索引页移进 .trash/，计划后被改过的不动", () => {
  const s = defaultSettings();
  const dir = mkdtempSync(pjoin(tmpdir(), "vl-stale-"));
  const first = autoRun({ "旧/a.md": "# A\n", "新/b.md": "# B\n" }, new Map(), s);
  const page = first.moc.get("_moc/旧.md") as string;
  mkdirSync(pjoin(dir, "_moc"), { recursive: true });
  mkdirSync(pjoin(dir, "新"), { recursive: true });
  writeF(pjoin(dir, "_moc/旧.md"), page);
  writeF(pjoin(dir, "新/b.md"), "# B\n");
  const plan = autoRun({ "新/b.md": "# B\n" }, first.moc, s).out;
  const r = applyPlan(dir, plan, s);
  assert.deepEqual(r.removedMoc, ["_moc/旧.md"]);
  assert.equal(existsSync(pjoin(dir, "_moc/旧.md")), false);
  assert.equal(readF(pjoin(dir, ".trash/_moc/旧.md"), "utf8"), page);

  // 计划之后有人改了这页 → 不删
  writeF(pjoin(dir, "_moc/旧.md"), page + "我加的一行\n");
  assert.deepEqual(applyPlan(dir, plan, s).removedMoc, []);
  assert.equal(existsSync(pjoin(dir, "_moc/旧.md")), true);
});

test("旧版内置文案与文件名：没改过的升级到新版（语言不变），改过的保留", () => {
  const zh = defaultSettings();
  zh.texts = textsFor("zh");
  zh.texts.mocTitlePrefix = "# MOC：";
  zh.texts.relatedHeading = "## 相关文档";
  zh.fallbackDomain.name = "Unsorted";
  zh.moc.homeFile = "Home";
  assert.equal(upgradeBuiltins(zh), true);
  assert.equal(zh.texts.mocTitlePrefix, "# ");
  assert.equal(zh.texts.relatedHeading, "## 相关笔记");
  assert.equal(zh.fallbackDomain.name, "其他笔记");
  assert.equal(zh.moc.homeFile, "主页");
  assert.equal(upgradeBuiltins(zh), false, "第二次没有可升级的");

  const en = defaultSettings();
  en.texts.homeSectionTitle = "## Domains";
  en.fallbackDomain.name = "Unsorted";
  upgradeBuiltins(en);
  assert.equal(en.texts.homeSectionTitle, "## Folders");
  assert.equal(en.fallbackDomain.name, "Other notes");
  assert.equal(en.moc.homeFile, "Home");

  const custom = defaultSettings();
  custom.texts.mocTitlePrefix = "# 索引 · ";
  custom.fallbackDomain.name = "杂项";
  custom.moc.homeFile = "00-首页";
  upgradeBuiltins(custom);
  assert.equal(custom.texts.mocTitlePrefix, "# 索引 · ");
  assert.equal(custom.fallbackDomain.name, "杂项");
  assert.equal(custom.moc.homeFile, "00-首页");
});

test("首次安装的中文用户：索引页文件名也是中文", () => {
  const s = defaultSettings();
  applyAutoTexts(s, "zh-cn");
  assert.equal(s.fallbackDomain.name, "其他笔记");
  assert.equal(s.moc.homeFile, "主页");
  const r = runOnce({ "a.md": "# A\n" }, new Map(), s);
  assert.ok(r.moc.has("_moc/主页.md") && r.moc.has("_moc/其他笔记.md"));
});
