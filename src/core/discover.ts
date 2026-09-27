/**
 * discover.ts — E4 实体候选发现（替用户挖出他自己领域的术语）
 *
 * 为什么需要它：领域词（如 Kubernetes / 缓存 / 机器学习）是**领域知识**，不能预置给别人。
 * 本模块扫全库，用"词频 + 凝固度 + 邻接多样性 + 领域聚集度"把候选挖出来，
 * **列出候选让人勾选**，不勾选就不生效（绝不自动写进配置）。
 *
 * 算法（不引分词库、零运行时依赖）：
 *   拉丁词：tokenize [A-Za-z][A-Za-z0-9_./+#-]* → 再按 _ - . / + # 切成子词
 *           （必须切：DOC00012_H008_PRJ-011_RequirementSpec 这种长标识符
 *            会把其中的术语整块吞掉，实测不切时召回 0%）
 *           → 文档频次 df → 剔停用词与"出现在 >80% 文档"的无区分度词
 *   CJK   ：2–4 字 n-gram，三道过滤
 *             ① 凝固度 PMI = log2( f(g)·N / (f(left)·f(right)) )，取所有切分点的最小值
 *             ② 左右邻字熵（邻接字种类越少说明边界越不完整）
 *             ③ 内置通用词表（数据/问题/验证…，否则它们会占满候选榜）
 *           再做"长词吸收短词"的后处理（若更长候选覆盖了它 ≥80% 的出现）
 *   打分：df × (1 + 标题命中 + tag 命中) × 凝固度因子 × 领域聚集度因子
 *
 * 实测（762 篇 / 2.7M 汉字的中文 vault，41 个人工整理的领域词）：**39 个（95.1%）进候选池**；
 * 另 2 个因出现文档数 <3 进不了池（频率类方法的固有下限）。
 * 按排名取 top-N 只有 56%，所以对外要给"可搜索的候选池"而不是 top-N 列表。
 */

import type { Settings } from "./settings.ts";
import { pyLen } from "./pycompat.ts";
import { stripAllBlocks } from "./blocks.ts";
import { bodyWithoutFm } from "./frontmatter.ts";
import { stripCode } from "./entities.ts";

export interface DiscoverDoc {
  rel: string;
  title: string;
  tags: string[];
  content: string;
}

export interface Candidate {
  term: string;
  kind: "latin" | "cjk";
  /** 出现在多少篇文档里 */
  df: number;
  /** 全库出现次数 */
  freq: number;
  /** 凝固度（CJK；拉丁为 0） */
  cohesion: number;
  /** 左右邻字熵的较小值（CJK；拉丁为 0） */
  entropy: number;
  inTitles: number;
  inTags: number;
  score: number;
  /** 命中示例文档 */
  sample: string;
}

export interface DiscoverOptions {
  topN: number;
  minDf: number;
  minFreq: number;
  maxGram: number;
  minEntropy: number;
  /** 处理的最大 CJK 字符数（性能护栏） */
  maxCjkChars: number;
  /** 是否做"长词吸收短词" */
  suppressSubstrings: boolean;
}

export const DEFAULT_DISCOVER: DiscoverOptions = {
  topN: 100,
  minDf: 3,
  minFreq: 5,
  maxGram: 4,
  minEntropy: 0.6,
  maxCjkChars: 4_000_000,
  suppressSubstrings: true,
};

