/**
 * boundary.ts — 边界过滤所需的 node:fs 探测（独立文件，可运行时 import obsidian 的 Platform）
 *
 * 放这里而不是 runner.ts：runner.ts 保持「只做类型导入」+ 零 node 依赖（保证 Node 可测），
 * 而 node:fs 只在桌面（Electron 内置 Node）可用，因此由能 import Platform 的入口侧探测后注入。
 * 守卫写法满足 obsidianmd/no-nodejs-modules：函数首句 if (!Platform.isDesktop) { return null }。
 * 移动端 / 受限环境没有 node:fs → 返回 null → 调用方关闭边界过滤（退化为仅写入容错）。
 */
import { Platform } from "obsidian";

/** 桌面返回 realpath；否则返回 null（调用方据此关闭边界过滤） */
export async function getBoundaryRealpath(): Promise<((p: string) => Promise<string>) | null> {
  if (!Platform.isDesktop) {
    return null;
  }
  const nfs = (await import("node:fs/promises")) as typeof import("node:fs/promises");
  return typeof nfs.realpath === "function" ? nfs.realpath.bind(nfs) : null;
}
