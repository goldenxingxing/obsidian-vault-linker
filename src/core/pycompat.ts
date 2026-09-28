/**
 * pycompat.ts — 字符串语义层
 *
 * 引擎最初是一个 Python 脚本，输出格式（排序、截断、空白处理）沿用它的语义，
 * 保证同一份笔记无论何时何地生成的区块都一字不差。Python 与 JS 在下列语义上**不等价**，必须显式复刻：
 *
 *   1. sorted() 按 code point 排序，JS 的 Array.sort() 默认按 UTF-16 code unit
 *      → 仅在 astral 字符（emoji、扩展 B 区汉字）上分叉
 *   2. str.strip() 的空白字符集合与 JS 的 \s 不同（Python 多 \x1c-\x1f、\x85，
 *      JS 多 \uFEFF）
 *   3. len(str) / str[:n] 按 code point，JS 的 .length / .slice() 按 UTF-16
 *   4. str.splitlines() 的行边界比 JS 的 split("\n") 多
 *   5. re.sub 默认全局，JS 需 g 标志（本文件不涉及，见各调用点）
 *
 * 本文件只放纯函数，无任何 Obsidian 依赖。
 */

/**
 * Python `str.isspace()` 为真的字符类（正则字符类片段，不含方括号）。
 * 与 JS 的 `\s` 的差异：Python 多 \x1c-\x1f 与 \x85，JS 多 \uFEFF。
 * 凡是需要这套空白语义的正则都要用这个类而不是 `\s`。
 */
export const PY_WS_CLASS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const PY_WS = PY_WS_CLASS;

const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const PY_LSTRIP_GT_RE = /^[> ]+/;

/** 等价于 Python `s.rstrip()`。 */
export function pyRstrip(s: string): string {
  return s.replace(new RegExp(`[${PY_WS}]+$`), "");
}

/** 等价于 Python `s.strip()`。 */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/** 等价于 Python `s.lstrip("> ")`：剥掉开头属于集合 {'>',' '} 的字符（不是前缀匹配）。 */
export function pyLstripQuoteSpace(s: string): string {
  return s.replace(PY_LSTRIP_GT_RE, "");
}

/** 等价于 Python `len(s)`：按 code point 计数。 */
export function pyLen(s: string): number {
  let n = 0;
  const it = s[Symbol.iterator]();
  while (!it.next().done) n++;
  return n;
}

/** 等价于 Python `s[:n]`：按 code point 切片。 */
export function pySlice(s: string, end: number): string {
  const out: string[] = [];
  let i = 0;
  for (const ch of s) {
    if (i >= end) break;
    out.push(ch);
    i++;
  }
  return out.join("");
}

/** 等价于 Python `sorted(list[str])`：按 code point 字典序。 */
export function pySort(list: readonly string[]): string[] {
  return [...list].sort(pyCompare);
}

/** Python 字符串比较：逐 code point 比较。 */
export function pyCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const an = ai.next();
    const bn = bi.next();
    if (an.done && bn.done) return 0;
    if (an.done) return -1;
    if (bn.done) return 1;
    const ac = an.value.codePointAt(0) as number;
    const bc = bn.value.codePointAt(0) as number;
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
}

/** Python 的行边界集合（str.splitlines）：\n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029 */
// eslint-disable-next-line no-control-regex -- \x1c-\x1e 正是 Python 认的行边界，必须照抄
const LINE_BREAK_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** 等价于 Python `s.splitlines()`（注意：末尾空行不产生额外元素，与 split 不同）。 */
export function pySplitLines(s: string): string[] {
  if (s === "") return [];
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = LINE_BREAK_RE.exec(rest);
    if (!m || m.index === undefined) break;
    const at = i + m.index;
    out.push(s.slice(start, at));
    i = at + m[0].length;
    start = i;
  }
  // 尾部残片只在非空时入列："a\n".splitlines() == ['a'] 而不是 ['a','']
  // （每个行边界已经"关闭"了它前面的那一行，末尾空串不构成新行；
  //   "a\n\n" 的末尾空元素来自第二个边界，不是残片）
  const tail = s.slice(start);
  if (tail !== "") out.push(tail);
  return out;
}

/** 等价于 Python `os.path.basename`。 */
export function pyBasename(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

/** 等价于 Python `re.escape`（Python 3.7+ 只转义 ASCII 非字母数字以外的特殊字符）。 */
export function pyReEscape(s: string): string {
  return s.replace(/[\\^$*+?.()|[\]{}-]/g, (c) => "\\" + c);
}

/**
 * 复刻 Python 读文本文件时的通用换行（universal newlines）行为：
 * \r\n 与 \r 都归一为 \n。Python 的 open(..., encoding=...) 文本模式默认如此，
 * 因此 CRLF 文件被读入后内容里已无 \r，写回时也是 \n。
 * BOM 不剥离（utf-8 而非 utf-8-sig）。
 */
export function pyUniversalNewlines(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

/** 本地日期 YYYY-MM-DD（对应 Python `date.today().isoformat()`，注意不是 UTC）。 */
export function localIsoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