/** 每处理多少篇文档让出一次主线程（异步入口用） */
const CHUNK = 20;

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9_./+#-]*/g;
const LATIN_SEP = /[_\-./+#]+/;

const DEFAULT_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "are", "was", "were", "have",
  "has", "not", "but", "you", "your", "our", "its", "it", "is", "in", "on", "of",
  "to", "by", "as", "at", "be", "or", "if", "we", "can", "all", "any", "use", "used",
  "using", "may", "must", "will", "should", "one", "two", "new", "old", "note",
  "notes", "file", "files", "true", "false", "null", "none", "http", "https", "com",
  "www", "py", "md", "json", "yaml", "txt",
  // 通用英文/工具词（不屏蔽的话 vs/no/min/docx/test 这类词会占满拉丁候选榜）
  "vs", "no", "yes", "min", "max", "sum", "avg", "std", "num", "cnt", "idx",
  "test", "tests", "testing", "code", "review", "reviews", "app", "apps", "doc", "docs",
  "docx", "pdf", "csv", "xlsx", "html", "css", "png", "jpg", "svg", "img", "image",
  "data", "dataset", "page", "pages", "list", "lists", "item", "items", "name", "names",
  "type", "types", "value", "values", "error", "errors", "result", "results", "output",
  "input", "step", "steps", "set", "get", "add", "del", "key", "keys", "map", "maps",
  "src", "dst", "tmp", "temp", "out", "def", "func", "obj", "str", "int", "float",
  "bool", "args", "opt", "cfg", "conf", "init", "main", "id", "uid", "pid", "ok", "err",
  "warn", "info", "debug", "trace", "log", "logs", "url", "uri", "api", "sdk", "ide",
  "git", "repo", "branch", "commit", "build", "run", "dev", "prod", "todo", "fixme",
  "readme", "changelog", "license", "version", "update", "updates", "part", "parts",
  "total", "count", "size", "time", "date", "day", "week", "month", "year", "hour",
  "line", "lines", "text", "string", "number", "base", "case", "cases",
  "first", "last", "next", "prev", "back", "home", "open", "close", "start", "stop",
  "end", "done", "fail", "failed", "pass", "passed", "check", "checks", "mode", "path",
  "paths", "dir", "dirs", "folder", "link", "links", "index", "section", "table", "chart",
]);

/**
 * 内置的中文通用词表（只对 CJK 候选生效）。
 *
 * 为什么必须有：高频通用词（数据/问题/验证/说明…）的词频天然高于领域术语，
 * 不屏蔽的话候选榜前 20 名全是它们，领域词全被挤到几百名开外（实测召回仅 19.5%）。
 * 用户可在设置里继续追加停用词。
 */
export const GENERIC_CN_STOPWORDS: readonly string[] = [
  "数据", "问题", "验证", "说明", "系统", "测试", "控制", "安全", "报告", "一致",
  "方案", "文档", "状态", "设计", "结果", "记录", "使用", "分析", "要求", "内容",
  "方法", "流程", "功能", "参数", "接口", "时间", "版本", "代码", "文件", "部分",
  "情况", "过程", "信息", "指标", "评估", "检查", "确认", "修改", "更新", "建议",
  "注意", "参考", "附录", "目录", "标题", "备注", "输出", "输入", "执行", "运行",
  "完成", "开始", "结束", "错误", "异常", "成功", "失败", "增加", "减少", "变化",
  "影响", "关系", "对比", "差异", "基准", "目标", "范围", "场景", "任务",
  "阶段", "步骤", "原则", "规则", "条件", "限制", "边界", "默认", "配置", "设置",
  "模块", "组件", "单元", "整体", "具体", "相关", "对应", "如下", "以下", "以上",
  "当前", "目前", "本次", "上次", "下次", "需要", "可以", "应该", "必须", "能够",
  "由于", "因此", "所以", "但是", "而且", "并且", "或者", "以及", "其中", "其他",
  "一些", "一个", "两个", "三个", "多个", "每个", "所有", "全部", "相同", "不同",
  "主要", "重要", "关键", "核心", "基本", "简单", "复杂", "完整", "详细", "明确",
  "描述", "表达", "包含", "提供", "获取", "处理", "生成", "构建", "实现",
  "支持", "保证", "确保", "避免", "防止", "降低", "提高", "优化", "调整", "选择",
  "应用", "引入", "采用", "基于", "针对", "通过", "根据", "按照", "结合",
  "公司", "部门", "同事", "工作", "会议", "计划", "进度", "总结", "回顾", "待办",
  "日报", "周报", "表格", "图片", "截图", "链接", "路径", "列表",
  "数量", "质量", "效率", "成本", "价格", "市场", "用户", "客户", "产品", "项目",
  "需求", "开发", "发布", "上线", "交付", "验收", "培训", "沟通", "反馈",
];

