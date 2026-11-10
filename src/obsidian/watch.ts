/**
 * watch.ts — 变更监听（轮询 + 逐文件静置，自愈式）
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
 *
 * 为什么是「单发 setTimeout 链 + 看门狗」，而不是裸 setInterval：
 *   单发链能按"最早到点的文件"精确排下一次检查（到点就跑，不被轮询间隔量化）；
 *   代价是它靠"这次回调里排下次"延续，任何一环断掉整条链就死了，插件从此
 *   "配置里开着却再也不跑"——这就是本插件反复"好像又停用了"的根因。
 *   所以这里给链上了两道保险：
 *     1. tick/fire 内部一律 try/catch，无论抛什么，finally 都重新排下一次 → 异常断不了链；
 *     2. 一条 **setInterval 看门狗** 自走：发现排队的检查已严重超时（定时器被渲染进程
 *        静默丢掉）或整条链许久没动，就清掉重建。setInterval 一旦启动就自走，
 *        不受"某次回调是否成功"影响，专门兜底"单发定时器不触发"这一类无声故障。
 */

import type { App } from "obsidian";
import type { Settings } from "../core/settings.ts";
import { globMatch } from "../core/scope.ts";
import { duePaths, msUntilDue, touch, touchedPaths, type Snapshot } from "../core/schedule.ts";
import type { AppLike } from "./runner.ts";

export type { Snapshot };

/** 运行期发现外部改动时立即重跑的轮数上限 */
const MAX_IMMEDIATE_RERUNS = 3;

/** 事件提示后多久看一眼：比任何轮询间隔都快，但仍给连续写入留一点合并的余地 */
const WAKE_MS = 1000;

/** 两次检查的最短间隔，防止事件密集时把主线程拖进忙等 */
const MIN_CHECK_MS = 250;

/** 单轮 run() 的软上限：超过就认为卡死了（全库扫描 + 写盘不该这么久），强制解围 */
const RUN_STUCK_MS = 15 * 60 * 1000;

/**
 * 看门狗判定"排队中的检查已经死了"的宽容量：一个 setTimeout 早该触发却没触发，
 * 说明定时器被静默丢了（渲染进程节流/后台丢定时器），需要重建。
 */
const OVERDUE_SLACK_MS = 5000;

export interface QuietCtx {
  /** 当前已到静置期的路径：调用方可据此只跳过“打开中且未到点”的（正在编辑） */
  due: ReadonlySet<string>;
  /** 本轮运行**前**的队列快照（path → changedAt）：供 markApplied 保留“原计时”而不重算 */
  originals: ReadonlyMap<string, number>;
}

export interface WatchEvents {
  onPendingChange: (count: number) => void;
  /** 运行一次引擎；参数见 {@link QuietCtx}。
   *  返回值 = 引擎**自己写过**的路径（用于区分外部改动，可为 void） */
  onQuietReached: (ctx: QuietCtx) => Promise<readonly string[] | void>;
  /** 心跳/tick 内部异常留痕（可选；别让它抛，否则会打断自愈） */
  onTickError?: (message: string) => void;
}

