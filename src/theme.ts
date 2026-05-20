import frameLight from "@milkdown/crepe/theme/frame.css?url";
import frameDark from "@milkdown/crepe/theme/frame-dark.css?url";

export type ThemeMode = "light" | "dark" | "system";

/**
 * Applies the appearance preference (owned/persisted in Rust). Swaps Crepe's
 * light/dark editor stylesheet and sets `data-theme` on <html> for our own
 * chrome. "system" follows the OS via prefers-color-scheme and live-updates.
 */
class ThemeManager {
  private mode: ThemeMode = "system";
  private readonly link = document.createElement("link");
  private readonly mql = window.matchMedia("(prefers-color-scheme: dark)");

  init(): void {
    this.link.rel = "stylesheet";
    document.head.appendChild(this.link);
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
    this.link.href = dark ? frameDark : frameLight;
    const root = document.documentElement;
    if (this.mode === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", this.mode);
    }
  }
}

export const theme = new ThemeManager();
