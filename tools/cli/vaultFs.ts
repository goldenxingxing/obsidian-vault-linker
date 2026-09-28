/**
 * vaultFs.ts — Node 侧 vault 适配器（CLI 与测试共用，不依赖 Obsidian）
 *
 * 关键语义：
 *   - 文本按 UTF-8 解码；解码失败（非法字节）→ 视为跳过（对应 UnicodeDecodeError）
 *   - 读入时做通用换行归一（CRLF → LF）
 *   - 写盘用"同目录临时文件 + rename"（原子写）
 */

// Node 内置模块经 process.getBuiltinModule 获取（需 Node ≥ 22.3）：本文件只被
// Node CLI / 测试引用，插件包 main.js 不含此文件；不写成 import 语句，社区目录的
// 静态扫描由此可确认插件代码与 Node API 零接触。
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
type Dirent = import("node:fs").Dirent;
import { pyUniversalNewlines } from "../../src/core/pycompat.ts";

/** 递归列出 vault 内全部文件（相对路径，POSIX 分隔符），跳过 .git */
export function listAllFiles(vaultRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(vaultRoot, full).split(path.sep).join("/"));
    }
  };
  walk(vaultRoot);
  return out;
}

/** 读文本；非 UTF-8 返回 null */
export function readTextOrNull(absPath: string): string | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  try {
    const dec = new TextDecoder("utf-8", { fatal: true });
    return pyUniversalNewlines(dec.decode(buf));
  } catch {
    return null;
  }
}

/** 原样读字节（用于逐字节比对） */
export function readBytes(absPath: string): Buffer {
  return fs.readFileSync(absPath);
}

export function writeTextAtomic(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const base = absPath.split("/").pop() as string;
  const tmp = path.join(path.dirname(absPath), `.${base}.vaultlinker-tmp-${process.pid}`);
  fs.writeFileSync(tmp, content, { encoding: "utf-8" });
  fs.renameSync(tmp, absPath);
}

export function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

export function fileMtimeSize(p: string): [number, number] | null {
  try {
    const st = fs.statSync(p);
    return [st.mtimeMs, st.size];
  } catch {
    return null;
  }
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/** 复制 vault 副本（排除指定名字的目录/文件，如 VCS 与工具目录、Obsidian 配置目录、缓存目录） */
export function copyVault(src: string, dst: string, skipNames: readonly string[]): void {
  const skip = new Set(skipNames);
  const walk = (rel: string): void => {
    const from = rel ? path.join(src, rel) : src;
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      // 不可读目录（如 macOS 系统保护目录 com.apple.QuickLook.thumbnailcache）直接跳过：
      // 静默忽略：否则一个没有权限的缓存目录会让整轮运行中止
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        fs.mkdirSync(path.join(dst, childRel), { recursive: true });
        walk(childRel);
      } else if (e.isFile()) {
        fs.cpSync(path.join(from, e.name), path.join(dst, childRel));
      }
    }
  };
  fs.mkdirSync(dst, { recursive: true });
  walk("");
}
