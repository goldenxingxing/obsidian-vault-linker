/**
 * schedule.test.ts — 逐文件静置的判据（触发时机唯一有逻辑的地方）
 *
 * 这些函数决定「什么时候跑」，用纯函数写就是为了能这样直接测——定时器那层只是壳。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { duePaths, touchedPaths, touch, msUntilDue, type Snapshot } from "../src/core/schedule.ts";

const sig = (mtime: number, size: number) => ({ mtime, size });

test("touchedPaths：新增、改动、删除都算动过（删除也要让相关笔记把链接摘掉）", () => {
  const before: Snapshot = new Map([
    ["a.md", sig(1, 10)],
    ["b.md", sig(1, 20)],
    ["gone.md", sig(1, 5)],
  ]);
  const after: Snapshot = new Map([
    ["a.md", sig(1, 10)], // 没动
    ["b.md", sig(2, 20)], // mtime 变了
    ["new.md", sig(3, 7)], // 新增
  ]);
  assert.deepEqual(touchedPaths(before, after).sort(), ["b.md", "gone.md", "new.md"]);
});

test("touchedPaths：大小变了也算动过（同一秒内多次写入只改 size 的情形）", () => {
  const before: Snapshot = new Map([["a.md", sig(1, 10)]]);
  const after: Snapshot = new Map([["a.md", sig(1, 11)]]);
  assert.deepEqual(touchedPaths(before, after), ["a.md"]);
});

test("touch：只重置被点到的那几个文件的计时", () => {
  const dirty = new Map([
    ["a.md", 1000],
    ["b.md", 1000],
  ]);
  touch(dirty, ["b.md"], 5000);
  assert.equal(dirty.get("a.md"), 1000, "没被点到的文件不该受影响");
  assert.equal(dirty.get("b.md"), 5000);
});

test("msUntilDue：没有待更新 → null；最早的到点时间说了算", () => {
  const now = 10_000;
  const quietMs = 3_000;
  assert.equal(msUntilDue(new Map(), now, quietMs), null);
  // a 在 9000 动过（还差 2000），b 在 2000 动过（早该跑了）
  assert.equal(msUntilDue(new Map([["a.md", 9000], ["b.md", 2000]]), now, quietMs), 0);
  // 只有 a：还差 2000
  assert.equal(msUntilDue(new Map([["a.md", 9000]]), now, quietMs), 2000);
});

test("msUntilDue：别的文件一直在动，不会推迟已经静置够久的那个", () => {
  const quietMs = 3_600_000;
  const now = 10_000_000;
  const dirty = new Map([
    ["老文件.md", now - quietMs - 1], // 已经静置超过配置时长 → 立刻可跑
    ["刚改的.md", now - 1], // 刚刚动过，还差很久
  ]);
  assert.equal(msUntilDue(dirty, now, quietMs), 0, "旧的「全库安静」实现会被刚改的那个无限推迟");
});

test("duePaths：只挑出已到静置期的路径（打开中但停手静置满的也在其中，可放心写）", () => {
  const quietMs = 3_600_000;
  const now = 10_000_000;
  const dirty = new Map([
    ["到点.md", now - quietMs], // 恰好到点
    ["没到点.md", now - 1], // 刚改，还差很久
  ]);
  assert.deepEqual([...duePaths(dirty, now, quietMs)], ["到点.md"]);
});

test("duePaths：空队列 → 空集", () => {
  assert.equal(duePaths(new Map(), 0, 1000).size, 0);
});
