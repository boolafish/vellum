import { ViewPlugin, EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";

/**
 * A custom overlay scrollbar for the editor scroller.
 *
 * WKWebView won't repaint `::-webkit-scrollbar` pseudo-elements when an author
 * class toggles, so a CSS-driven auto-hide is unreliable; and native overlay
 * scrollbars can't be recoloured to suit the paper theme (and don't auto-hide
 * at all when the OS "Show scroll bars" setting is "Always"). So we draw our
 * own: a slim rounded thumb (a real <div>, whose opacity animates reliably)
 * positioned from CodeMirror's own scroll geometry. It fades in while scrolling
 * or dragging and fades out after a short idle.
 */
const IDLE_MS = 250;
const MIN_THUMB = 36;

class OverlayScrollbar implements PluginValue {
  private readonly thumb: HTMLDivElement;
  private idleTimer = 0;
  private dragging = false;
  private dragStartY = 0;
  private dragStartScroll = 0;

  constructor(private readonly view: EditorView) {
    this.thumb = document.createElement("div");
    this.thumb.className = "cm-overlay-scrollbar";
    // Mounted on the non-scrolling editor box so it stays fixed while content
    // scrolls beneath it (positioning context set in styles.css).
    view.dom.appendChild(this.thumb);

    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    this.thumb.addEventListener("mousedown", this.onThumbDown);
    this.measure(false);
  }

  update(u: ViewUpdate): void {
    // Reposition (without revealing) when content height or layout changes.
    if (u.docChanged || u.geometryChanged || u.viewportChanged) this.measure(false);
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragUp);
    clearTimeout(this.idleTimer);
    this.thumb.remove();
  }

  private metrics() {
    const s = this.view.scrollDOM;
    return { clientH: s.clientHeight, scrollH: s.scrollHeight, scrollT: s.scrollTop };
  }

  private thumbHeight(clientH: number, scrollH: number): number {
    return Math.max(MIN_THUMB, (clientH / scrollH) * clientH);
  }

  /** Size + position the thumb from current scroll geometry. */
  private measure(reveal: boolean): void {
    const { clientH, scrollH, scrollT } = this.metrics();
    if (scrollH <= clientH + 1) {
      // No overflow — nothing to scroll, keep it hidden.
      this.thumb.style.display = "none";
      return;
    }
    this.thumb.style.display = "";
    const thumbH = this.thumbHeight(clientH, scrollH);
    const maxTop = clientH - thumbH;
    const top = maxTop > 0 ? (scrollT / (scrollH - clientH)) * maxTop : 0;
    this.thumb.style.height = `${thumbH}px`;
    this.thumb.style.transform = `translateY(${top}px)`;
    if (reveal) this.reveal();
  }

  /** Show the thumb and (re)arm the idle fade-out. */
  private reveal(): void {
    this.thumb.classList.add("visible");
    clearTimeout(this.idleTimer);
    if (!this.dragging) {
      this.idleTimer = window.setTimeout(() => this.thumb.classList.remove("visible"), IDLE_MS);
    }
  }

  private readonly onScroll = (): void => this.measure(true);
  private readonly onResize = (): void => this.measure(false);

  private readonly onThumbDown = (e: MouseEvent): void => {
    e.preventDefault();
    this.dragging = true;
    this.dragStartY = e.clientY;
    this.dragStartScroll = this.view.scrollDOM.scrollTop;
    this.thumb.classList.add("dragging", "visible");
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragUp);
  };

  private readonly onDragMove = (e: MouseEvent): void => {
    const { clientH, scrollH } = this.metrics();
    const maxTop = clientH - this.thumbHeight(clientH, scrollH);
    if (maxTop <= 0) return;
    const ratio = (e.clientY - this.dragStartY) / maxTop;
    this.view.scrollDOM.scrollTop = this.dragStartScroll + ratio * (scrollH - clientH);
  };

  private readonly onDragUp = (): void => {
    this.dragging = false;
    this.thumb.classList.remove("dragging");
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragUp);
    this.reveal(); // restart the idle fade now that the drag is done
  };
}

export const overlayScrollbar = ViewPlugin.fromClass(OverlayScrollbar);
