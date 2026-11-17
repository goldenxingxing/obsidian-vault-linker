# TODO — 待办特性（从「同类插件功能调研」选定）

> 来源：2026-11-17 同类插件功能调研与可借鉴特性。P0-1（侧边栏相关笔记视图）已实现，见
> `src/obsidian/related-view.ts`；P0-2、P0-3 记录在此。

## P0-2 显示命中主题 + 摘要（为什么相关）

**现状**：相关区块和侧边栏视图只显示 `- [[笔记]]`，用户不知道两篇笔记为什么相关；相关区块
不含摘要（MOC 索引页条目已有摘要）。

**目标**：相关列表的每条后面显示：
1. 共享主题（两篇笔记的实体交集，如「主题：API、缓存」）——可解释性；
2. 摘要（正文第一个可读行，`summaryOf` 已有，MOC 在用）。

**实现要点**：
- `src/core/engine.ts` 的 `PlanOutput` 目前暴露 `autolinks`（目标列表）与 `titles`（标题），
  但**没暴露每篇的实体集**；需再加 `docEntities: Map<string, Set<string>>`（`planSteps` 内已算出）。
- 共享主题 = `docEntities.get(active) ∩ docEntities.get(target)`（交集，按 code point 排序）。
- 渲染处两处：
  - `src/obsidian/related-view.ts`（侧边栏，P0-1 已建）——每条后加主题/摘要；
  - 文末托管区块 `src/core/engine.ts` 的 `transform()`——可选，加 `related.showTopics` /
    `related.showSummary` 开关（默认关，避免改变现有区块、破坏幂等基线）。
- 摘要已有 `summaryOf(content, s)`，主题交集在 `docEntities` 上做，零新依赖。

**验收**：开启后相关条目形如 `- [[b|B 文档]] — 主题：API、缓存`；关掉后与现状逐字节一致。

---

## P0-3 排序 / 过滤 + 面板内搜索

**现状**：相关列表只按引擎得分降序排；无按时间/名称排序，无搜索、无过滤。

**目标**（侧边栏视图内，纯 UI，不动文件区块）：
1. 排序：按得分 / 修改时间 / 创建时间 / 名称；
2. 面板内搜索框：匹配词或 `#tag`，可选 any/all，前缀 `-` 排除；
3. 过滤：最少共享主题数（如 ≥2）。

**实现要点**：
- 视图内做，不改 `engine.ts` 的 `linkTargets`（保持文件区块幂等）；
- 排序所需的 mtime/ctime 从 `app.vault.getAbstractFileByPath(rel).stat` 取（Obsidian 已带）；
- 搜索匹配标题 + 正文首行（摘要已有）；`#tag` 匹配用 `parseFrontmatterTags`（core/frontmatter.ts）；
- 需要 P0-2 的 `docEntities`（过滤最少共享主题用）。

**验收**：视图能按时间/名称切换排序；搜索词/`#tag` 实时过滤；`-draft` 排除草稿。
