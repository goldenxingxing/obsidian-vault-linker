/**
 * i18n.ts — 界面文案的语言（设置页、命令、提示、运行报告）
 *
 * 跟随 Obsidian 的界面语言：zh* 显示中文，其余显示英文。插件加载时由 main.ts 用
 * moment.locale() 设定一次。本模块不在运行时 import "obsidian"，因此 runner.ts 等
 * 可以在 Node 里测试（测试里自己调用 setUiLocale）。
 *
 * 写法：t("中文", "English")，两种语言写在同一处，改一处时另一处就在眼前。
 * 生成进笔记里的文案不走这里，由设置里的「语言」和 texts 决定。
 */

let zh = false;

export function setUiLocale(locale: string | undefined): void {
  zh = (locale ?? "").toLowerCase().startsWith("zh");
}

export function isZhUi(): boolean {
  return zh;
}

export function t(zhText: string, enText: string): string {
  return zh ? zhText : enText;
}