export class ChangeWatcher {
  /** 下一次检查的单发定时器（按最早到点精确排期） */
  private timer: number | null = null;
  /** 当前这次检查被安排在什么时刻（用来让 wake 只提前、不推迟，也让看门狗识别"超时未触发"） */
  private timerDueAt = 0;
  /** 看门狗：自走的 setInterval，负责在单发链死掉时把它救回来 */
  private watchdog: number | null = null;
  /** 最近一次真正执行过 tick 的时刻：看门狗据此判断"整条链许久没动" */
  private lastTickAt = 0;
  private baseline: Snapshot = new Map();
  private running = false;
  private active = false;
  /** 已上报过的待处理数：避免每一轮轮询都去刷一遍状态栏 */
  private reported = 0;
  /** 最近一次 run() 开始时刻；配合 RUN_STUCK_MS 做看门狗 */
  private runStartedAt = 0;
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
    this.lastTickAt = Date.now();
    this.scheduleCheck();
    this.startWatchdog();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog);
      this.watchdog = null;
    }
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
    this.startWatchdog();
  }

  /** 事件提示：提前看一眼（判定仍在 tick 里，避免把插件自己的写入当成外部改动） */
  notifyChange(): void {
    this.wake(WAKE_MS);
  }

  /**
   * 一轮运行之后调用：把当前状态当成「已应用」，更新基线。
   *
   * @param keep 本轮**没写成功**、但仍待更新的路径及各自的 changedAt（见 {@link QuietCtx.originals}）。
   *   —— 打开中被跳过的（skippedOpen）保持**原计时**（到期自然写入，不会越滑越远）；
   *   —— 写入时内容已变 / 写入失败的（skipped / noteFailed）用「现在」，静置期后再试。
   *   这些都不该从待处理里消失——否则它们永远不会被补上。
   *
   * 传空 Map：全部清空（这一轮确实都应用了）。手动运行（命令 / 设置页按钮）的写入也要算
   * 进来，否则插件自己的产物会被下一轮轮询当成外部改动，白跑一轮、状态栏还一直挂着"待处理"。
   */
  markApplied(keep: ReadonlyMap<string, number> | undefined): void {
    this.baseline = this.snapshot();
    this.dirty.clear();
    if (keep) for (const [p, at] of keep) this.dirty.set(p, at);
    this.reportPending();
  }

  /** 启动看门狗（幂等）：自走的 setInterval，专门救"单发定时器不触发"这类无声故障 */
  private startWatchdog(): void {
    if (!this.active || this.watchdog !== null) return;
    const pollMs = Math.max(2, this.settings.trigger.pollIntervalSec) * 1000;
    // 检查频率略低于主链：太密会和主链抢着跑，太疏救不回来
    const wdMs = Math.max(pollMs, 5000);
    this.watchdog = window.setInterval(() => this.watchdogTick(), wdMs);
  }

  /**
   * 看门狗：主链是"单发 setTimeout 链"，任何一环静默丢失整条就断了。
   * 这里每拍自查两件事：
   *   - 排队的检查已严重超时还没触发 → 定时器被渲染进程丢了 → 清掉重建；
   *   - 没在跑、也没排队、却很久没 tick 过 → 链断了 → 重新排一次。
   */
  private watchdogTick(): void {
    if (!this.active) return;
    if (this.running) return; // run() 还在进行，它自己的 finally 会重新排期
    const now = Date.now();
    if (this.timer !== null) {
      // 有一个检查在排队；若早就该触发却还没触发，说明它被静默丢弃了
      if (now > this.timerDueAt + OVERDUE_SLACK_MS) {
        this.tickError(`watch: a scheduled check was overdue by >${OVERDUE_SLACK_MS}ms; restarting`);
        window.clearTimeout(this.timer);
        this.timer = null;
        this.scheduleCheck();
      }
      return;
    }
    // 没有排队、也没在跑：正常时链每 pollMs 就会排一次；很久没动说明断了
    const pollMs = Math.max(2, this.settings.trigger.pollIntervalSec) * 1000;
    if (now - this.lastTickAt > Math.max(pollMs * 3, OVERDUE_SLACK_MS)) {
      this.tickError("watch: no check scheduled and no tick for a long time; restarting");
      this.lastTickAt = now;
      this.scheduleCheck();
    }
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
      this.safeTick();
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

  /** 定时器回调的统一入口：任何异常都只留痕、并照常续期，绝不断链 */
  private safeTick(): void {
    if (!this.active) return;
    try {
      this.tick();
    } catch (e) {
      console.error("[vault-linker] watch tick error", e);
      this.tickError(String(e));
      // 异常也不能断链：退一步按轮询间隔重排，别让"每次 tick 都抛"变成忙等
      const pollMs = Math.max(2, this.settings.trigger.pollIntervalSec) * 1000;
      this.setTimer(pollMs);
    }
  }

  private tickError(message: string): void {
    try {
      this.events.onTickError?.(message);
    } catch {
      /* 留痕失败不影响自愈 */
    }
  }

  /** 一次检查：对比快照把动过的文件记进脏集，到点的就跑 */
  private tick(): void {
    if (!this.active) return;
    // 看门狗：上一轮 run() 若卡死（await 永不返回）会把 running 卡在 true，
    // 不处理任何变更也永远不跑——超时强制解围，让后续检查继续试。
    if (this.running) {
      if (this.runStartedAt > 0 && Date.now() - this.runStartedAt > RUN_STUCK_MS) {
        console.error("[vault-linker] watch run stuck > 15min; resetting");
        this.running = false;
        this.runStartedAt = 0;
      } else {
        this.scheduleCheck();
        return;
      }
    }
    this.lastTickAt = Date.now();
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
    this.runStartedAt = Date.now();
    try {
      // 运行期若发生**外部**改动，立即再跑一轮，否则这批改动会被下面的基线更新悄悄吸收。
      // 引擎自己写过的路径要排除，否则每次有产出都会白跑一轮。
      for (let attempt = 0; attempt < MAX_IMMEDIATE_RERUNS; attempt++) {
        const before = this.snapshot();
        const now = Date.now();
        const quietMs = Math.max(1, this.settings.trigger.quietPeriodSec) * 1000;
        // 运行前的队列快照：markApplied 用它保留 skippedOpen 的“原计时”，避免越滑越远
        const originals = new Map(this.dirty);
        // 打开中但已停手静置满的文件也算“到点”：调用方据此只跳过“打开中且未到点的”
        const due = duePaths(this.dirty, now, quietMs);
        // 这一轮会把当前所有待更新都覆盖掉，先清脏集；运行期的外部改动下面再放回去
        this.dirty.clear();
        const written = await this.events.onQuietReached({ due, originals });
        const selfWritten = new Set(written ?? []);
        const after = this.snapshot();
        this.baseline = after;
        const external = touchedPaths(before, after).filter((p) => !selfWritten.has(p));
        if (external.length === 0) break;
        touch(this.dirty, external, Date.now());
        this.reportPending();
      }
    } catch (e) {
      console.error("[vault-linker] watch run error", e);
      this.tickError(String(e));
    } finally {
      this.running = false;
      this.runStartedAt = 0;
      this.lastTickAt = Date.now();
      this.safeReportPending();
      // 关键：无论如何都要重新排下一次检查，否则整条链就断了
      this.scheduleCheck();
    }
  }

  /** reportPending 绝不允许把异常带上 fire 的 finally（否则会波及自愈） */
  private safeReportPending(): void {
    try {
      this.reportPending();
    } catch (e) {
      console.error("[vault-linker] watch report error", e);
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
