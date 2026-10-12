/**
 * cli.test.ts — 命令行通道必须和插件"看到同一个 vault"
 *
 * 这里测的两个问题都只在真 vault 上暴露（仓库里的 fixture 太干净，一直没测出来），
 * 而两者的后果是同一类：CLI 一轮重写几百篇，插件却什么都不改，两边互相打架。
 *   1. 已有文案的配置被按 shell 语言重新定内置文案 → 中文 vault 在 LANG=en_US 的
 *      shell 里跑一次，所有区块整体翻成英文
 *   2. 走文件系统时进了点目录（`.tools/.snapshot` 之类的整库副本）→ 同名文件凭空变多，
 *      最短链接目标从 `[[D-2026-09-21]]` 退化成 `[[reports/daily/26-9月/D-2026-09-21]]`，
 *      而 Obsidian 根本不索引点目录，那个短链接本来是能解析的
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { runCli } = await import("../tools/cli/cli.ts");
const { zhResearchPreset } = await import("../src/core/settings.ts");

const TODAY = "2026-10-12";

/** 一个中文 vault：两篇互相提到的笔记，外加工具自己的一份整库快照（点目录里） */
function makeVault(): { root: string; config: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vla-cli-"));
  const write = (rel: string, text: string): void => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  write("notes/alpha.md", "# alpha\n\n正文提到 beta。\n");
  write("notes/beta.md", "# beta\n\n正文提到 alpha。\n");
  write(".tools/.snapshot/notes/alpha.md", "# alpha\n\n正文提到 beta。\n");
  write(".tools/.snapshot/notes/beta.md", "# beta\n\n正文提到 alpha。\n");

  const s = zhResearchPreset();
  s.language = "auto"; // 与环境语言挂钩：正是出问题的那种配置
  const config = path.join(root, "data.json");
  fs.writeFileSync(config, JSON.stringify(s, null, 2));
  return { root, config };
}

function planOf(root: string, config: string) {
  return runCli({
    vault: root,
    preset: "generic",
    apply: false,
    today: TODAY,
    reportJson: null,
    quiet: true,
    config,
  }).plan;
}

test("CLI：已有文案的配置不因 shell 语言被重定（中文 vault 不会整体翻成英文）", () => {
  const { root, config } = makeVault();
  const prev = process.env.LC_ALL;
  process.env.LC_ALL = ""; // 明确按非中文环境跑
  try {
    const home = planOf(root, config).mocChanges.get("_moc/主页.md")?.new ?? "";
    assert.match(home, /## 文件夹/, "应沿用配置里的中文文案");
    assert.doesNotMatch(home, /## Folders/, "不该按 shell 语言翻成英文");
  } finally {
    if (prev === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：点目录（工具快照）不算进 vault，最短链接目标不会退化", () => {
  const { root, config } = makeVault();
  try {
    const plan = planOf(root, config);
    const alpha = plan.writes.get("notes/alpha.md") ?? "";
    assert.ok(alpha.includes("[[beta"), "alpha 应链到 beta，实际：" + alpha);
    assert.ok(!alpha.includes("notes/beta"), "点目录里的同名副本不该把目标退化成全路径");
    assert.ok(!plan.changedDocs.some((p) => p.startsWith(".")), "点目录里的文件不该进计划");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
