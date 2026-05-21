import type { EditorController } from "./editor";

const DEBOUNCE_MS = 120;

/**
 * Typora-style Find / Replace bar: a full-width strip inserted at the top of
 * the editor area (in the layout flow, so it pushes content down instead of
 * overlapping it). Collapsed to just the Find row by default; an expand chevron
 * reveals the Replace row. Drives the editor's search via the EditorController:
 * typing updates the live highlight (debounced); Enter → next, Shift+Enter →
 * prev, Esc → close + clear.
 */
export class FindBar {
  private readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly caseToggle: HTMLButtonElement;
  private readonly wordToggle: HTMLButtonElement;
  private readonly regexToggle: HTMLButtonElement;
  private readonly expandBtn: HTMLButtonElement;
  private readonly countLabel: HTMLSpanElement;
  private open_ = false;
  private expanded = false;
  private debounce: number | undefined;
  // Closes on Esc even when focus is in the editor (not just inside the bar).
  private readonly onWindowKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.open_) {
      e.preventDefault();
      this.close();
    }
  };

  constructor(private readonly editor: EditorController) {
    this.el = document.createElement("div");
    this.el.className = "find-bar hidden";
    this.el.setAttribute("role", "search");
    this.el.innerHTML = `
      <div class="find-row find-row-main">
        <button type="button" class="find-expand" title="Toggle Replace" aria-label="Toggle Replace" aria-expanded="false">›</button>
        <input type="text" class="find-input" placeholder="Find" aria-label="Find" spellcheck="false" />
        <span class="find-count" aria-live="polite"></span>
        <button type="button" class="find-btn find-case" title="Match Case" aria-label="Match Case" aria-pressed="false">Aa</button>
        <button type="button" class="find-btn find-word" title="Whole Word" aria-label="Whole Word" aria-pressed="false">W</button>
        <button type="button" class="find-btn find-regex" title="Regular Expression" aria-label="Regular Expression" aria-pressed="false">.*</button>
        <button type="button" class="find-btn find-prev" title="Previous (⇧ return)" aria-label="Previous match">↑</button>
        <button type="button" class="find-btn find-next" title="Next (return)" aria-label="Next match">↓</button>
        <button type="button" class="find-btn find-close" title="Close (esc)" aria-label="Close">✕</button>
      </div>
      <div class="find-row find-row-replace">
        <input type="text" class="find-replace" placeholder="Replace" aria-label="Replace" spellcheck="false" />
        <button type="button" class="find-btn find-replace-one">Replace</button>
        <button type="button" class="find-btn find-replace-all">All</button>
      </div>`;

    this.input = this.q(".find-input");
    this.replaceInput = this.q(".find-replace");
    this.caseToggle = this.q(".find-case");
    this.wordToggle = this.q(".find-word");
    this.regexToggle = this.q(".find-regex");
    this.expandBtn = this.q(".find-expand");
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

    for (const btn of [this.caseToggle, this.wordToggle, this.regexToggle]) {
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") !== "true";
        btn.setAttribute("aria-pressed", String(on));
        btn.classList.toggle("active", on);
        this.input.focus();
        this.runSearch();
      });
    }
    this.expandBtn.addEventListener("click", () => this.setExpanded(!this.expanded));
    this.q(".find-next").addEventListener("click", () => this.next());
    this.q(".find-prev").addEventListener("click", () => this.prev());
    this.q(".find-close").addEventListener("click", () => this.close());
    this.q(".find-replace-one").addEventListener("click", () => this.replaceOne());
    this.q(".find-replace-all").addEventListener("click", () => this.replaceAll());

    // Insert at the top of the editor area so the bar pushes content down.
    const app = document.getElementById("app");
    const editorEl = document.getElementById("editor");
    if (app && editorEl) app.insertBefore(this.el, editorEl);
    else document.body.appendChild(this.el);
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.el.querySelector<T>(sel)!;
  }

  toggle(): void {
    if (this.open_) this.close();
    else this.open();
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.el.classList.toggle("expanded", expanded);
    this.expandBtn.setAttribute("aria-expanded", String(expanded));
    this.expandBtn.textContent = expanded ? "⌄" : "›";
    (expanded ? this.replaceInput : this.input).focus();
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
    const on = (b: HTMLButtonElement) => b.getAttribute("aria-pressed") === "true";
    const count = this.editor.setSearch({
      query: this.input.value,
      replace: this.replaceInput.value,
      caseSensitive: on(this.caseToggle),
      wholeWord: on(this.wordToggle),
      regexp: on(this.regexToggle),
    });
    this.renderCount(count);
  }

  private renderCount(count: number | null): void {
    if (!this.input.value || count === null) {
      this.countLabel.textContent = "";
    } else if (count === 0) {
      this.countLabel.textContent = "0";
      this.countLabel.title = "No results";
    } else {
      // Compact count so the input gets more room.
      this.countLabel.textContent = String(count);
      this.countLabel.title = `${count} match${count === 1 ? "" : "es"}`;
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
