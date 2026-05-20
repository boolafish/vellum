import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { EditorController } from "./editor";
import { Action, MENU_EVENT, isAction } from "./ipc";
import { basename, pickOpenPath, pickSavePath, readFile, writeFile } from "./files";

const DEFAULT_DOC = `# Welcome

Start typing. This is a **Typora-style** WYSIWYG markdown editor.

- Live inline rendering
- \`⌘O\` to open · \`⌘S\` to save · \`⇧⌘S\` save as
- Tables, code blocks, and math included

> Built with Tauri 2 + Milkdown.
`;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;

/** Top-level controller: owns document state and routes menu actions. */
export class App {
  private readonly editor = new EditorController("#editor");
  private readonly editorEl = document.querySelector<HTMLElement>("#editor")!;
  private readonly filenameEl = document.querySelector<HTMLElement>("#filename")!;
  private readonly dirtyEl = document.querySelector<HTMLElement>("#dirty-dot")!;

  private currentPath: string | null = null;
  private dirty = false;
  private zoom = 1;

  async start(): Promise<void> {
    this.editor.onChange(() => this.setDirty(true));
    await this.editor.load(DEFAULT_DOC);
    this.setDirty(false);
    await listen<string>(MENU_EVENT, (e) => {
      if (isAction(e.payload)) void this.dispatch(e.payload);
    });
    await this.updateChrome();
  }

  private dispatch(action: Action): Promise<void> | void {
    switch (action) {
      case Action.New:
        return this.newDoc();
      case Action.Open:
        return this.openDoc();
      case Action.Save:
        return void this.saveDoc(false);
      case Action.SaveAs:
        return void this.saveDoc(true);
      case Action.Close:
        return void getCurrentWindow().close();
      case Action.ZoomIn:
        return this.applyZoom(this.zoom + ZOOM_STEP);
      case Action.ZoomOut:
        return this.applyZoom(this.zoom - ZOOM_STEP);
      case Action.ZoomReset:
        return this.applyZoom(1);
      case Action.Find:
        return; // Phase 7
    }
  }

  private async newDoc(): Promise<void> {
    await this.editor.load("");
    this.currentPath = null;
    this.setDirty(false);
  }

  private async openDoc(): Promise<void> {
    const path = await pickOpenPath();
    if (path) await this.loadPath(path);
  }

  private async loadPath(path: string): Promise<void> {
    const text = await readFile(path);
    await this.editor.load(text);
    this.currentPath = path;
    this.setDirty(false);
  }

  /** Returns true if the document was saved (false if the user cancelled). */
  private async saveDoc(forceDialog: boolean): Promise<boolean> {
    let path = this.currentPath;
    if (!path || forceDialog) {
      path = await pickSavePath(path ?? "Untitled.md");
      if (!path) return false;
    }
    await writeFile(path, this.editor.getMarkdown());
    this.currentPath = path;
    this.setDirty(false);
    return true;
  }

  private applyZoom(next: number): void {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
    // `zoom` is well-supported in WKWebView and scales the whole editor cleanly.
    this.editorEl.style.zoom = String(this.zoom);
  }

  private setDirty(value: boolean): void {
    this.dirty = value;
    this.dirtyEl.classList.toggle("hidden", !value);
    void this.updateChrome();
  }

  private async updateChrome(): Promise<void> {
    const name = this.currentPath ? basename(this.currentPath) : "Untitled";
    this.filenameEl.textContent = name;
    try {
      await getCurrentWindow().setTitle(`${this.dirty ? "• " : ""}${name}`);
    } catch {
      /* running outside Tauri (e.g. plain vite preview) */
    }
  }
}
