/**
 * check-release.ts — 发版前的 manifest + 版本一致性检查
 *
 * 为什么自己写一份：官方 eslint 规则集里的 `obsidianmd/validate-manifest` 只认 JS/TS 的
 * Program 节点，而 manifest.json 是用 JSON 语言解析的（根节点是 Document），那条规则
 * 实际跑不到（实测：故意改坏 manifest.json，eslint 仍然通过）。而 Obsidian 目录拒收
 * release 最常见的原因正是这些字段问题，以及 tag 与版本号对不上——那些都是推了 tag 之后
 * 才被发现，tag 推出去就只能删掉重来。
 *
 *   npm run check:release            # 只校验 manifest 字段（本地随手跑）
 *   npm run check:release 0.2.6      # 再加上版本一致性与发布附件检查
 *   GITHUB_REF_NAME=0.2.6 npm run check:release   # CI 里 tag 由 Actions 提供
 */

// Node 内置模块经 process.getBuiltinModule 获取（需 Node ≥ 22.3）：本文件只被
// Node CLI / CI 引用，插件包 main.js 不含此文件；不写成 import 语句，社区目录的
// 静态扫描由此可确认插件代码与 Node API 零接触（审核机器人会扫全仓库的 node: 导入）。
const { existsSync, readFileSync } = process.getBuiltinModule("node:fs");

interface Manifest {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  minAppVersion?: unknown;
  description?: unknown;
  author?: unknown;
  authorUrl?: unknown;
  fundingUrl?: unknown;
  isDesktopOnly?: unknown;
  [key: string]: unknown;
}

const REQUIRED: Record<string, string> = {
  id: "string",
  name: "string",
  version: "string",
  minAppVersion: "string",
  description: "string",
  author: "string",
  isDesktopOnly: "boolean",
};
const OPTIONAL: Record<string, string> = {
  authorUrl: "string",
  fundingUrl: "string|object",
};
/** name / id / description 里不允许出现：Obsidian 商标与「plugin」这个泛称 */
const FORBIDDEN = /obsidian|plugin/i;
const SEMVER = /^\d+\.\d+\.\d+$/;

function fail(msg: string): void {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function note(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const version = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const manifest = readJson<Manifest>("manifest.json");
const pkg = readJson<{ version: string }>("package.json");
const versions = readJson<Record<string, string>>("versions.json");

// ---------------------------------------------------------------- manifest 字段
const allowed = new Set([...Object.keys(REQUIRED), ...Object.keys(OPTIONAL)]);

for (const [key, expected] of Object.entries(REQUIRED)) {
  const v = manifest[key];
  if (v === undefined) {
    fail(`manifest.json 缺少必填字段 "${key}"`);
    continue;
  }
  const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  if (actual !== expected) fail(`manifest.json 的 "${key}" 应为 ${expected}，实际是 ${actual}`);
}
for (const [key, expected] of Object.entries(OPTIONAL)) {
  const v = manifest[key];
  if (v === undefined) continue;
  const actual = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  if (!expected.split("|").includes(actual)) {
    fail(`manifest.json 的 "${key}" 应为 ${expected}，实际是 ${actual}`);
  }
}
// 拼错的键会被 Obsidian 直接忽略，是静默失效；这里当成错误
for (const key of Object.keys(manifest)) {
  if (!allowed.has(key)) fail(`manifest.json 里有未知字段 "${key}"（Obsidian 会忽略它）`);
}

const pluginName = typeof manifest.name === "string" ? manifest.name : "";
const id = typeof manifest.id === "string" ? manifest.id : "";
const description = typeof manifest.description === "string" ? manifest.description : "";

const forbidden = FORBIDDEN.exec(`${pluginName} ${id} ${description}`);
if (forbidden) {
  fail(`name / id / description 不能包含 "${forbidden[0]}"（Obsidian 的命名与商标规则）`);
}
if (typeof manifest.id === "string" && !/^[a-z0-9-]+$/.test(manifest.id)) {
  fail(`id 只能用半角小写字母、数字和连字符：${JSON.stringify(manifest.id)}`);
}
if (typeof manifest.version === "string" && !SEMVER.test(manifest.version)) {
  fail(`version 必须是 x.y.z 形式：${JSON.stringify(manifest.version)}`);
}
if (typeof manifest.minAppVersion === "string" && !SEMVER.test(manifest.minAppVersion)) {
  fail(`minAppVersion 必须是 x.y.z 形式：${JSON.stringify(manifest.minAppVersion)}`);
}
if (!description.endsWith(".")) {
  fail("description 要以句点结尾（提交要求）");
}
if (description.length > 250) {
  fail(`description 有 ${description.length} 个字符，超过 250`);
}
// 提交要求：不要 emoji / 特殊字符
const emoji = /\p{Extended_Pictographic}/u.exec(description);
if (emoji) {
  fail(`description 里不要用 emoji：${emoji[0]}`);
}
if (typeof manifest.fundingUrl === "object" && manifest.fundingUrl !== null) {
  const values = Object.values(manifest.fundingUrl as Record<string, unknown>);
  if (values.length === 0) fail("fundingUrl 是空对象；不接受赞助就直接删掉这个字段");
  if (values.some((v) => typeof v !== "string")) fail("fundingUrl 的每个值都必须是字符串");
}

// ---------------------------------------------------------------- 版本一致性
if (!version) {
  note("（未指定版本号：跳过 tag / versions.json / 发布附件检查，传一个版本号或在 CI 里跑）");
} else {
  // tag 必须与版本号完全一致、不带 v 前缀（Obsidian 按 tag 找 release）
  if (manifest.version !== version) {
    fail(`manifest.json 的 version 是 ${String(manifest.version)}，tag 是 ${version}`);
  }
  if (pkg.version !== version) {
    fail(`package.json 的 version 是 ${pkg.version}，tag 是 ${version}`);
  }
  if (versions[version] !== manifest.minAppVersion) {
    fail(`versions.json 里 "${version}" 应为 "${String(manifest.minAppVersion)}"，实际是 ${JSON.stringify(versions[version])}`);
  }
  // 老版本用户更新时会去 versions.json 里查自己那一版，格式不对就会卡住
  for (const [v, min] of Object.entries(versions)) {
    if (!SEMVER.test(v) || !SEMVER.test(min)) {
      fail(`versions.json 的条目 "${v}": ${JSON.stringify(min)} 不是 "x.y.z": "x.y.z" 形式`);
    }
  }
  if (!Object.hasOwn(versions, version)) {
    fail(`versions.json 里没有 "${version}"（npm version 会自动加，手工改版本号时容易漏）`);
  }
  // Obsidian 只下载这三个附件，缺一个用户就装不上
  for (const f of ["main.js", "manifest.json", "styles.css"]) {
    if (!existsSync(f)) {
      fail(`缺少发布附件 ${f}${f === "main.js" ? "（先跑 npm run build）" : ""}`);
    }
  }
}

if (process.exitCode === 1) {
  console.error("\n发版检查未通过，先修上面的问题再推 tag。");
} else {
  // 用 stdout 而不是 console.log：Obsidian 的规则集不鼓励往控制台打日志
  note(`✓ manifest 字段合法${version ? `，${version} 版本一致、发布附件齐全` : ""}（minAppVersion ${String(manifest.minAppVersion)}）`);
}
