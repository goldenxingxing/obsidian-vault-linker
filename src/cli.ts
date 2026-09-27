#!/usr/bin/env node
/**
 * cli.ts — Node CLI：Obsidian 没开时的兜底，与插件用同一个引擎
 *
 * 用法：
 *   node src/cli.ts --vault <vault路径> [--preset generic | --config <data.json>] [--apply]
 *                   [--today YYYY-MM-DD] [--report-json <文件>] [--quiet]
 * --config 可以直接用插件保存的配置：<vault>/.obsidian/plugins/vault-linker/data.json
 */

import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { planFromFiles, type PlanOutput } from "./core/engine.ts";
import { PRESETS, applyAutoTexts, defaultSettings, mergeSettings, todayIso, type Settings } from "./core/settings.ts";
import { ensureDomains, templatePaths, withRuntimeExcludes } from "./core/scope.ts";
import { safeDirPath } from "./core/moc.ts";
import { listAllFiles, readTextOrNull } from "./node/vaultFs.ts";
import { applyPlan } from "./node/apply.ts";

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
    console.error("用法: node src/cli.ts --vault <vault路径> [--preset generic | --config <data.json>] [--apply] [--today YYYY-MM-DD]");
    process.exit(2);
  }
  return {
    vault: resolve(vault),
    preset: get("--preset") ?? "generic",
    apply: argv.includes("--apply"),
    today: get("--today") ?? todayIso(),
    reportJson: get("--report-json"),
    quiet: argv.includes("--quiet"),
    config: get("--config"),
  };
}

function loadSettings(preset: string, config: string | null): Settings {
  if (config) return mergeSettings(defaultSettings(), JSON.parse(readFileSync(config, "utf8")));
  const p = PRESETS[preset];
  if (!p) {
    console.error(`未知预设: ${preset}（可选: ${Object.keys(PRESETS).join(", ")}）`);
    process.exit(2);
  }
  return p.build();
}

export function runCli(args: Args): { plan: PlanOutput; applied: ReturnType<typeof applyPlan> | null } {
  const allFiles = listAllFiles(args.vault);
  // 本次运行实际生效的配置：排除 Obsidian 配置里的模板目录（不改预设本身）
  const s = withRuntimeExcludes(
    loadSettings(args.preset, args.config),
    templatePaths((rel) => readTextOrNull(join(args.vault, rel)), ".obsidian"),
  );
  // `language: auto` → 按环境语言选内置文案（插件端传 Obsidian 的语言）
  applyAutoTexts(s, process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG);
  // domains 为空 → 按顶层目录自动探测（设置页上承诺的“首次运行自动探测”）
  const domainsDetected = ensureDomains(s, allFiles);
  const mocPrefix = safeDirPath(s.moc.folder) + "/";
  const mocContents = new Map<string, string>();
  for (const f of allFiles) {
    if (!f.startsWith(mocPrefix) || !f.endsWith(".md")) continue;
    const t = readTextOrNull(join(args.vault, f));
    if (t !== null) mocContents.set(f, t);
  }

  const plan = planFromFiles(
    allFiles,
    (rel) => readTextOrNull(join(args.vault, rel)),
    s,
    args.today,
    args.vault,
    mocContents,
  );

  if (!args.quiet) printReport(plan, s, args.apply);
  if (domainsDetected && !args.quiet) {
    console.log(`（domains 为空，已按顶层目录自动探测出 ${s.domains.length} 个领域）`);
  }

  if (args.reportJson) {
    writeFileSync(args.reportJson, JSON.stringify({ report: plan.report, writes: [...plan.writes.keys()] }, null, 2));
  }

  const applied = args.apply ? applyPlan(args.vault, plan, s) : null;
  if (applied && !args.quiet) {
    console.log(
      `APPLY 完成：写入正文 ${applied.written.length} 篇（跳过快照后变更 ${applied.skippedChanged.length} 篇），` +
      `写入 MOC ${applied.writtenMoc.length} 个。`,
    );
    if (applied.skippedChanged.length > 0) {
      console.log("!! 跳过（写前内容已变）：" + applied.skippedChanged.slice(0, 20).join(", "));
    }
    if (applied.protectionExternal.length > 0) {
      console.log(`!! 校验失败但系写入后外部又修改（保留现场）${applied.protectionExternal.length} 篇`);
    }
    if (applied.protectionFailed.length > 0) {
      console.log(`!! 内容保护校验失败 ${applied.protectionFailed.length} 篇，已恢复：${applied.restored.slice(0, 20).join(", ")}`);
    }
    if (applied.protectionFailed.length === 0 && applied.protectionExternal.length === 0) {
      console.log(`内容保护校验: PASS（${applied.written.length} 篇剥离托管区块后与原文逐字节一致）`);
    }
  }
  return { plan, applied };
}

function printReport(plan: PlanOutput, s: Settings, applyMode: boolean): void {
  const r = plan.report;
  console.log("=".repeat(60));
  console.log("模式: " + (applyMode ? "APPLY" : "DRY-RUN"));
  console.log(`扫描 .md（vault 全量 walk）: ${r.scanned} 在范围 + ${r.excluded} 排除`);
  if (r.skippedBinary > 0) console.log(`跳过（非 UTF-8）: ${r.skippedBinary}`);
  console.log("领域分布: " + r.domains.map((d) => `${d.name}=${d.count}`).join(", "));
  console.log(`计划修改文档: ${r.plannedChanges} / ${r.scanned}`);
  console.log(`计划新建/更新 MOC: ${r.mocPlanned}`);
  if (r.mocConflicts.length > 0) {
    console.log(`!! 跳过 ${r.mocConflicts.length} 个同名文件（位置已有不是本插件生成的文件，或只差大小写，未覆盖）: ${r.mocConflicts.slice(0, 10).join(", ")}`);
  }
  console.log(`补 frontmatter tags: ${r.fmAdded}`);
  console.log(`自动互链总数: ${r.autoLinkTotal}（${s.related.blockTag} 条目）`);
  console.log(`日报解析: ${r.dailyParsed} 篇；产出引用存在 ${r.deliverablesExisting} 条 / 缺失 ${r.deliverablesMissing} 条`);
  console.log(`日报↔产出双向链对: ${r.sourceLinkPairs}（出处注入 ${r.sourceLinkDocs} 篇产出文件）`);
  console.log(`实体总数: ${r.entityUsage.length}（未命中 ${r.unusedEntities.length}，过泛 ${r.tooBroadEntities.length}）`);
  for (const w of [...new Set(r.warnings)].sort()) console.log("WARNING: " + w);
  console.log(`链接有效性: 托管区块/MOC 内失效链接 ${r.brokenManaged.length} 个；正文既有失效链接 ${r.brokenPreexist.length} 个`);
  for (const [f, t] of r.brokenManaged.slice(0, 10)) console.log(`   [managed-broken] ${f} -> [[${t}]]`);
  for (const [f, t] of r.brokenPreexist.slice(0, 10)) console.log(`   [preexist-broken] ${f} -> [[${t}]]`);
  console.log("=".repeat(60));
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  runCli(parseArgs(process.argv.slice(2)));
}
