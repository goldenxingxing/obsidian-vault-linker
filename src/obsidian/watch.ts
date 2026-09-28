/**
 * watch.ts — 变更监听（轮询 + 静默期）
 *
 * 为什么用轮询而不是纯事件：Obsidian 的 vault 事件基于 Node fs.watch，
 * 对外部进程（AI agent、脚本）创建的文件**不可靠**（社区已定位：事件会丢，
 * 专治此病的 Vault File Refresh 也是每 8 秒全库轮询）。所以：
 *   - 事件只作为"立刻看一眼"的提示
 *   - 真正的判定靠 pollIntervalSec 全量快照对比
 *   - 发现变更后进入静默等待：quietPeriodSec 内无新增、且连续 stableScans 次快照一致，才运行
 *   - 运行完重置基线（引擎自己的写入不会触发死循环）
 */

import type { App } from "obsidian";
import type { Settings } from "../core/settings.ts";
import { globMatch } from "../core/scope.ts";
import type { AppLike } from "./runner.ts";

export type Snapshot = Map<string, string>;

/** 运行期发现外部改动时立即重跑的轮数上限 */
const MAX_IMMEDIATE_RERUNS = 3;

/**
 * 静默期内的检查粒度（秒）。比 poll 间隔更细，换取更快响应，但不低于 1s、且 poll 更短时跟随 poll。
 */
const QUIET_CHECK_SEC = 2;

export interface WatchEvents {
  onPendingChange: (count: number) => void;
  /** 运行一次引擎；返回值 = 引擎**自己写过**的路径（用于区分外部改动，可为 void） */
  onQuietReached: () => Promise<readonly string[] | void>;
  /**
   * 把轮询定时器交给宿主登记（插件里是 Plugin.registerInterval）：即便 stop() 没被调用，
   * 插件卸载时 Obsidian 也会清掉它。不传则只靠 stop()（测试里就是这样）。
   */
  registerInterval?: (id: number) => number;
}

export class ChangeWatcher {
  private timer: number | null = null;
  private quietTimer: number | null = null;
  private baseline: Snapshot = new Map();
  private lastChangeAt = 0;
  private stableCount = 0;
  private running = false;
  private pending = 0;
  private readonly app: AppLike;
  private readonly settings: Settings;
  private readonly events: WatchEvents;

  // 注意：不用 TS 参数属性（constructor(private x)），因为 Node 的 strip-only
  // 模式不支持它 —— 本项目约束“可被 node --test 直接跑的模块只能用可擦除语法”。
  constructor(app: AppLike, settings: Settings, events: WatchEvents) {
    this.app = app;
    this.settings = settings;
    this.events = events;
  }

  /** 取当前快照（用 TFile.stat，不做文件 IO） */
  snapshot(): Snapshot {
    const snap: Snapshot = new Map();
    for (const f of this.app.vault.getFiles()) {
      if (!f.path.endsWith(".md")) continue;
      if (this.isOutOfScope(f.path)) continue;
      snap.set(f.path, `${f.stat?.mtime ?? 0}:${f.stat?.size ?? 0}`);
    }
    return snap;
  }

  private isOutOfScope(path: string): boolean {
    const s = this.settings;
    const parts = path.split("/");
    if (s.scan.excludeTopDirs.includes(parts[0])) return true;
    for (const p of parts.slice(0, -1)) {
      if (s.scan.excludeHidden && p.startsWith(".")) return true;
      if (s.scan.excludeAnyDirs.includes(p)) return true;
    }
    // 设置页「跳过的文件夹」：那里的改动不该触发一轮什么都不改的运行
    return s.scan.excludeGlobs.some((g) => globMatch(g, path));
  }

  resetBaseline(): void {
    this.baseline = this.snapshot();
    this.lastChangeAt = 0;
    this.stableCount = 0;
    this.pending = 0;
    this.events.onPendingChange(0);
  }

  /** 事件提示：只标记"有变更"，具体判定交给轮询 */
  notifyChange(): void {
    this.lastChangeAt = Date.now();
    this.stableCount = 0;
  }

  start(): void {
    this.stop();
    this.resetBaseline();
    const periodMs = Math.max(2, this.settings.trigger.pollIntervalSec) * 1000;
    this.timer = window.setInterval(() => this.tick(), periodMs);
    this.events.registerInterval?.(this.timer);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.quietTimer !== null) window.clearTimeout(this.quietTimer);
    this.timer = null;
    this.quietTimer = null;
  }

  /** 一次轮询：对比快照；有差异则进入静默等待 */
  private tick(): void {
    if (this.running) return;
    const now = this.snapshot();
    const changed = this.diffCount(this.baseline, now);
    if (changed > 0) {
      this.pending = changed;
      this.lastChangeAt = Date.now();
      this.stableCount = 0;
      this.events.onPendingChange(changed);
      this.enterQuietWait(now);
      return;
    }
    // 运行期外没有差异：把基线跟上（外部删除/重命名等）
    this.baseline = now;
  }

  private enterQuietWait(startSnap: Snapshot): void {
    if (this.quietTimer !== null) return;
    const pollMs = Math.max(1, Math.min(this.settings.trigger.pollIntervalSec, QUIET_CHECK_SEC)) * 1000;
    let last = startSnap;
    const step = (): void => {
      const now = this.snapshot();
      if (this.diffCount(last, now) > 0) {
        last = now;
        this.lastChangeAt = Date.now();
        this.stableCount = 0;
      } else {
        this.stableCount++;
      }
      const quietMs = Math.max(1, this.settings.trigger.quietPeriodSec) * 1000;
      const stableEnough = this.stableCount >= Math.max(1, this.settings.trigger.stableScans);
      if (stableEnough && Date.now() - this.lastChangeAt >= quietMs) {
        this.quietTimer = null;
        void this.fire();
        return;
      }
      this.quietTimer = window.setTimeout(step, pollMs);
    };
    this.quietTimer = window.setTimeout(step, pollMs);
  }

  private async fire(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // 运行期若发生**外部**改动，立即再跑一轮，
      // 否则这批改动会被下面的 resetBaseline 悄悄吸收（要等到下次变更才会被处理）。
      // 引擎自己写过的路径要排除，否则每次有产出都会白跑一轮。
      for (let attempt = 0; attempt < MAX_IMMEDIATE_RERUNS; attempt++) {
        const before = this.snapshot();
        const written = await this.events.onQuietReached();
        const selfWritten = new Set(written ?? []);
        const after = this.snapshot();
        let external = 0;
        for (const [k, v] of after) if (before.get(k) !== v && !selfWritten.has(k)) external++;
        for (const k of before.keys()) if (!after.has(k) && !selfWritten.has(k)) external++;
        if (external === 0) break;
        this.pending = external;
        this.events.onPendingChange(external);
      }
    } finally {
      this.running = false;
      this.resetBaseline(); // 引擎自己的写入不再触发下一轮
    }
  }

  private diffCount(a: Snapshot, b: Snapshot): number {
    let n = 0;
    for (const [k, v] of b) if (a.get(k) !== v) n++;
    for (const k of a.keys()) if (!b.has(k)) n++;
    return n;
  }

  /** 供状态栏显示 */
  pendingCount(): number {
    return this.pending;
  }
}

/** 仅类型标注用 */
export type { App };
