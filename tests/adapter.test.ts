/**
 * adapter.test.ts — Obsidian 适配层的端到端测试（用假 vault 实现 API 子集）
 *
 * 为什么需要：`src/obsidian/` 的读写通道无法在 Node 里用真 Obsidian 跑，
 * 而它恰好是"写坏用户文件"的风险点。runner.ts 只做类型导入 + 鸭子类型，
 * 所以这里可以用一个内存假 vault 把 读→plan→写→校验→回滚 全链路测出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ChangeWatcher 用 window 上的定时器；Node 里补一个
(globalThis as unknown as { window: unknown }).window = {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: unknown) => clearInterval(h as NodeJS.Timeout),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
};

const { applyPlanObsidian, planVault, formatReport, readVaultText } = await import("../src/obsidian/runner.ts");
const { setUiLocale } = await import("../src/obsidian/i18n.ts");
// 下面的断言按中文报告写；英文报告单独测
setUiLocale("zh-cn");
const { ChangeWatcher } = await import("../src/obsidian/watch.ts");
const { defaultSettings } = await import("../src/core/settings.ts");
const { samplePreset } = await import("./fixture.ts");

// ---------------------------------------------------------------- 假 vault

class FakeVault {
  configDir = ".obsidian";
  files = new Map<string, string>();
  dirs = new Set<string>();
  /** process 调用次数（用于验证"跳过"语义） */
  processCalls = 0;

  async readBinary(file: { path: string }): Promise<ArrayBuffer> {
    const path = file.path;
    const c = this.files.get(path);
    if (c === undefined) throw new Error("ENOENT " + path);
    const enc = new TextEncoder().encode(c);
    return enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
  }

  getFiles(): Array<{ path: string; stat: { mtime: number; size: number } }> {
    return [...this.files.keys()].map((path) => ({
      path,
      stat: { mtime: 1, size: (this.files.get(path) as string).length },
    }));
  }

  getAbstractFileByPath(path: string): unknown {
    if (this.files.has(path)) return { path, extension: path.split(".").pop() };
    if (this.dirs.has(path)) return { path, children: [] }; // TFolder 形状
    return null;
  }

  async process(file: { path: string }, fn: (data: string) => string): Promise<string> {
    this.processCalls++;
    const cur = this.files.get(file.path);
    if (cur === undefined) throw new Error("ENOENT " + file.path);
    const next = fn(cur);
    this.files.set(file.path, next);
    return next;
  }

  async create(path: string, data: string): Promise<unknown> {
    this.files.set(path, data);
    return { path };
  }

  trashed: string[] = [];

  async trash(file: { path: string }, _system: boolean): Promise<void> {
    this.files.delete(file.path);
    this.trashed.push(file.path);
  }

  async createFolder(path: string): Promise<unknown> {
    this.dirs.add(path);
    return { path, children: [] };
  }

  adapter = {
    exists: async (p: string) => this.files.has(p) || this.dirs.has(p),
    read: async (p: string) => this.files.get(p) ?? "",
  };
}

function makeApp(files: Record<string, string>): { app: { vault: FakeVault }; vault: FakeVault } {
  const vault = new FakeVault();
  for (const [k, v] of Object.entries(files)) vault.files.set(k, v);
  return { app: { vault }, vault };
}

const TODAY = "2026-09-25";

// ---------------------------------------------------------------- 测试

test("适配层端到端：plan → apply → 写入正文与 MOC，保护校验 PASS", async () => {
  const { app, vault } = makeApp({
    "eng/a.md": "# A 文档\n\n关于 API 与缓存的说明。\n",
    "eng/b.md": "# B 文档\n\n同样讨论 API 与缓存。\n",
    "reviews/c.md": "# C 文档\n\n只谈评审流程。\n",
  });
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  assert.equal(plan.report.scanned, 3);
  assert.equal(plan.report.mocPlanned, 8); // 6 个领域 + 兜底 + 主页

  const out = await applyPlanObsidian(app, plan, s);
  assert.equal(out.written, 3);
  assert.equal(out.writtenMoc, 8);
  assert.deepEqual(out.restored, []);
  assert.deepEqual(out.protectionFailed, []);
  // 引擎自己写过的路径要能被监听层拿到（用于区分外部改动）
  assert.equal(out.writtenPaths.length, 11);
  assert.ok(out.writtenPaths.includes("eng/a.md"));
  assert.ok(out.writtenPaths.includes("_moc/00-主页.md"));

  // 正文写入：原文不动，末尾追加托管区块
  const a = vault.files.get("eng/a.md") as string;
  assert.ok(a.startsWith("# A 文档\n\n关于 API 与缓存的说明。\n"));
  assert.match(a, /<!-- AUTO-LINKS:START -->/);
  assert.match(a, /\[\[eng\/b\|B 文档\]\]/);
  // MOC 新建（目录不存在时应自动 createFolder + create）
  assert.ok(vault.files.has("_moc/工程.md"));
  assert.ok(vault.files.has("_moc/00-主页.md"));
  assert.ok(vault.dirs.has("_moc"));

  // 报告文本包含关键行
  const text = formatReport(plan, s, "apply", out);
  assert.match(text, /内容保护校验: PASS/);
});

