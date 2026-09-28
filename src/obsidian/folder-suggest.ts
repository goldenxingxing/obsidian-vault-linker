/**
 * folder-suggest.ts — 文件夹输入框的下拉补全
 *
 * multi = true 时输入框是逗号分隔的列表：只补全最后一段，前面的保留。
 */

import { AbstractInputSuggest, TFolder, type App } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<string> {
  private readonly vaultApp: App;
  private readonly input: HTMLInputElement;
  private readonly multi: boolean;

  constructor(app: App, input: HTMLInputElement, multi = false) {
    super(app, input);
    this.vaultApp = app;
    this.input = input;
    this.multi = multi;
  }

  protected getSuggestions(query: string): string[] {
    const part = (this.multi ? query.split(",").pop() ?? "" : query).trim().toLowerCase();
    const out: string[] = [];
    for (const f of this.vaultApp.vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder) || f.isRoot()) continue;
      if (f.path.toLowerCase().includes(part)) out.push(f.path);
    }
    return out.sort((a, b) => a.localeCompare(b)).slice(0, 50);
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.setText(path);
  }

  override selectSuggestion(path: string): void {
    let value = path;
    if (this.multi) {
      const parts = this.input.value.split(",").map((p) => p.trim());
      parts[parts.length - 1] = path;
      value = parts.filter(Boolean).join(", ");
    }
    this.setValue(value);
    // 让 TextComponent.onChange 收到改动
    this.input.dispatchEvent(new Event("input"));
    this.close();
  }
}
