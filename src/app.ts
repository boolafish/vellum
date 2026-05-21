import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { EditorController } from "./editor";
import { FindBar } from "./find";
import { Action, MENU_EVENT, OPEN_FILE_EVENT, isAction } from "./ipc";
import { confirmUnsavedChanges } from "./dialog";
import { theme, type ThemeMode } from "./theme";
import { basename, pickOpenPath, pickSavePath, readFile, writeFile } from "./files";

const DEFAULT_DOC = `# Welcome

Start typing. This is a **Typora-style** markdown editor.

- Syntax-highlighted markdown source
- \`⌘O\` to open · \`⌘S\` to save · \`⇧⌘S\` save as
- \`⌘F\` to find and replace

> Built with Tauri 2 + CodeMirror 6.
`;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
const OPENABLE = /\.(md|markdown|txt)$/i;

/** Top-level controller: owns document state and routes menu actions. */
export class App {
  private readonly editor = new EditorController("#editor");
  private readonly findBar = new FindBar(this.editor);
  private readonly filenameEl = document.querySelector<HTMLElement>("#filename")!;
  private readonly dirtyEl = document.querySelector<HTMLElement>("#dirty-dot")!;

  private currentPath: string | null = null;
  private dirty = false;
  private zoom = 1;
  private busy = false;
  private closing = false;
  private pendingClose = false;

  async start(): Promise<void> {
    theme.init(this.editor);
    this.editor.onChange(() => this.setDirty(true));
    this.editor.onOpenLink((url) => void this.openLink(url));
    const launchFiles = await this.wireNativeIntegrations();
    await this.applyStoredTheme();
    await this.openInitialDoc(launchFiles);
    await this.updateChrome();
  }

  /** Open a ⌘-clicked link externally. Accepts http(s)/mailto; a bare domain
   *  (e.g. example.com/x) is treated as https. Anything else is ignored for
   *  safety (a placeholder like "xxxxx" won't open). */
  private async openLink(url: string): Promise<void> {
    let target: string | null = null;
    if (/^(https?|mailto):/i.test(url)) {
      target = url;
    } else if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(url)) {
      target = `https://${url}`; // bare domain like example.com/path
    }
    if (!target) return;
    try {
      await openUrl(target);
    } catch (err) {
      console.error("Could not open link:", err);
    }
  }

  private async applyStoredTheme(): Promise<void> {
    try {
      theme.apply((await invoke<string>("get_theme")) as ThemeMode);
    } catch {
      /* not running under Tauri; theme.init() already applied "system" */
    }
  }

  /**
   * Wire the native menu, close guard, and file-opening. Best-effort: if we're
   * not running under Tauri (e.g. plain `vite dev` in a browser), this returns
   * [] so the editor still loads. Otherwise returns any launch files.
   */
  private async wireNativeIntegrations(): Promise<string[]> {
    try {
      await this.installCloseGuard();
      await this.installFileOpening();
      await listen<string>(MENU_EVENT, (e) => {
        if (isAction(e.payload)) void this.handle(e.payload);
      });
      await listen<string>("theme-changed", (e) => theme.apply(e.payload as ThemeMode));
      // Tell Rust the UI is ready; collect files the app was launched with.
      return await invoke<string[]>("frontend_ready");
    } catch {
      return [];
    }
  }

  private async openInitialDoc(launchFiles: string[]): Promise<void> {
    const launchFile = launchFiles.find((p) => OPENABLE.test(p));
    if (launchFile) {
      await this.loadPath(launchFile);
    } else if (!(await this.reopenLastFile())) {
      await this.editor.load(DEFAULT_DOC);
      this.setDirty(false);
    }
  }

  private handle(action: Action): Promise<void> {
    // Find/Undo/Redo act synchronously on the editor view (not async file ops),
    // so keep them out of the `busy` re-entrancy gate.
    switch (action) {
      case Action.Find:
        this.findBar.toggle();
        return Promise.resolve();
      case Action.Undo:
        this.editor.undo();
        return Promise.resolve();
      case Action.Redo:
        this.editor.redo();
        return Promise.resolve();
    }
    return this.runExclusive(() => this.dispatch(action));
  }

  /**
   * Runs one mutating operation at a time and reports failures to the user, so
   * an in-flight Open can't interleave with a Save and I/O errors surface
   * instead of becoming silent rejections. A close request that arrives while
   * busy is deferred (pendingClose) and retried here, so it's never dropped.
   */
  private async runExclusive(op: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await op();
    } catch (err) {
      console.error("Action failed:", err);
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
      if (this.pendingClose && !this.closing) {
        this.pendingClose = false;
        void this.requestClose();
      }
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
      case Action.Undo:
      case Action.Redo:
        // Handled in handle() before the busy gate; never reaches here.
        return;
    }
  }

  // --- Document operations (each guards unsaved changes first) ---

  private async newDoc(): Promise<void> {
    if (!(await this.confirmProceed())) return;
    this.findBar.close();
    await this.editor.load("");
    this.currentPath = null;
    this.editor.setDocPath(null);
    this.setDirty(false);
  }

  private async openViaDialog(): Promise<void> {
    if (!(await this.confirmProceed())) return;
    const path = await pickOpenPath();
    if (path) await this.loadPath(path);
  }

  /** Open a path supplied by the OS (launch file, "Open With", drag-on-dock). */
  private openExternal(path: string): Promise<void> {
    return this.runExclusive(async () => {
      if (await this.confirmProceed()) await this.loadPath(path);
    });
  }

  private async loadPath(path: string): Promise<void> {
    const text = await readFile(path);
    this.findBar.close(); // stale highlights/query don't belong to the new doc
    await this.editor.load(text);
    this.currentPath = path;
    this.editor.setDocPath(path);
    this.setDirty(false);
    void this.recordRecent(path);
  }

  /** Reopen the most recent file on launch. Returns false if there's none. */
  private async reopenLastFile(): Promise<boolean> {
    try {
      const recents = await invoke<string[]>("get_recents");
      const last = recents[0]; // Rust prunes paths that no longer exist
      if (!last) return false;
      await this.loadPath(last);
      return true;
    } catch {
      return false;
    }
  }

  private async recordRecent(path: string): Promise<void> {
    try {
      await invoke("add_recent", { path });
    } catch {
      /* not running under Tauri */
    }
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
    this.editor.setDocPath(path);
    this.setDirty(false);
    void this.recordRecent(path);
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
    await getCurrentWindow().onCloseRequested((event) => {
      // Hold the native close; we destroy manually once the guard approves.
      event.preventDefault();
      void this.requestClose();
    });
  }

  private async requestClose(): Promise<void> {
    if (this.closing) return;
    if (this.busy) {
      // A menu action / file open is mid-flight (e.g. a dialog is open).
      // Defer; runExclusive's finally retries this so the close isn't lost.
      this.pendingClose = true;
      return;
    }
    await this.runExclusive(async () => {
      if (await this.confirmProceed()) {
        this.closing = true;
        await getCurrentWindow().destroy();
      }
    });
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
    // Scales the editor's font size via a CM theme compartment (no inner
    // re-layout of the chrome).
    this.editor.setZoom(this.zoom);
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