test("写前内容比对：plan 之后文件被外部改动 → 跳过不覆盖", async () => {
  const { app, vault } = makeApp({ "eng/a.md": "# A\n\nAPI 缓存\n" });
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  assert.equal(plan.changedDocs.length, 1);

  // 模拟 agent/Obsidian 在 plan 之后改了文件
  const external = "# A\n\nAPI 缓存 —— 外部又改了一行\n";
  vault.files.set("eng/a.md", external);

  const out = await applyPlanObsidian(app, plan, s);
  assert.equal(out.written, 0);
  assert.deepEqual(out.skipped, ["eng/a.md"]);
  assert.equal(vault.files.get("eng/a.md"), external, "外部内容必须原样保留");
});

test("写后保护校验失败 → 回滚到原文（原始字节）", async () => {
  // 模拟引擎出错：计划写入的内容改动了托管区块之外的正文
  const original = "# A\r\n\r\nAPI 缓存\r\n";
  const { app, vault } = makeApp({ "eng/a.md": original, "eng/b.md": "# B\n\nAPI 缓存\n" });
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  plan.writes.set("eng/a.md", (plan.writes.get("eng/a.md") as string).replace("# A", "# 被改坏的标题"));

  const out = await applyPlanObsidian(app, plan, s);
  assert.deepEqual(out.restored, ["eng/a.md"], "应判定为保护校验失败并回滚");
  assert.equal(vault.files.get("eng/a.md"), original, "回滚后应与原文逐字节相同（含 CRLF）");
  assert.equal(out.written, 2, "确实写过（写过又回滚）");
});

test("不以换行结尾的笔记：补一个结尾换行，不算校验失败", async () => {
  const original = "# A\n\nAPI 缓存（无尾换行）";
  const { app, vault } = makeApp({ "eng/a.md": original });
  const s = samplePreset();

  const plan = await planVault(app, s, TODAY);
  const out = await applyPlanObsidian(app, plan, s);
  assert.deepEqual(out.restored, []);
  const after = vault.files.get("eng/a.md") as string;
  assert.match(after, /<!-- AUTO-LINKS:START -->/);
  assert.ok(after.endsWith("<!-- AUTO-LINKS:END -->\n"));
});

test("第二次运行零修改（幂等，走真实写入通道）", async () => {
  const { app, vault } = makeApp({
    "eng/a.md": "# A\n\nAPI 缓存\n",
    "eng/b.md": "# B\n\nAPI 缓存 讨论\n",
  });
  const s = samplePreset();
  await applyPlanObsidian(app, await planVault(app, s, TODAY), s);
  const second = await planVault(app, s, TODAY);
  assert.equal(second.report.plannedChanges, 0);
  assert.equal(second.report.mocPlanned, 0);
  const out2 = await applyPlanObsidian(app, second, s);
  assert.equal(out2.written, 0);
  assert.equal(out2.writtenMoc, 0);
  assert.equal(vault.processCalls, 2, "第二次不应再调用 process");
});

test("非 UTF-8 文件被跳过", async () => {
  const { app, vault } = makeApp({ "eng/a.md": "# A\n\nAPI\n" });
  // 造一个非法 UTF-8 的 md
  const bad = new Uint8Array([0xff, 0xfe, 0x41]);
  (vault as unknown as { readBinary: (f: { path: string }) => Promise<ArrayBuffer> }).readBinary = async (f) => {
    if (f.path === "eng/bad.md") return bad.buffer;
    const enc = new TextEncoder().encode(vault.files.get(f.path));
    return enc.buffer;
  };
  vault.files.set("eng/bad.md", "placeholder");
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  assert.equal(plan.report.skippedBinary, 1);
  assert.equal(plan.report.scanned, 1);
});

