/**
 * queue.ts — 待处理队列的落盘格式（纯函数，可单测）
 *
 * 为什么需要：待更新集（watchDirty）原来只活在内存里。启动对账入队后若 vault 很快被关掉，
 * 这批待更新就无声丢失——下次启动基线重拍，把它们当成"已处理"。落成 queue.json 后
 * 下次加载时恢复，按各自时间戳接着排静置（时间戳在过去 = 立刻到点，正好补写）。
 *
 * 文件坏了 / 版本不认识一律当空队列：队列只是加速器，丢了顶多晚一轮轮询发现，不能挡加载。
 */

export interface PendingQueue {
  version: 1;
  /** [vault 相对路径, 最后一次变化时刻 ms] */
  items: [string, number][];
}

export function serializeQueue(dirty: Map<string, number>): string {
  return JSON.stringify({ version: 1, items: [...dirty.entries()] } satisfies PendingQueue);
}

export function deserializeQueue(text: string, now = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof data !== "object" || data === null) return out;
  const q = data as Partial<PendingQueue>;
  if (q.version !== 1 || !Array.isArray(q.items)) return out;
  for (const it of q.items) {
    // 时钟偏差/手工编辑可能塞进来未来的时刻：压到 now，否则这一篇会永远压着想跑跑不到
    if (Array.isArray(it) && typeof it[0] === "string" && typeof it[1] === "number") {
      out.set(it[0], Math.min(it[1], now));
    }
  }
  return out;
}
