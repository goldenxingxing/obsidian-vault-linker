/**
 * locale.ts — 取 Obsidian 的界面语言，新旧版本都能用
 *
 * 1.8.7 起有官方的 getLanguage()；更早的版本没有这个导出（运行时是 undefined），
 * 退回 moment.locale()——Obsidian 启动时会把 moment 设成界面语言。
 * 两者返回 "zh" / "zh-TW" / "en" 之类，调用方只看是不是 zh 开头。
 */

import * as obsidian from "obsidian";

export function obsidianLocale(): string {
  const getLanguage = (obsidian as { getLanguage?: () => string }).getLanguage;
  if (typeof getLanguage === "function") {
    try {
      return getLanguage();
    } catch {
      /* 落到 moment */
    }
  }
  return obsidian.moment.locale();
}
