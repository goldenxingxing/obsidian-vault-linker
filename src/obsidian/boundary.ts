/**
 * boundary.ts — 边界过滤所需的 node:fs 探测（独立文件，可运行时 import obsidian 的 Platform）
 *
 * 放这里而不是 runner.ts：runner.ts 保持「只做类型导入」+ 零 node 依赖（保证 Node 可测），
 * 而 node:fs 只在桌面（Electron 内置 Node）可用，因此由能 import Platform 的入口侧探测后注入。
 * 守卫写法满足 obsidianmd/no-nodejs-modules：函数首句 if (!Platform.isDesktop) { return null }。
 * 移动端 / 受限环境没有 node:fs → 返回 null → 调用方关闭边界过滤（退化为仅写入容错）。
 */
import { Platform } from "obsidian";

/**
 * 桌面返回 realpath；否则返回 null（调用方据此关闭边界过滤）。
 *
 * 为什么用 window.require 而不是动态 import()：
 *   Obsidian 以 `window.eval("(function anonymous(require,module,exports){…})")` 求值插件 main.js
 *   （见 app.asar 的 PluginManager.loadPlugin），传给插件的 require 实际就是 Electron 渲染进程的
 *   `window.require`（Obsidian 自身也用它取 original-fs/path/electron 等 Node 内置模块）。
 *   动态 `import("node:fs/promises")` 不经过这个 require shim，走全局 ESM loader，在 Obsidian 的
 *   Electron 渲染进程里无法解析 `node:` 前缀 → 抛「Failed to resolve module specifier」，导致
 *   v0.4.2 onload 崩溃（实测：CLI/Node 环境能解析，Obsidian 运行时不能）。
 *   因此用 `window.require("node:fs/promises")`，与 Obsidian 自身取 Node 模块的方式一致。
 *
 * 仍整体包 try/catch：若 window.require 本身也不可用（受限环境 / 平台差异），按「不可用」处理
 * 返回 null，让调用方退化为仅写入容错（runner 已逐篇 try/catch，单篇 EPERM 不会中断整轮）。
 */
export async function getBoundaryRealpath(): Promise<((p: string) => Promise<string>) | null> {
  try {
    if (!Platform.isDesktop) {
      return null;
    }
    const nfs = window.require("node:fs/promises") as typeof import("node:fs/promises");
    return typeof nfs.realpath === "function" ? nfs.realpath.bind(nfs) : null;
  } catch {
    return null;
  }
}