// ---------------------------------------------------------------- 对外入口

/** 同步入口（CLI / 测试用） */
export function discoverCandidates(
  docs: readonly DiscoverDoc[],
  s: Settings,
  opts: Partial<DiscoverOptions> = {},
): Candidate[] {
  const gen = discoverSteps(docs, s, opts);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/**
 * 异步入口（Obsidian 插件用）：每处理一批文档就让出主线程，
 * 否则数千篇的中文 vault 会把界面冻住 ~1 分钟。
 */
export async function discoverCandidatesAsync(
  docs: readonly DiscoverDoc[],
  s: Settings,
  opts: Partial<DiscoverOptions> = {},
  onProgress?: (stage: DiscoverStage, done: number, total: number) => void,
): Promise<Candidate[]> {
  const gen = discoverSteps(docs, s, opts);
  let r = gen.next();
  while (!r.done) {
    const stage: DiscoverStage = r.value < docs.length ? "read" : r.value < docs.length * 2 ? "entropy" : "rank";
    const done = r.value < docs.length ? r.value : r.value < docs.length * 2 ? r.value - docs.length : docs.length;
    onProgress?.(stage, done, docs.length);
    await new Promise((res) => window.setTimeout(res, 0));
    r = gen.next();
  }
  return r.value;
}

/** 进度阶段（界面自己翻成文字）：读取正文 / 统计邻接熵 / 排序打分 */
export type DiscoverStage = "read" | "entropy" | "rank";

/** 按类型分组取 top-N：拉丁与中文各取 N，避免高频中文通用词把拉丁术语挤下去 */
export function topPerKind(list: readonly Candidate[], perKind: number): Candidate[] {
  const latin = list.filter((c) => c.kind === "latin").slice(0, perKind);
  const cjk = list.filter((c) => c.kind === "cjk").slice(0, perKind);
  return [...latin, ...cjk];
}

// ---------------------------------------------------------------- 主算法（生成器）

/**
 * 主算法（生成器）：每 yield 一次代表"进度"，调用方决定要不要让出主线程。
 * yield 的值语义：<docs.length = 第一遍已处理篇数；[docs.length, 2*docs.length) = 第二遍；
 * 更大 = 收尾阶段。
 */
function* discoverSteps(
  docs: readonly DiscoverDoc[],
  s: Settings,
  opts: Partial<DiscoverOptions> = {},
): Generator<number, Candidate[], void> {
  const o: DiscoverOptions = { ...DEFAULT_DISCOVER, ...opts };
  const stop = new Set([...DEFAULT_STOPWORDS, ...s.entities.stopwords.map((x) => x.toLowerCase())]);
  const genericCn = new Set<string>([...GENERIC_CN_STOPWORDS, ...s.entities.stopwords]);
  const total = docs.length;
  const broadThreshold = Math.max(1, Math.floor(total * 0.8));
  /** 预处理后的文本缓存（两遍复用，省一遍正则） */
  const texts: string[] = new Array<string>(docs.length);

  // ---- 拉丁词
  const latinDf = new Map<string, number>();
  const latinFreq = new Map<string, number>();
  const latinForm = new Map<string, string>(); // 小写 -> 最常见原始写法
  const latinFormCount = new Map<string, Map<string, number>>();
  const latinSample = new Map<string, string>();

  // ---- CJK n-gram
  const gramDf = new Map<string, number>();
  const gramFreq = new Map<string, number>();
  const uniFreq = new Map<string, number>();
  const gramSample = new Map<string, string>();

  // ---- 领域聚集度：词越集中在少数顶层目录，越像"这个 vault 的专有术语"
  // 统计方式：第一遍（拉丁）与第二遍（CJK 存活者）顺便累加，不额外扫库
  const dirTally = new Map<string, Map<string, number>>();
  const bumpDir = (term: string, dir: string): void => {
    let m = dirTally.get(term);
    if (!m) {
      m = new Map();
      dirTally.set(term, m);
    }
    m.set(dir, (m.get(dir) ?? 0) + 1);
  };
  const concentrationOf = (term: string): number => {
    const m = dirTally.get(term);
    if (!m) return 0;
    let tot = 0;
    let max = 0;
    for (const n of m.values()) {
      tot += n;
      if (n > max) max = n;
    }
    return tot === 0 ? 0 : max / tot;
  };

  let cjkBudget = o.maxCjkChars;

  // ================= 第一遍：词频 / 文档频次 / 标题-tag 原料 =================
  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    const docDir = doc.rel.includes("/") ? doc.rel.slice(0, doc.rel.indexOf("/")) : "";
    let text = bodyWithoutFm(stripAllBlocks(doc.content, s), s);
    text = stripCode(text);
    texts[di] = text;

    // 拉丁：整体 + 按分隔符切出的子词都作为候选
    const seenLatin = new Set<string>();
    for (const m of text.matchAll(LATIN_TOKEN)) {
      const full = normalizeLatin(m[0]);
      const parts = [full, ...full.split(LATIN_SEP)];
      for (const rawPart of parts) {
        const norm = normalizeLatin(rawPart);
        if (pyLen(norm) < 2 || pyLen(norm) > 32) continue;
        if (!/[A-Za-z]/.test(norm)) continue;
        if (/^\d+$/.test(norm)) continue;
        const key = norm.toLowerCase();
        latinFreq.set(key, (latinFreq.get(key) ?? 0) + 1);
        if (seenLatin.has(key)) continue;
        seenLatin.add(key);
        latinDf.set(key, (latinDf.get(key) ?? 0) + 1);
        if (!latinSample.has(key)) latinSample.set(key, doc.rel);
        const forms = latinFormCount.get(key) ?? new Map<string, number>();
        forms.set(norm, (forms.get(norm) ?? 0) + 1);
        latinFormCount.set(key, forms);
      }
    }
    for (const key of seenLatin) bumpDir(key, docDir);
    for (const [key, forms] of latinFormCount) {
      if (latinForm.has(key)) continue;
      let best = "";
      let bestN = -1;
      for (const [f, n] of forms) if (n > bestN) { best = f; bestN = n; }
      latinForm.set(key, best);
    }

    // CJK：CJK_RUN 只匹配 BMP 汉字/假名，所以字符串下标 == code point 下标，可直接 slice
    const seenGram = new Set<string>();
    for (const run of text.match(CJK_RUN) ?? []) {
      if (cjkBudget <= 0) break;
      cjkBudget -= run.length;
      if (run.length < 2) continue;
      for (let i = 0; i < run.length; i++) {
        const c = run[i];
        uniFreq.set(c, (uniFreq.get(c) ?? 0) + 1);
      }
      for (let L = 2; L <= o.maxGram; L++) {
        for (let i = 0; i + L <= run.length; i++) {
          const g = run.slice(i, i + L);
          gramFreq.set(g, (gramFreq.get(g) ?? 0) + 1);
          if (seenGram.has(g)) continue;
          seenGram.add(g);
          gramDf.set(g, (gramDf.get(g) ?? 0) + 1);
          if (!gramSample.has(g)) gramSample.set(g, doc.rel);
        }
      }
    }

    if (di % CHUNK === CHUNK - 1) yield di + 1;
  }

  // ---- 标题 / tag 命中（按**文档数**计，不是出现次数）
  // 小写标题与 tag 分段集合只预热一次：原先每个候选都对着全量文档 toLowerCase()，
  // 是 O(候选×文档×字符串) 的热点（实测占 E4 扫描的相当一部分）。
  const titleLower = docs.map((d) => d.title.toLowerCase());
  const tagSegs = docs.map((d) => {
    const set = new Set<string>();
    for (const t of d.tags) {
      set.add(t.toLowerCase());
      for (const seg of t.split("/")) {
        set.add(seg);
        set.add(seg.toLowerCase());
      }
    }
    return set;
  });

  const countTitleHits = (term: string): number => {
    if (!term) return 0;
    const low = term.toLowerCase();
    let n = 0;
    for (let i = 0; i < docs.length; i++) {
      const h = docs[i].title;
      if (h.includes(term) || titleLower[i].includes(low)) n++;
    }
    return n;
  };
  const countTagHits = (term: string): number => {
    if (!term) return 0;
    const low = term.toLowerCase();
    let n = 0;
    for (let i = 0; i < docs.length; i++) {
      const segs = tagSegs[i];
      if (segs.has(term) || segs.has(low)) n++;
    }
    return n;
  };

  // ================= 第二遍：凝固度 + 邻接熵（只为存活者） =================
  const survivors = new Set<string>();
  for (const [g, df] of gramDf) {
    if (pyLen(g) < 2) continue;
    if (df < o.minDf) continue;
    if ((gramFreq.get(g) ?? 0) < o.minFreq) continue;
    if (df >= broadThreshold && total > 4) continue;
    survivors.add(g);
  }

  const N = [...uniFreq.values()].reduce((a, b) => a + b, 0) || 1;

  // 先算凝固度（不需要扫库）→ 再只对存活者扫一遍算邻接熵。
  // 为了不把上千万个 n-gram 都过一遍，第二遍按"首字"建索引：
  // 只对首字命中的位置做 startsWith 检查。
  const cohesionOf = new Map<string, number>();
  const byFirstChar = new Map<string, string[]>();
  for (const g of survivors) {
    const freq = gramFreq.get(g) ?? 0;
    const glen = pyLen(g);
    let cohesion = Number.POSITIVE_INFINITY;
    for (let k = 1; k < glen; k++) {
      const left = g.slice(0, k);
      const right = g.slice(k);
      const fl = gramFreq.get(left) ?? uniFreq.get(left) ?? 0;
      const fr = gramFreq.get(right) ?? uniFreq.get(right) ?? 0;
      if (fl === 0 || fr === 0) {
        cohesion = Number.NEGATIVE_INFINITY;
        break;
      }
      const pmi = Math.log2((freq * N) / (fl * fr));
      if (pmi < cohesion) cohesion = pmi;
    }
    if (!Number.isFinite(cohesion)) continue;
    cohesionOf.set(g, cohesion);
    const first = g[0];
    const list = byFirstChar.get(first);
    if (list) list.push(g);
    else byFirstChar.set(first, [g]);
  }

  const leftNeighbors = new Map<string, Map<string, number>>();
  const rightNeighbors = new Map<string, Map<string, number>>();

  if (byFirstChar.size > 0) {
    let budget = o.maxCjkChars;
    for (let di = 0; di < texts.length; di++) {
      const docDir = docs[di].rel.includes("/") ? docs[di].rel.slice(0, docs[di].rel.indexOf("/")) : "";
      const seenHere = new Set<string>();
      for (const run of texts[di].match(CJK_RUN) ?? []) {
        if (budget <= 0) break;
        budget -= run.length;
        if (run.length < 2) continue;
        for (let i = 0; i < run.length; i++) {
          const cands = byFirstChar.get(run[i]);
          if (!cands) continue;
          for (const g of cands) {
            if (!run.startsWith(g, i)) continue;
            const lc = i > 0 ? run[i - 1] : "\u0000";
            const rc = i + g.length < run.length ? run[i + g.length] : "\u0000";
            bump(leftNeighbors, g, lc);
            bump(rightNeighbors, g, rc);
            if (!seenHere.has(g)) {
              seenHere.add(g);
              bumpDir(g, docDir);
            }
          }
        }
      }
      if (di % CHUNK === CHUNK - 1) yield docs.length + di + 1;
    }
  }

  // ================= 收尾：打分与排序 =================
  const out: Candidate[] = [];

  // 拉丁候选
  for (const [key, df] of latinDf) {
    if (df < o.minDf) continue;
    if ((latinFreq.get(key) ?? 0) < o.minFreq) continue;
    if (df >= broadThreshold && total > 4) continue;
    if (stop.has(key)) continue;
    const form = latinForm.get(key) ?? key;
    const inTitles = countTitleHits(form);
    const inTags = countTagHits(form);
    const conc = concentrationOf(form);
    out.push({
      term: form,
      kind: "latin",
      df,
      freq: latinFreq.get(key) ?? 0,
      cohesion: 0,
      entropy: 0,
      inTitles,
      inTags,
      score: df * (1 + 0.5 * Math.min(inTitles, 5) / 5 + 0.3 * Math.min(inTags, 5) / 5) * (0.7 + 0.6 * conc),
      sample: latinSample.get(key) ?? "",
    });
  }

  // CJK 候选
  let finalized = 0;
  for (const [g, cohesion] of cohesionOf) {
    if (finalized++ % 2000 === 0) yield docs.length * 2 + finalized;
    if (genericCn.has(g)) continue;
    const freq = gramFreq.get(g) ?? 0;
    const entropy = Math.min(entropyOf(leftNeighbors.get(g)), entropyOf(rightNeighbors.get(g)));
    if (entropy < o.minEntropy) continue;
    const df = gramDf.get(g) ?? 0;
    const inTitles = countTitleHits(g);
    const inTags = countTagHits(g);
    const conc = concentrationOf(g);
    out.push({
      term: g,
      kind: "cjk",
      df,
      freq,
      cohesion,
      entropy,
      inTitles,
      inTags,
      score: df * (1 + 0.5 * Math.min(inTitles, 5) / 5 + 0.3 * Math.min(inTags, 5) / 5) *
        (1 + Math.min(cohesion, 8) / 16) * (0.7 + 0.6 * conc),
      sample: gramSample.get(g) ?? "",
    });
  }

  let ranked = out.sort((a, b) => (b.score - a.score) || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

  if (o.suppressSubstrings) {
    // 注意：suppressSubstrings 为了比较长度会重排，必须按 score 顺序过滤回来
    const kept = new Set(suppressSubstrings(ranked).map((c) => c.term));
    ranked = ranked.filter((c) => kept.has(c.term));
  }
  return ranked.slice(0, o.topN);
}

// ---------------------------------------------------------------- 工具

function normalizeLatin(tok: string): string {
  return tok.replace(/[._-]+$/, "");
}

function bump(m: Map<string, Map<string, number>>, key: string, ch: string): void {
  let inner = m.get(key);
  if (!inner) {
    inner = new Map();
    m.set(key, inner);
  }
  inner.set(ch, (inner.get(ch) ?? 0) + 1);
}

function entropyOf(counts: Map<string, number> | undefined): number {
  if (!counts || counts.size === 0) return 0;
  let total = 0;
  for (const n of counts.values()) total += n;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / total;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * "长词吸收短词"：若某个更长候选覆盖了较短候选 ≥80% 的出现次数，丢掉短的。
 * 注意这是**有损**的：像「机器学习」与「机器学习平台」这种都成立的词会被合并掉一个，
 * 所以向导里展示的是完整候选池，由用户决定。
 */
function suppressSubstrings(list: readonly Candidate[]): Candidate[] {
  const sorted = [...list].sort((a, b) => pyLen(b.term) - pyLen(a.term) || b.df - a.df);
  const kept: Candidate[] = [];
  for (const c of sorted) {
    const covered = kept.some((k) => k.term.includes(c.term) && k.df >= c.df * 0.8);
    if (!covered) kept.push(c);
  }
  return kept;
}

/** 把候选列表渲染成可直接粘进设置里的词表文本 */
export function candidatesToText(list: readonly Candidate[]): string {
  return list.map((c) => c.term).join("\n");
}

/** 与 ground truth 对比的召回评估（供可复跑验收脚本使用） */
export function recallAgainst(
  candidates: readonly Candidate[],
  groundTruth: readonly string[],
): { hit: string[]; missed: string[]; recall: number } {
  const terms = new Set(candidates.map((c) => c.term));
  const lower = new Set(candidates.map((c) => c.term.toLowerCase()));
  const hit: string[] = [];
  const missed: string[] = [];
  for (const g of groundTruth) {
    if (terms.has(g) || lower.has(g.toLowerCase())) hit.push(g);
    else missed.push(g);
  }
  return { hit, missed, recall: groundTruth.length === 0 ? 0 : hit.length / groundTruth.length };
}
