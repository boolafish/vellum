import type { EditorController } from "./editor";

const DEBOUNCE_MS = 120;

/**
 * Native-feeling Find / Find & Replace bar pinned to the top-right of the
 * editor. Drives the editor's search (CodeMirror) via the EditorController.
 * Typing updates the live highlight (debounced); Enter → next, Shift+Enter →
 * prev, Esc → close + clear. Only the query/highlight state lives in the
 * editor — this class owns the overlay DOM and the current query inputs.
 */
export class FindBar {
  private readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly caseToggle: HTMLButtonElement;
  private readonly countLabel: HTMLSpanElement;
  private open_ = false;
  private debounce: number | undefined;
  // Closes on Esc even when focus is in the editor (not just inside the bar).
  private readonly onWindowKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.open_) {
      e.preventDefault();
      this.close();
    }
  };

  constructor(
    private readonly editor: EditorController,
    private readonly host: HTMLElement = document.body,
  ) {
    this.el = document.createElement("div");
    this.el.className = "find-bar hidden";
    this.el.setAttribute("role", "search");
    this.el.innerHTML = `
      <div class="find-row">
        <input type="text" class="find-input" placeholder="Find" aria-label="Find" spellcheck="false" />
        <span class="find-count" aria-live="polite"></span>
        <button type="button" class="find-btn find-case" title="Match Case" aria-label="Match Case" aria-pressed="false">Aa</button>
        <button type="button" class="find-btn find-prev" title="Previous (⇧ return)" aria-label="Previous match">↑</button>
        <button type="button" class="find-btn find-next" title="Next (return)" aria-label="Next match">↓</button>
        <button type="button" class="find-btn find-close" title="Close (esc)" aria-label="Close">✕</button>
      </div>
      <div class="find-row">
        <input type="text" class="find-replace" placeholder="Replace" aria-label="Replace" spellcheck="false" />
        <button type="button" class="find-btn find-replace-one">Replace</button>
        <button type="button" class="find-btn find-replace-all">All</button>
      </div>`;

    this.input = this.q(".find-input");
    this.replaceInput = this.q(".find-replace");
    this.caseToggle = this.q(".find-case");
    this.countLabel = this.q(".find-count");

    this.input.addEventListener("input", () => this.scheduleSearch());
    this.replaceInput.addEventListener("input", () => this.scheduleSearch());
    this.input.addEventListener("keydown", (e) => this.onInputKey(e));
    this.replaceInput.addEventListener("keydown", (e) => this.onInputKey(e));
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    this.caseToggle.addEventListener("click", () => {
      const on = this.caseToggle.getAttribute("aria-pressed") !== "true";
      this.caseToggle.setAttribute("aria-pressed", String(on));
      this.caseToggle.classList.toggle("active", on);
      this.runSearch();
    });
    this.q(".find-next").addEventListener("click", () => this.next());
    this.q(".find-prev").addEventListener("click", () => this.prev());
    this.q(".find-close").addEventListener("click", () => this.close());
    this.q(".find-replace-one").addEventListener("click", () => this.replaceOne());
    this.q(".find-replace-all").addEventListener("click", () => this.replaceAll());

    this.host.appendChild(this.el);
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.el.querySelector<T>(sel)!;
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  open(): void {
    // Seed the query with the current selection if it's a short single line.
    const sel = window.getSelection()?.toString() ?? "";
    if (sel && !sel.includes("\n") && sel.length <= 200) {
      this.input.value = sel;
    }
    this.open_ = true;
    this.el.classList.remove("hidden");
    window.addEventListener("keydown", this.onWindowKey, true);
    this.input.focus();
    this.input.select();
    this.runSearch();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.el.classList.add("hidden");
    window.removeEventListener("keydown", this.onWindowKey, true);
    this.editor.clearSearch();
    this.editor.focusEditor(); // return focus so editing resumes
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) this.prev();
      else this.next();
    }
  }

  private scheduleSearch(): void {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      this.debounce = undefined;
      this.runSearch();
    }, DEBOUNCE_MS);
  }

  /** Apply a pending (debounced) query immediately so navigation stays in sync. */
  private flush(): void {
    if (this.debounce !== undefined) {
      window.clearTimeout(this.debounce);
      this.debounce = undefined;
      this.runSearch();
    }
  }

  private runSearch(): void {
    const count = this.editor.setSearch({
      query: this.input.value,
      replace: this.replaceInput.value,
      caseSensitive: this.caseToggle.getAttribute("aria-pressed") === "true",
    });
    this.renderCount(count);
  }

  private renderCount(count: number | null): void {
    if (!this.input.value) {
      this.countLabel.textContent = "";
    } else if (count === null) {
      this.countLabel.textContent = "";
    } else if (count === 0) {
      this.countLabel.textContent = "No results";
    } else {
      this.countLabel.textContent = `${count} match${count === 1 ? "" : "es"}`;
    }
  }

  private next(): void {
    this.flush();
    this.editor.findNext();
  }

  private prev(): void {
    this.flush();
    this.editor.findPrev();
  }

  private replaceOne(): void {
    this.flush();
    this.editor.replaceNext();
    this.runSearch(); // doc changed; recompute remaining matches
  }

  private replaceAll(): void {
    this.flush();
    this.editor.replaceAll();
    this.runSearch();
  }
}
