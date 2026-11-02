/**
 * boundary.test.ts — splitOutsideVault（realpath 边界过滤）的测试
 *
 * 核心新逻辑：用 realpath 把符号链接逃逸到 vault 根之外的文件剔除。
 * 分两层测：
 *   ① 注入假 realpath 的纯逻辑测（无 fs 依赖，覆盖判定/不误伤/根解析失败）
 *   ② 用真实临时目录 + 真实符号链接的集成测（验证 fs.realpath 实际行为）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { splitOutsideVault } = await import("../src/obsidian/runner.ts");

// ---------------------------------------------------------------- ① 纯逻辑（假 realpath）

test("splitOutsideVault：符号链接逃逸到 vault 外被剔除", async () => {
  const fakeRealpath = async (p: string): Promise<string> => {
    if (p === "/vault") return "/vault";
    if (p === "/vault/a.md") return "/vault/a.md";
    if (p === "/vault/link/README.md") return "/outside/README.md"; // 逃逸
    if (p === "/vault/b/c.md") return "/vault/b/c.md";
    return p;
  };
  const { kept, outside } = await splitOutsideVault(
    ["a.md", "link/README.md", "b/c.md"],
    "/vault",
    fakeRealpath,
  );
  assert.deepEqual(kept, ["a.md", "b/c.md"]);
  assert.deepEqual(outside, ["link/README.md"]);
});

test("splitOutsideVault：vault 根本身是符号链接也正确（根解析后一致）", async () => {
  const fakeRealpath = async (p: string): Promise<string> => {
    if (p === "/vault") return "/real/vault"; // 根本身是符号链接
    return "/real/vault" + p.slice("/vault".length); // 其余路径跟着解析
  };
  const { kept, outside } = await splitOutsideVault(["a.md", "b/c.md"], "/vault", fakeRealpath);
  assert.deepEqual(kept, ["a.md", "b/c.md"]);
  assert.deepEqual(outside, []);
});

test("splitOutsideVault：单个文件 realpath 失败（EPERM）时不误伤，按 kept 处理", async () => {
  const fakeRealpath = async (p: string): Promise<string> => {
    if (p === "/vault") return "/vault";
    throw new Error("EPERM");
  };
  const { kept, outside } = await splitOutsideVault(["a.md", "b.md"], "/vault", fakeRealpath);
  assert.deepEqual(kept, ["a.md", "b.md"]);
  assert.deepEqual(outside, []);
});

test("splitOutsideVault：vault 根解析失败时整体不过滤", async () => {
  const fakeRealpath = async (): Promise<string> => {
    throw new Error("ENOENT");
  };
  const { kept, outside } = await splitOutsideVault(["a.md", "b/c.md"], "/vault", fakeRealpath);
  assert.deepEqual(kept, ["a.md", "b/c.md"]);
  assert.deepEqual(outside, []);
});

test("splitOutsideVault：空列表返回空", async () => {
  const { kept, outside } = await splitOutsideVault([], "/vault", async (p) => p);
  assert.deepEqual(kept, []);
  assert.deepEqual(outside, []);
});

// ---------------------------------------------------------------- ② 集成（真实 fs + 真实符号链接）

test("splitOutsideVault 集成：真实符号链接指向 vault 外 → 被剔除", async () => {
  const root = await mkdtemp(join(tmpdir(), "vault-linker-bd-"));
  try {
    // vault 结构：vault/a.md、vault/sub/inside.md、vault/outlink -> 外部目录
    const outside = join(root, "outside");
    const vault = join(root, "vault");
    await mkdir(join(vault, "sub"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(vault, "a.md"), "a");
    await writeFile(join(vault, "sub", "inside.md"), "inside");
    await writeFile(join(outside, "README.md"), "outside");
    await symlink(outside, join(vault, "outlink"), "dir");

    const files = ["a.md", "sub/inside.md", "outlink/README.md"];
    const { kept, outside: outsideFiles } = await splitOutsideVault(files, vault, realpath);
    assert.deepEqual(kept, ["a.md", "sub/inside.md"]);
    assert.deepEqual(outsideFiles, ["outlink/README.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("splitOutsideVault 集成：符号链接指向 vault 内部 → 保留（不算逃逸）", async () => {
  const root = await mkdtemp(join(tmpdir(), "vault-linker-bd-"));
  try {
    const vault = join(root, "vault");
    await mkdir(join(vault, "real"), { recursive: true });
    await writeFile(join(vault, "real", "x.md"), "x");
    await symlink(join(vault, "real"), join(vault, "alias"), "dir"); // 内部链接

    const { kept, outside } = await splitOutsideVault(["alias/x.md"], vault, realpath);
    assert.deepEqual(kept, ["alias/x.md"]); // 解析后仍在 vault 内
    assert.deepEqual(outside, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
