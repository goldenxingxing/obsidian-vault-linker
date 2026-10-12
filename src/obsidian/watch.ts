/**
 * watch.ts — 变更监听（轮询 + 逐文件静置）
 *
 * 为什么用轮询而不是纯事件：Obsidian 的 vault 事件基于 Node fs.watch，
 * 对外部进程（AI agent、脚本）创建的文件**不可靠**（社区已定位：事件会丢，
 * 专治此病的 Vault File Refresh 也是每 8 秒全库轮询）。所以：
 *   - 事件只作"提前看一眼"的提示（wake），真正的判定在 tick 里做
 *   - 判定靠全量快照对比（mtime + size，不读文件）
 *   - **静置按文件算**：某个文件动过之后，它自己安静满 quietPeriodSec（设置里那一项，
 *     不是写死的）就算到点，到点就跑一轮。别的文件继续在改，不影响它的计时
 *     ——"全库安静 N 分钟"那种做法会被任何一处无关改动无限推迟，等于设了永远不更新。
 *   - 一轮跑完清空脏集；运行期间出现的外部改动重新入脏并立即补跑
 *     （引擎自己写过的路径不算，否则每次有产出都会白跑一轮）
 *
 * 脏集由调用方持有（插件的 watchDirty），所以因为改设置而重启监听不会把待更新丢掉。
 */

import type { App } from "obsidian";
import type { Settings } from "../core/settings.ts";
import { globMatch } from "../core/scope.ts";
import { msUntilDue, touch, touchedPaths, type Snapshot } from "../core/schedule.ts";
import type { AppLike } from "./runner.ts";

export type { Snapshot };

/** 运行期发现外部改动时立即重跑的轮数上限 */
const MAX_IMMEDIATE_RERUNS = 3;

/** 事件提示后多久看一眼：比任何轮询间隔都快，但仍给连续写入留一点合并的余地 */
const WAKE_MS = 1000;

/** 两次检查的最短间隔，防止事件密集时把主线程拖进忙等 */
const MIN_CHECK_MS = 250;

export interface WatchEvents {
  onPendingChange: (count: number) => void;
  /** 运行一次引擎；返回值 = 引擎**自己写过**的路径（用于区分外部改动，可为 void） */
  onQuietReached: () => Promise<readonly string[] | void>;
}

export class ChangeWatcher {
  private timer: number | null = null;
  /** 当前这次检查被安排在什么时刻（用来让 wake 只提前、不推迟） */
  private timerDueAt = 0;
  private baseline: Snapshot = new Map();
  private running = false;
  private active = false;
  /** 已上报过的待处理数：避免每一轮轮询都去刷一遍状态栏 */
  private reported = 0;
  private readonly dirty: Map<string, number>;
  private readonly app: AppLike;
  private readonly settings: Settings;
  private readonly events: WatchEvents;

  // 注意：不用 TS 参数属性（constructor(private x)），因为 Node 的 strip-only
  // 模式不支持它 —— 本项目约束“可被 node --test 直接跑的模块只能用可擦除语法”。
  // dirty 由调用方传入并持有：重启监听（改设置、开关插件）不该丢掉已攒下的待更新。
  constructor(app: AppLike, settings: Settings, events: WatchEvents, dirty: Map<string, number> = new Map()) {
    this.app = app;
    this.settings = settings;
    this.events = events;
    this.dirty = dirty;
  }

