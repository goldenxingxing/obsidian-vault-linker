/**
 * vaultFs.ts — Node 侧 vault 适配器（CLI 与测试共用，不依赖 Obsidian）
 *
 * 关键语义：
 *   - 文本按 UTF-8 解码；解码失败（非法字节）→ 视为跳过（对应 UnicodeDecodeError）
 *   - 读入时做通用换行归一（CRLF → LF）
 *   - 写盘用"同目录临时文件 + rename"（原子写）
 */

import {
  readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync,
  statSync, existsSync, rmSync, cpSync, type Dirent,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { pyUniversalNewlines } from "../core/pycompat.ts";

/** 递归列出 vault 内全部文件（相对路径，POSIX 分隔符），跳过 .git */
export function listAllFiles(vaultRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(vaultRoot, full).split(sep).join("/"));
    }
  };
  walk(vaultRoot);
  return out;
}

/** 读文本；非 UTF-8 返回 null */
export function readTextOrNull(absPath: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
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
  return readFileSync(absPath);
}

export function writeTextAtomic(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const base = absPath.split("/").pop() as string;
  const tmp = join(dirname(absPath), `.${base}.vaultlinker-tmp-${process.pid}`);
  writeFileSync(tmp, content, { encoding: "utf-8" });
  renameSync(tmp, absPath);
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}

export function fileMtimeSize(p: string): [number, number] | null {
  try {
    const st = statSync(p);
    return [st.mtimeMs, st.size];
  } catch {
    return null;
  }
}

export function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** 复制 vault 副本（排除指定名字的目录/文件，如 .git / .tools / .obsidian / .sesa） */
export function copyVault(src: string, dst: string, skipNames: readonly string[]): void {
  const skip = new Set(skipNames);
  const walk = (rel: string): void => {
    const from = rel ? join(src, rel) : src;
    let entries: Dirent[];
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      // 不可读目录（如 macOS 系统保护目录 com.apple.QuickLook.thumbnailcache）直接跳过：
      // 静默忽略：否则一个没有权限的缓存目录会让整轮运行中止
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        mkdirSync(join(dst, childRel), { recursive: true });
        walk(childRel);
      } else if (e.isFile()) {
        cpSync(join(from, e.name), join(dst, childRel));
      }
    }
  };
  mkdirSync(dst, { recursive: true });
  walk("");
}
