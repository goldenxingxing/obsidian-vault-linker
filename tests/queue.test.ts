/**
 * queue.test.ts — 待处理队列落盘格式的单元测试
 *
 * 覆盖：round-trip、坏 JSON / 错版本 / 畸形条目兜底、未来时刻压到 now、空集序列化
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deserializeQueue, serializeQueue } from "../src/obsidian/queue.ts";

test("round-trip 保序且数值不变", () => {
  const dirty = new Map<string, number>([
    ["a/b.md", 1000],
    ["c.md", 2000],
  ]);
  const restored = deserializeQueue(serializeQueue(dirty), 999_999);
  assert.deepEqual([...restored.entries()], [...dirty.entries()]);
});

test("空队列可以序列化也能读回", () => {
  const restored = deserializeQueue(serializeQueue(new Map()), 0);
  assert.equal(restored.size, 0);
});

test("坏 JSON 当空队列", () => {
  assert.equal(deserializeQueue("not json", 0).size, 0);
  assert.equal(deserializeQueue("", 0).size, 0);
});

test("版本不认识或结构不对当空队列", () => {
  assert.equal(deserializeQueue(JSON.stringify({ version: 2, items: [] }), 0).size, 0);
  assert.equal(deserializeQueue(JSON.stringify({ version: 1 }), 0).size, 0);
  assert.equal(deserializeQueue(JSON.stringify({ version: 1, items: "x" }), 0).size, 0);
  assert.equal(deserializeQueue("null", 0).size, 0);
});

test("畸形条目被过滤，好的保留", () => {
  const text = JSON.stringify({
    version: 1,
    items: [["ok.md", 123], "junk", ["no-ts.md", "x"], [42, 5], ["future.md", 8888]],
  });
  const restored = deserializeQueue(text, 1000);
  assert.deepEqual([...restored.entries()], [["ok.md", 123], ["future.md", 1000]]);
});
