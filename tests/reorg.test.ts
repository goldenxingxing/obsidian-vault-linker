/**
 * reorg.test.ts — 整理检测与路径实体信号的单元测试
 *
 * 覆盖三块：
 *   1. detectPathDrift / applySuggestions：死路径、孤儿目录、rename 证据配对、应用与幂等
 *   2. pathSegmentsOf / E5 词义性：过滤规则、词表条目、与 E1 的去重关系
 *   3. E5a 结构性：同文件夹共享实体 → 相关笔记（端到端跑 planRun）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectPathDrift, applySuggestions, aggregateDirRenames, pathIsAlive } from "../src/core/reorg.ts";
import { pathSegmentsOf, buildEntityMatchers } from "../src/core/entities.ts";
import { planRun } from "../src/core/engine.ts";
import { defaultSettings, newDomain, type Settings } from "../src/core/settings.ts";

const TODAY = "2026-09-30";

/** 两个领域的最小配置：项目（顶层目录）+ 兜底 */
function twoDomainSettings(): Settings {
  const s = defaultSettings();
  s.language = "zh";
  s.domains = [newDomain("项目", ["项目"], [])];
  return s;
}

// ---------------------------------------------------------------- 整理检测

test("自动模式（domains 为空）无漂移：领域每轮现推，自愈", () => {
  const s = defaultSettings();
  const drift = detectPathDrift(["a/x.md", "b/y.md"], s);
  assert.equal(drift.suggestions.length, 0);
});

test("pathIsAlive 按前缀判断（含通配）", () => {
  const files = ["项目/子/a.md", "其他.md"];
  assert.equal(pathIsAlive("项目", files), true);
  assert.equal(pathIsAlive("项目/子", files), true);
  assert.equal(pathIsAlive("项目归档", files), false);
  assert.equal(pathIsAlive("reports/**", files), false);
  assert.equal(pathIsAlive("**", files), true);
});

test("文件夹改名后（无证据）：死路径 + 孤儿目录分开列出", () => {
  const s = twoDomainSettings();
  const drift = detectPathDrift(["项目归档/a.md", "项目归档/b.md"], s);
  assert.equal(drift.suggestions.length, 2);
  const dead = drift.suggestions.find((x) => x.kind === "dead");
  const orphan = drift.suggestions.find((x) => x.kind === "orphan");
  assert.ok(dead);
  assert.equal(dead.oldPath, "项目");
  assert.equal(dead.domainName, "项目");
  assert.ok(orphan);
  assert.equal(orphan.dir, "项目归档");
  assert.equal(orphan.count, 2);
});

test("rename 证据把死路径和孤儿配成一条建议", () => {
  const s = twoDomainSettings();
  const drift = detectPathDrift(
    ["项目归档/a.md", "项目归档/b.md"],
    s,
    [
      { old: "项目/a.md", new: "项目归档/a.md" },
      { old: "项目/b.md", new: "项目归档/b.md" },
    ],
  );
  assert.equal(drift.suggestions.length, 1);
  const rename = drift.suggestions[0];
  assert.equal(rename.kind, "rename");
  assert.equal(rename.oldPath, "项目");
  assert.equal(rename.newPath, "项目归档");
  assert.equal(rename.count, 2);
  // 被 rename 建议覆盖的死路径/孤儿不再单独出现
  assert.deepEqual(drift.resolvedDeadPaths, ["项目"]);
  assert.deepEqual(drift.resolvedOrphanDirs, ["项目归档"]);
});

test("aggregateDirRenames：文件自身改名被过滤、多文件改名按多数投票", () => {
  const m = aggregateDirRenames([
    { old: "项目/甲.md", new: "项目/甲改名.md" }, // 所在目录没变 → 不是整理
    { old: "项目/a.md", new: "项目归档/a.md" },
    { old: "项目/b.md", new: "项目归档/b.md" },
    { old: "项目/c.md", new: "别的/c.md" },
  ]);
  assert.equal(m.size, 1);
  assert.equal(m.get("项目"), "项目归档");
});

test("applySuggestions：rename 更新领域路径，且幂等", () => {
  const s = twoDomainSettings();
  const drift = detectPathDrift(
    ["项目归档/a.md"],
    s,
    [{ old: "项目/a.md", new: "项目归档/a.md" }],
  );
  const n = applySuggestions(s, drift.suggestions);
  assert.equal(n, 1);
  assert.deepEqual(s.domains[0].paths, ["项目归档"]);
  // 再应用一次：路径已更新，无重复计数
  assert.equal(applySuggestions(s, drift.suggestions), 0);
});