  /** 取当前快照（用 TFile.stat，不做文件 IO） */
  snapshot(): Snapshot {
    const snap: Snapshot = new Map();
    for (const f of this.app.vault.getFiles()) {
      if (!f.path.endsWith(".md")) continue;
      if (this.isOutOfScope(f.path)) continue;
      snap.set(f.path, { mtime: f.stat?.mtime ?? 0, size: f.stat?.size ?? 0 });
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

  start(): void {
    this.stop();
    this.active = true;
    this.baseline = this.snapshot();
    this.reportPending();
    this.scheduleCheck();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * 启动对账：把「内容还是旧的」的笔记投进待处理集。
   *
   * 这是"关掉 Obsidian 这段时间攒下的改动"唯一能被捡回来的地方——快照基线是在启动时
   * 现拍的，光靠它会把关闭期间的改动当成已处理。每个文件按自己的 mtime 起算静置，
   * 于是很久没动过的那些立刻到点（重启后马上补上），刚改过的仍然按配置等一段。
   */
  reconcile(paths: Iterable<string>): void {
    const snap = this.snapshot();
    const now = Date.now();
    for (const p of paths) {
      if (this.dirty.has(p)) continue;
      const sig = snap.get(p);
      // mtime 可能是未来时间（时钟偏差、还原的备份），别让它把这一篇永远压在待处理里
      this.dirty.set(p, sig ? Math.min(sig.mtime, now) : now);
    }
    this.reportPending();
    this.scheduleCheck();
  }

  /** 事件提示：提前看一眼（判定仍在 tick 里，避免把插件自己的写入当成外部改动） */
  notifyChange(): void {
    this.wake(WAKE_MS);
  }

  /**
   * 一轮运行之后调用：把当前状态当成「已应用」，清空待处理。
   * 手动运行（命令 / 设置页按钮）的写入也要算进来，否则插件自己的产物会被下一轮轮询
   * 当成外部改动，白跑一轮、状态栏还一直挂着"待处理"。
   */
  markApplied(): void {
    this.baseline = this.snapshot();
    this.dirty.clear();
    this.reportPending();
  }

  /** 把下一次检查提前到 ms 之后；已经排得更早就不动（事件密集时不许往后挤） */
  private wake(ms: number): void {
    if (!this.active) return;
    const dueAt = Date.now() + ms;
    if (this.timer !== null && this.timerDueAt <= dueAt) return;
    this.setTimer(ms);
  }

  private setTimer(ms: number): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timerDueAt = Date.now() + ms;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, ms);
  }

  /**
   * 排下一次检查：轮询间隔负责"发现变更"，脏集里最早到点的时间负责"什么时候该跑"，
   * 取两者较早的那个。没有待更新时就是纯轮询。
   */
  private scheduleCheck(): void {
    if (!this.active) return;
    const pollMs = Math.max(2, this.settings.trigger.pollIntervalSec) * 1000;
    const quietMs = Math.max(1, this.settings.trigger.quietPeriodSec) * 1000;
    const due = msUntilDue(this.dirty, Date.now(), quietMs);
    const ms = due === null ? pollMs : Math.min(pollMs, Math.max(MIN_CHECK_MS, due));
    this.setTimer(ms);
  }

  /** 一次检查：对比快照把动过的文件记进脏集，到点的就跑 */
  private tick(): void {
    if (this.running) {
      this.scheduleCheck();
      return;
    }
    if (!this.active) return;
    const now = Date.now();
    const snap = this.snapshot();
    const touched = touchedPaths(this.baseline, snap);
    this.baseline = snap;
    if (touched.length > 0) {
      touch(this.dirty, touched, now);
      this.reportPending();
    }
    const quietMs = Math.max(1, this.settings.trigger.quietPeriodSec) * 1000;
    if (msUntilDue(this.dirty, now, quietMs) === 0) {
      void this.fire();
      return;
    }
    this.scheduleCheck();
  }

  private async fire(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // 运行期若发生**外部**改动，立即再跑一轮，否则这批改动会被下面的基线更新悄悄吸收。
      // 引擎自己写过的路径要排除，否则每次有产出都会白跑一轮。
      for (let attempt = 0; attempt < MAX_IMMEDIATE_RERUNS; attempt++) {
        const before = this.snapshot();
        // 这一轮会把当前所有待更新都覆盖掉，先清脏集；运行期的外部改动下面再放回去
        this.dirty.clear();
        const written = await this.events.onQuietReached();
        const selfWritten = new Set(written ?? []);
        const after = this.snapshot();
        this.baseline = after;
        const external = touchedPaths(before, after).filter((p) => !selfWritten.has(p));
        if (external.length === 0) break;
        touch(this.dirty, external, Date.now());
        this.reportPending();
      }
    } finally {
      this.running = false;
      this.reportPending();
      this.scheduleCheck();
    }
  }

  private reportPending(): void {
    if (this.dirty.size === this.reported) return;
    this.reported = this.dirty.size;
    this.events.onPendingChange(this.dirty.size);
  }

  /** 供状态栏显示 */
  pendingCount(): number {
    return this.dirty.size;
  }
}

/** 仅类型标注用 */
export type { App };
