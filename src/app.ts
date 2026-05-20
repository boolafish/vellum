import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";

import { EditorController } from "./editor";
import { Action, MENU_EVENT, OPEN_FILE_EVENT, isAction } from "./ipc";
import { confirmUnsavedChanges } from "./dialog";
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
const OPENABLE = /\.(md|markdown|txt)$/i;

/** Top-level controller: owns document state and routes menu actions. */
export class App {
  private readonly editor = new EditorController("#editor");
  private readonly editorEl = document.querySelector<HTMLElement>("#editor")!;
  private readonly filenameEl = document.querySelector<HTMLElement>("#filename")!;
  private readonly dirtyEl = document.querySelector<HTMLElement>("#dirty-dot")!;

  private currentPath: string | null = null;
  private dirty = false;
  private zoom = 1;
  private busy = false;
  private closing = false;

  async start(): Promise<void> {
    this.editor.onChange(() => this.setDirty(true));

    await this.installCloseGuard();
    await this.installFileOpening();
    await listen<string>(MENU_EVENT, (e) => {
      if (isAction(e.payload)) void this.handle(e.payload);
    });

    // Tell Rust the UI is ready and collect any file the app was launched with
    // (Finder "Open With" / double-click). Falls back to the welcome document.
    let launchFiles: string[] = [];
    try {
      launchFiles = await invoke<string[]>("frontend_ready");
    } catch {
      /* not running under Tauri */
    }
    const launchFile = launchFiles.find((p) => OPENABLE.test(p));
    if (launchFile) {
      await this.loadPath(launchFile);
    } else {
      await this.editor.load(DEFAULT_DOC);
      this.setDirty(false);
    }
    await this.updateChrome();
  }

  /**
   * Serializes menu actions (one at a time) and reports failures to the user,
   * so an in-flight Open can't interleave with a Save, and file-I/O errors
   * surface instead of becoming silent rejections.
   */
  private async handle(action: Action): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.dispatch(action);
    } catch (err) {
      console.error(`Action "${action}" failed:`, err);
      try {
        await message(err instanceof Error ? err.message : String(err), {
          title: "Something went wrong",
          kind: "error",
        });
      } catch {
        /* dialog unavailable outside Tauri */
      }
    } finally {
      this.busy = false;
    }
  }

  private async dispatch(action: Action): Promise<void> {
    switch (action) {
      case Action.New:
        return this.newDoc();
      case Action.Open:
        return this.openViaDialog();
      case Action.Save:
        await this.saveDoc(false);
        return;
      case Action.SaveAs:
        await this.saveDoc(true);
        return;
      case Action.Close:
      case Action.Quit:
        // Both route through the window close request, which runs the dirty
        // guard; closing the only window quits the app (handled in Rust).
        return getCurrentWindow().close();
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

  // --- Document operations (each guards unsaved changes first) ---

  private async newDoc(): Promise<void> {
    if (!(await this.confirmProceed())) return;
    await this.editor.load("");
    this.currentPath = null;
    this.setDirty(false);
  }

  private async openViaDialog(): Promise<void> {
    if (!(await this.confirmProceed())) return;
    const path = await pickOpenPath();
    if (path) await this.loadPath(path);
  }

  /** Open a path supplied by the OS (launch file, "Open With", drag-on-dock). */
  private async openExternal(path: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.confirmProceed())) return;
      await this.loadPath(path);
    } catch (err) {
      console.error("Open failed:", err);
    } finally {
      this.busy = false;
    }
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

  /**
   * Resolves true if the caller may proceed (discard/replace the current doc).
   * Prompts only when there are unsaved changes; "Save" must succeed to proceed.
   */
  private async confirmProceed(): Promise<boolean> {
    if (!this.dirty) return true;
    const name = this.currentPath ? basename(this.currentPath) : "Untitled";
    const choice = await confirmUnsavedChanges(name);
    if (choice === "cancel") return false;
    if (choice === "save") return this.saveDoc(false);
    return true; // don't save
  }

  // --- Window & OS integration ---

  private async installCloseGuard(): Promise<void> {
    const win = getCurrentWindow();
    await win.onCloseRequested((event) => {
      // Always hold the native close; we destroy manually once approved so the
      // guard can run async without the window vanishing underneath it.
      event.preventDefault();
      void this.handleCloseRequest();
    });
  }

  private async handleCloseRequest(): Promise<void> {
    if (this.closing || this.busy) return;
    this.busy = true;
    try {
      if (await this.confirmProceed()) {
        this.closing = true;
        await getCurrentWindow().destroy();
      }
    } finally {
      this.busy = false;
    }
  }

  private async installFileOpening(): Promise<void> {
    // Files opened while the app is already running.
    await listen<string>(OPEN_FILE_EVENT, (e) => {
      if (typeof e.payload === "string") void this.openExternal(e.payload);
    });
    // Files dragged onto the window.
    await getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const path = event.payload.paths.find((p) => OPENABLE.test(p));
      if (path) void this.openExternal(path);
    });
  }

  // --- View / chrome ---

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
