/**
 * schedule.ts — 什么时候该跑一轮：逐文件静置（纯函数，可在 Node 里直接测）
 *
 * 这里只回答「何时跑」，不回答「跑什么」——引擎每轮都是全量重算 + 幂等，
 * 一轮下来只有真正不一样的笔记才会落盘。
 *
 * 触发粒度做成「每个文件各自计时」，是为了让某篇笔记的改动决定这篇笔记多久之后
 * 被刷新，而不是像「全库安静 N 分钟」那样被任何一处无关改动无限推迟
 * （实测结果就是设了 1 小时之后一次都不跑）。
 */

/** 用 mtime + size 当"内容指纹"：够便宜（不读文件），也够灵敏（外部写入都会改 mtime） */
export interface FileSig {
  mtime: number;
  size: number;
}

export type Snapshot = Map<string, FileSig>;

/**
 * 对比两次快照，给出"动过"的路径：新增、修改，以及消失的。
 * 删除也要算动过——相关笔记的区块里得把它的链接摘掉。
 */
export function touchedPaths(before: ReadonlyMap<string, FileSig>, after: ReadonlyMap<string, FileSig>): string[] {
  const out: string[] = [];
  for (const [path, sig] of after) {
    const old = before.get(path);
    if (old === undefined || old.mtime !== sig.mtime || old.size !== sig.size) out.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) out.push(path);
  return out;
}

/** 把若干路径标记成「刚从 at 这个时刻动过」——它们各自的静置计时从 at 重新开始 */
export function touch(dirty: Map<string, number>, paths: Iterable<string>, at: number): void {
  for (const path of paths) dirty.set(path, at);
}

/**
 * 距离「最早的某个文件静置满 quietMs」还有多少毫秒。没有待更新文件时返回 null。
 * 返回 0 就是「现在可以跑了」。
 */
export function msUntilDue(dirty: ReadonlyMap<string, number>, now: number, quietMs: number): number | null {
  let min = Infinity;
  for (const since of dirty.values()) {
    const left = since + quietMs - now;
    if (left < min) min = left;
  }
  return min === Infinity ? null : Math.max(0, min);
}