test("readVaultText：通用换行归一（CRLF → LF）", async () => {
  const { app, vault } = makeApp({});
  vault.files.set("a.md", "x\r\ny\r\n");
  assert.equal(await readVaultText(app, "a.md"), "x\ny\n");
});

test("ChangeWatcher：变更 → 静默期 → 触发一次；触发后基线重置，不再自触发", async () => {
  const { app, vault } = makeApp({ "eng/a.md": "# A\n" });
  const s = defaultSettings();
  s.scan.excludeTopDirs = ["_moc"];
  s.trigger.pollIntervalSec = 2; // 下限 2s
  s.trigger.quietPeriodSec = 1;
  s.trigger.stableScans = 1;

  let fired = 0;
  const watcher = new ChangeWatcher(app, s, {
    onPendingChange: () => {},
    onQuietReached: async () => {
      fired++;
    },
  });
  watcher.start();

  // 快照应排除 _moc
  vault.files.set("_moc/x.md", "index");
  assert.equal(watcher.snapshot().has("_moc/x.md"), false);

  vault.files.set("eng/b.md", "# B\n"); // 外部新增（模拟 agent 写入）
  await new Promise((r) => setTimeout(r, 5000));
  watcher.stop();

  assert.equal(fired, 1, "应在静默期结束后恰好触发一次");
  assert.equal(watcher.pendingCount(), 0, "触发后基线重置，待处理数归零");
});

test("formatReport：未映射目录提示可读", async () => {
  const { app } = makeApp({ "未知目录/x.md": "# X\n\nAPI\n" });
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  const text = formatReport(plan, s, "dry-run");
  assert.match(text, /未映射目录文件: 1/);
  assert.match(text, /根目录待归档/);
});

// ---------------------------------------------------------------- 运行期变更重跑

test("ChangeWatcher：运行期出现的外部改动会立即重跑", async () => {
  const { app, vault } = makeApp({ "eng/a.md": "# A\n" });
  const s = defaultSettings();
  s.trigger.pollIntervalSec = 2;
  s.trigger.quietPeriodSec = 1;
  s.trigger.stableScans = 1;

  let fired = 0;
  const watcher = new ChangeWatcher(app, s, {
    onPendingChange: () => {},
    onQuietReached: async () => {
      fired++;
      // 模拟"另一个进程在引擎运行期间写文件"
      if (fired === 1) vault.files.set("eng/during-run.md", "# 运行期外部写入\n");
      return []; // 引擎自己没写任何文件
    },
  });
  watcher.start();
  vault.files.set("eng/b.md", "# B\n"); // 触发第一轮
  await new Promise((r) => setTimeout(r, 8000));
  watcher.stop();

  assert.equal(fired, 2, "运行期出现的文件必须触发第二轮，不能被基线重置吞掉");
});

test("ChangeWatcher：引擎自己写过的路径不算外部改动（不白跑第二轮）", async () => {
  const { app, vault } = makeApp({ "eng/a.md": "# A\n" });
  const s = defaultSettings();
  s.trigger.pollIntervalSec = 2;
  s.trigger.quietPeriodSec = 1;
  s.trigger.stableScans = 1;

  let fired = 0;
  const watcher = new ChangeWatcher(app, s, {
    onPendingChange: () => {},
    onQuietReached: async () => {
      fired++;
      vault.files.set("eng/self.md", "# 引擎自己写的\n");
      return ["eng/self.md"];
    },
  });
  watcher.start();
  vault.files.set("eng/b.md", "# B\n");
  await new Promise((r) => setTimeout(r, 8000));
  watcher.stop();

  assert.equal(fired, 1, "自己的写入必须被排除，否则每次有产出都会白跑一轮");
});

test("一个 MOC 写不进去：记为失败，其余 MOC 照常写入，不中断整轮", async () => {
  const { app, vault } = makeApp({
    "eng/a.md": "# A 文档\n\n关于 API 与缓存的说明。\n",
    "reviews/c.md": "# C 文档\n\n只谈评审流程。\n",
  });
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  const create = vault.create.bind(vault);
  vault.create = async (path: string, data: string) => {
    if (path === "_moc/工程.md") throw new Error("File already exists.");
    return create(path, data);
  };
  const out = await applyPlanObsidian(app, plan, s);
  assert.deepEqual(out.mocFailed, ["_moc/工程.md"]);
  assert.equal(out.writtenMoc, plan.report.mocPlanned - 1);
  assert.ok(vault.files.has("_moc/00-主页.md"));
  assert.ok(!out.writtenPaths.includes("_moc/工程.md"));
  assert.match(formatReport(plan, s, "apply", out), /MOC 写入失败 1 个/);
});