test("applySuggestions：orphan 新建领域（id 唯一），dead 移除路径", () => {
  const s = twoDomainSettings();
  const drift = detectPathDrift(["归档整理/a.md"], s);
  // 两个建议：dead(项目) + orphan(归档整理)
  assert.equal(drift.suggestions.length, 2);
  const n = applySuggestions(s, drift.suggestions);
  assert.equal(n, 2);
  const ids = s.domains.map((d) => d.id);
  assert.ok(ids.includes("归档整理"));
  assert.deepEqual(s.domains.find((d) => d.id === "项目")?.paths, []);
  // 幂等：目录已映射、路径已删
  assert.equal(applySuggestions(s, drift.suggestions), 0);
});

// ---------------------------------------------------------------- 路径段过滤与 E5 词义性

test("pathSegmentsOf 过滤日期段、结构词、过短段与用户停用词", () => {
  const s = defaultSettings();
  assert.deepEqual(pathSegmentsOf("项目/2026/09/a.md", s), ["项目"]);
  assert.deepEqual(pathSegmentsOf("notes/缓存改造/a.md", s), ["缓存改造"]);
  assert.deepEqual(pathSegmentsOf("附件/草稿/a.md", s), []);
  assert.deepEqual(pathSegmentsOf("项目/缓存改造/项目/a.md", s), ["项目", "缓存改造"]); // 去重
  s.entities.stopwords = ["项目"];
  assert.deepEqual(pathSegmentsOf("项目/缓存改造/a.md", s), ["缓存改造"]);
  // 文件名不算路径段（那是 E1 标题的职责）；单字目录过不了 minLength=2
  assert.deepEqual(pathSegmentsOf("aa/bb/note.md", s), ["aa", "bb"]);
  const t = defaultSettings();
  t.entities.minLength = 4;
  assert.deepEqual(pathSegmentsOf("项目/缓存/a.md", t), []);
});

test("E5 词义性：文件夹名成为词表条目，source 标记 path", () => {
  const s = defaultSettings();
  s.entities.fromTitles = false;
  s.entities.fromTags = false;
  s.entities.fromPathNames = true;
  const matchers = buildEntityMatchers(s, [
    { rel: "项目/缓存改造/a.md", title: "A", aliases: [], tags: [] },
  ]);
  const hit = matchers.find((m) => m.term === "缓存改造");
  assert.ok(hit);
  assert.equal(hit.source, "path");
  // 默认关
  s.entities.fromPathNames = false;
  assert.equal(buildEntityMatchers(s, [
    { rel: "项目/缓存改造/a.md", title: "A", aliases: [], tags: [] },
  ]).length, 0);
});

test("E5 与 E1 同名去重：标题先到，path 让位", () => {
  const s = defaultSettings();
  s.entities.fromTags = false;
  s.entities.fromPathNames = true;
  const matchers = buildEntityMatchers(s, [
    { rel: "项目/缓存改造/a.md", title: "缓存改造", aliases: [], tags: [] },
  ]);
  const hit = matchers.find((m) => m.term === "缓存改造");
  assert.ok(hit);
  assert.equal(hit.source, "title");
});

// ---------------------------------------------------------------- E5a 结构性（端到端）

function runVault(files: Array<[string, string]>, mutate: (s: Settings) => void): Map<string, string> {
  const s = defaultSettings();
  s.language = "zh";
  mutate(s);
  const contents = new Map(files);
  const out = planRun({ settings: s, today: TODAY, allFiles: files.map(([p]) => p), contents });
  return out.newContents;
}

test("E5a 结构性：同文件夹的笔记互为相关（正文毫无交集也连）", () => {
  const out = runVault(
    [
      ["分组/甲.md", "苹果\n"],
      ["分组/乙.md", "香蕉\n"],
      ["根.md", "苹果\n"],
    ],
    (s) => {
      s.entities.fromTitles = false;
      s.entities.fromTags = false;
      s.entities.fromPaths = true;
    },
  );
  const jia = out.get("分组/甲.md") as string;
  assert.ok(jia.includes("[[乙|"), "同文件夹应互链");
  const root = out.get("根.md") as string;
  assert.ok(!root.includes("[[分组/"), "根目录文件不共享文件夹实体");
});

test("E5a 默认关：同文件夹、正文无交集则不互链", () => {
  const out = runVault(
    [
      ["分组/甲.md", "苹果\n"],
      ["分组/乙.md", "香蕉\n"],
    ],
    (s) => {
      s.entities.fromTitles = false;
      s.entities.fromTags = false;
    },
  );
  assert.ok(!(out.get("分组/甲.md") as string).includes("[[乙|"));
});

test("E5a + E5b 组合：正文提到文件夹名 ↔ 归档在该文件夹的笔记相连", () => {
  const out = runVault(
    [
      ["丙.md", "我做了一个缓存改造，记录一下。\n"],
      ["缓存改造/丁.md", "记录\n"],
    ],
    (s) => {
      s.entities.fromTitles = false;
      s.entities.fromTags = false;
      s.entities.fromPaths = true;
      s.entities.fromPathNames = true;
    },
  );
  const bing = out.get("丙.md") as string;
  assert.ok(bing.includes("[[丁|"), "提到文件夹名的笔记应与文件夹内的笔记相连");
});
