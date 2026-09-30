// 官方社区插件审核用的同一套规则（eslint-plugin-obsidianmd）。
//
// 发版前跑 `npm run lint`：这里报的问题，Obsidian 审核机器人也会报。
// 规则只对**打进 main.js 的代码**（src/）严格生效；tests/ 与 tools/ 不随插件发布，
// 那里允许 Node 全局变量和 Node 内置模块（见下面的 nodeOnly）。
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import json from "@eslint/json";

/** 只跑在 Node 里、不进 main.js 的部分：这些规则不适用，放开而不是到处写 disable 注释 */
const nodeOnly = {
  files: ["tests/**", "tools/**", "esbuild.config.mjs", "version-bump.mjs"],
  rules: {
    "obsidianmd/no-nodejs-modules": "off",
    "obsidianmd/hardcoded-config-path": "off",
    "obsidianmd/prefer-window-timers": "off",
    "obsidianmd/no-unsupported-api": "off",
    "obsidianmd/validate-manifest": "off",
    "obsidianmd/no-sample-code": "off",
    "obsidianmd/no-tfile-tfolder-cast": "off",
    // Node 里本来就没有 window / activeWindow；测试补 window 只能用 globalThis
    "obsidianmd/no-global-this": "off",
    // 测试里用 lookbehind 当对照实现，验证插件侧的整词匹配与它语义一致（插件代码本身不用）
    "obsidianmd/regex-lookbehind": "off",
    // node:test 的 test() 返回 Promise，顶层不 await 是它的正常写法
    "@typescript-eslint/no-floating-promises": "off",
    // TS 自己就会报未定义标识符，no-undef 在 TS 里只会误报 process / Buffer
    "no-undef": "off",
    // 命令行脚本的输出就是它的功能
    "no-console": "off",
  },
};

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "version-bump.mjs", "esbuild.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  nodeOnly,
  {
    // manifest.json：这一块的作用是**保证它是合法 JSON**（语法错误照报），
    // 字段规则（必填项、类型、禁用词、description 格式）见 tools/check-release.ts。
    // 官方那条 obsidianmd/validate-manifest 只认 JS/TS 的 Program 节点，
    // JSON 解析出来的根节点是 Document，所以它在 json/json 上跑不到、等于空转
    //（实测：故意改坏 manifest.json，eslint 仍然通过）。留着是为了上游修好后自动生效。
    files: ["manifest.json"],
    language: "json/json",
    plugins: { json },
    rules: {
      // JSON 的 AST 没有注释，这条核心规则会直接抛错（包自带的 package.json 块同样关掉它）
      "no-irregular-whitespace": "off",
      "obsidianmd/validate-manifest": "error",
    },
  },
]);