test("自动运行跳过编辑器里打开着的笔记，其余照写", async () => {
  const { app, vault } = makeApp({
    "eng/a.md": "# A 文档\n\n关于 API 与缓存的说明。\n",
    "eng/b.md": "# B 文档\n\n同样讨论 API 与缓存。\n",
  });
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  const out = await applyPlanObsidian(app, plan, s, { skipOpen: new Set(["eng/a.md"]) });
  assert.deepEqual(out.skippedOpen, ["eng/a.md"]);
  assert.equal(vault.files.get("eng/a.md"), "# A 文档\n\n关于 API 与缓存的说明。\n");
  assert.match(vault.files.get("eng/b.md") as string, /AUTO-LINKS/);
  assert.match(formatReport(plan, s, "apply", out), /跳过正在打开的笔记 1 篇/);
});

test("界面语言跟随 Obsidian：非中文界面的运行报告是英文", async () => {
  const { app } = makeApp({ "eng/a.md": "# A 文档\n\n关于 API 的说明。\n" });
  const s = samplePreset();
  const plan = await planVault(app, s, TODAY);
  const out = await applyPlanObsidian(app, plan, s);
  setUiLocale("en");
  try {
    const text = formatReport(plan, s, "apply", out);
    assert.match(text, /Verification: PASS/);
    assert.doesNotMatch(text, /[\u4e00-\u9fff]{2,}(?![^=,]*[=,])/u); // 报告骨架无中文（领域名是用户数据，除外）
  } finally {
    setUiLocale("zh-cn");
  }
});

test("ChangeWatcher：轮询定时器交给宿主登记（插件卸载时由 Obsidian 清理）", () => {
  const { app } = makeApp({ "eng/a.md": "# A\n" });
  const registered: number[] = [];
  const watcher = new ChangeWatcher(app, defaultSettings(), {
    onPendingChange: () => {},
    onQuietReached: async () => {},
    registerInterval: (id) => {
      registered.push(id);
      return id;
    },
  });
  watcher.start();
  watcher.stop();
  assert.equal(registered.length, 1);
});

test("ChangeWatcher：「跳过的文件夹」里的改动不进快照", () => {
  const { app } = makeApp({ "eng/a.md": "# A\n", "Archive/old/b.md": "# B\n" });
  const s = defaultSettings();
  s.scan.excludeGlobs = ["Archive"];
  const watcher = new ChangeWatcher(app, s, { onPendingChange: () => {}, onQuietReached: async () => {} });
  const snap = watcher.snapshot();
  assert.equal(snap.has("eng/a.md"), true);
  assert.equal(snap.has("Archive/old/b.md"), false);
});

test("文件夹删了：它的旧索引页移到回收站；有 fileManager.trashFile 时优先用它", async () => {
  const { app, vault } = makeApp({ "旧/a.md": "# A\n", "新/b.md": "# B\n" });
  const s = defaultSettings();
  await applyPlanObsidian(app, await planVault(app, s, TODAY), s);
  assert.ok(vault.files.has("_moc/旧.md"));
  vault.files.set("_moc/我的.md", "# 我自己写的\n"); // 不是插件生成的，不能删

  vault.files.delete("旧/a.md");
  const plan = await planVault(app, s, TODAY);
  const out = await applyPlanObsidian(app, plan, s);
  assert.deepEqual(out.mocRemoved, ["_moc/旧.md"]);
  assert.deepEqual(vault.trashed, ["_moc/旧.md"]);
  assert.ok(vault.files.has("_moc/我的.md"));
  assert.match(formatReport(plan, s, "apply", out), /不再需要的旧索引页/);

  // 新版 Obsidian：走 fileManager.trashFile（尊重用户的删除偏好）
  const used: string[] = [];
  const app2 = makeApp({ "旧/a.md": "# A\n" });
  await applyPlanObsidian(app2.app, await planVault(app2.app, s, TODAY), s);
  app2.vault.files.delete("旧/a.md");
  app2.vault.files.set("新/b.md", "# B\n");
  const withFm = {
    ...app2.app,
    fileManager: { trashFile: async (f: { path: string }) => { used.push(f.path); app2.vault.files.delete(f.path); } },
  };
  await applyPlanObsidian(withFm, await planVault(withFm, s, TODAY), s);
  assert.deepEqual(used, ["_moc/旧.md"]);
  assert.deepEqual(app2.vault.trashed, []);
});
