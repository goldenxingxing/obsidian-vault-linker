#!/usr/bin/env node
/**
 * cli.ts — Node CLI：Obsidian 没开时的兜底，与插件用同一个引擎
 *
 * 用法：
 *   node tools/cli/cli.ts --vault <vault路径> [--preset generic | --config <data.json>] [--apply]
 *                   [--today YYYY-MM-DD] [--report-json <文件>] [--quiet]
 * --config 可以直接用插件保存的配置（data.json，位于 vault 的 Obsidian 配置目录下 plugins/vault-linker-auto/）。
 */

// Node 内置模块经 process.getBuiltinModule 获取（需 Node ≥ 22.3）：本文件只被
// Node CLI / 测试引用，插件包 main.js 不含此文件；不写成 import 语句，社区目录的
// 静态扫描由此可确认插件代码与 Node API 零接触。
const path = process.getBuiltinModule("node:path");
const fs = process.getBuiltinModule("node:fs");

/** CLI 输出走 stdout（不等同于插件里的 console 日志，本文件不被插件加载） */
const out = (line: string): void => {
  process.stdout.write(line + "\n");
};
import { planFromFiles, type PlanOutput } from "../../src/core/engine.ts";
import { PRESETS, applyAutoTexts, defaultSettings, mergeSettings, todayIso, type Settings } from "../../src/core/settings.ts";
import { ensureDomains, templatePaths, withRuntimeExcludes } from "../../src/core/scope.ts";
import { safeDirPath } from "../../src/core/moc.ts";
import { listAllFiles, readTextOrNull } from "./vaultFs.ts";
import { applyPlan } from "./apply.ts";

interface Args {
  vault: string;
  preset: string;
  apply: boolean;
  today: string;
  reportJson: string | null;
  quiet: boolean;
  config: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (k: string): string | null => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const vault = get("--vault");
  if (!vault) {
    console.error("用法: node tools/cli/cli.ts --vault <vault路径> [--preset generic | --config <data.json>] [--apply] [--today YYYY-MM-DD]");
    process.exit(2);
  }
  return {
    vault: path.resolve(vault),
    preset: get("--preset") ?? "generic",
    apply: argv.includes("--apply"),
    today: get("--today") ?? todayIso(),
    reportJson: get("--report-json"),
    quiet: argv.includes("--quiet"),
    config: get("--config"),
  };
}

function loadSettings(preset: string, config: string | null): Settings {
  if (config) return mergeSettings(defaultSettings(), JSON.parse(fs.readFileSync(config, "utf8")));
  const p = PRESETS[preset];
  if (!p) {
    console.error(`未知预设: ${preset}（可选: ${Object.keys(PRESETS).join(", ")}）`);
    process.exit(2);
  }
  return p.build();
}

/**
 * Obsidian 的配置目录可被用户自定义、名字不固定，所以不写死：
 * 在 vault 根下找包含 app.json 的目录；找不到就跳过模板目录探测。
 */
function findConfigDir(vault: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(vault);
  } catch {
    return null;
  }
  for (const name of entries) {
    try {
      if (fs.existsSync(path.join(vault, name, "app.json"))) return name;
    } catch {
      // 非目录或不可读，跳过
    }
  }
  return null;
}

