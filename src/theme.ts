import type { EditorController } from "./editor";

export type ThemeMode = "light" | "dark" | "system";

/**
 * Applies the appearance preference (owned/persisted in Rust). Sets `data-theme`
 * on <html> for our own chrome (toolbar/modal/find-bar) and tells the editor to
 * reconfigure its CodeMirror theme + syntax highlighting. "system" follows the
 * OS via prefers-color-scheme and live-updates.
 */
class ThemeManager {
  private mode: ThemeMode = "system";
  private editor: EditorController | null = null;
  private readonly mql = window.matchMedia("(prefers-color-scheme: dark)");

  /** App passes the editor so theme changes can reconfigure CM's appearance. */
  init(editor?: EditorController): void {
    if (editor) this.editor = editor;
    this.mql.addEventListener("change", () => {
      if (this.mode === "system") this.render();
    });
    this.render();
  }

  apply(mode: ThemeMode): void {
    this.mode = mode;
    this.render();
  }

  private render(): void {
    const dark = this.mode === "dark" || (this.mode === "system" && this.mql.matches);
    const root = document.documentElement;
    if (this.mode === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", this.mode);
    }
    this.editor?.setTheme(dark);
  }
}

export const theme = new ThemeManager();