export function runCli(args: Args): { plan: PlanOutput; applied: ReturnType<typeof applyPlan> | null } {
  const allFiles = listAllFiles(args.vault);
  // 本次运行实际生效的配置：排除 Obsidian 配置里的模板目录（不改预设本身）
  const configDir = findConfigDir(args.vault);
  const s = withRuntimeExcludes(
    loadSettings(args.preset, args.config),
    configDir === null ? [] : templatePaths((rel) => readTextOrNull(path.join(args.vault, rel)), configDir),
  );
  // `language: auto` → 按环境语言选内置文案（插件端传 Obsidian 的语言）
  applyAutoTexts(s, process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG);
  // domains 为空 → 按顶层目录自动探测（设置页上承诺的“首次运行自动探测”）
  const domainsDetected = ensureDomains(s, allFiles);
  const mocPrefix = safeDirPath(s.moc.folder) + "/";
  const mocContents = new Map<string, string>();
  for (const f of allFiles) {
    if (!f.startsWith(mocPrefix) || !f.endsWith(".md")) continue;
    const t = readTextOrNull(path.join(args.vault, f));
    if (t !== null) mocContents.set(f, t);
  }

  const plan = planFromFiles(
    allFiles,
    (rel) => readTextOrNull(path.join(args.vault, rel)),
    s,
    args.today,
    mocContents,
  );

  if (!args.quiet) printReport(plan, s, args.apply);
  if (domainsDetected && !args.quiet) {
    out(`（domains 为空，已按顶层目录自动探测出 ${s.domains.length} 个领域）`);
  }

  if (args.reportJson) {
    fs.writeFileSync(args.reportJson, JSON.stringify({ report: plan.report, writes: [...plan.writes.keys()] }, null, 2));
  }

  const applied = args.apply ? applyPlan(args.vault, plan, s) : null;
  if (applied && !args.quiet) {
    out(
      `APPLY 完成：写入正文 ${applied.written.length} 篇（跳过快照后变更 ${applied.skippedChanged.length} 篇），` +
      `写入 MOC ${applied.writtenMoc.length} 个，旧索引页移入 .trash ${applied.removedMoc.length} 个。`,
    );
    if (applied.skippedChanged.length > 0) {
      out("!! 跳过（写前内容已变）：" + applied.skippedChanged.slice(0, 20).join(", "));
    }
    if (applied.protectionExternal.length > 0) {
      out(`!! 校验失败但系写入后外部又修改（保留现场）${applied.protectionExternal.length} 篇`);
    }
    if (applied.protectionFailed.length > 0) {
      out(`!! 内容保护校验失败 ${applied.protectionFailed.length} 篇，已恢复：${applied.restored.slice(0, 20).join(", ")}`);
    }
    if (applied.protectionFailed.length === 0 && applied.protectionExternal.length === 0) {
      out(`内容保护校验: PASS（${applied.written.length} 篇剥离托管区块后与原文逐字节一致）`);
    }
  }
  return { plan, applied };
}

function printReport(plan: PlanOutput, s: Settings, applyMode: boolean): void {
  const r = plan.report;
  out("=".repeat(60));
  out("模式: " + (applyMode ? "APPLY" : "DRY-RUN"));
  out(`扫描 .md（vault 全量 walk）: ${r.scanned} 在范围 + ${r.excluded} 排除`);
  if (r.skippedBinary > 0) out(`跳过（非 UTF-8）: ${r.skippedBinary}`);
  out("领域分布: " + r.domains.map((d) => `${d.name}=${d.count}`).join(", "));
  out(`计划修改文档: ${r.plannedChanges} / ${r.scanned}`);
  out(`计划新建/更新 MOC: ${r.mocPlanned}`);
  if (r.mocConflicts.length > 0) {
    out(`!! 跳过 ${r.mocConflicts.length} 个同名文件（位置已有不是本插件生成的文件，或只差大小写，未覆盖）: ${r.mocConflicts.slice(0, 10).join(", ")}`);
  }
  out(`自动互链总数: ${r.autoLinkTotal}（${s.related.blockTag} 条目）`);
  out(`实体总数: ${r.entityUsage.length}（未命中 ${r.unusedEntities.length}，过泛 ${r.tooBroadEntities.length}）`);
  for (const w of [...new Set(r.warnings)].sort()) out("WARNING: " + w);
  out(`链接有效性: 托管区块/MOC 内失效链接 ${r.brokenManaged.length} 个；正文既有失效链接 ${r.brokenPreexist.length} 个`);
  for (const [f, t] of r.brokenManaged.slice(0, 10)) out(`   [managed-broken] ${f} -> [[${t}]]`);
  for (const [f, t] of r.brokenPreexist.slice(0, 10)) out(`   [preexist-broken] ${f} -> [[${t}]]`);
  out("=".repeat(60));
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  runCli(parseArgs(process.argv.slice(2)));
}
