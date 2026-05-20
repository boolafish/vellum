import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { $prose } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/prose/view";
import {
  SearchQuery,
  findNext,
  findPrev,
  replaceAll,
  replaceNext,
  search,
  setSearchState,
} from "prosemirror-search";
import "@milkdown/crepe/theme/common/style.css";
// The light/dark frame theme is loaded dynamically by theme.ts.

// Stable remark-stringify options so saving normalizes markdown predictably
// instead of drifting between `*`/`_`, `-`/`*` bullets, indentation, etc.
// (Milkdown serializes from a document tree, so some normalization is
// unavoidable; pinning these keeps it consistent and diff-friendly.)
const STRINGIFY_OPTIONS = {
  bullet: "-",
  emphasis: "_",
  strong: "*",
  fence: "`",
  fences: true,
  rule: "-",
  ruleSpaces: false,
  listItemIndent: "one",
  incrementListMarker: true,
  resourceLink: true,
} as const;

/**
 * Wraps a Milkdown Crepe instance. Crepe instances are immutable after
 * create(), so loading a new document tears down the old editor and builds
 * a fresh one — this class hides that lifecycle behind load()/getMarkdown().
 */
export interface SearchOptions {
  query: string;
  replace: string;
  caseSensitive: boolean;
}

export class EditorController {
  private crepe: Crepe | null = null;
  private changeCb: () => void = () => {};
  // Captured per-load(): Crepe rebuilds its ProseMirror view on every load(),
  // so the view (and the search plugin attached to it) must be recaptured.
  private view: EditorView | null = null;

  constructor(private readonly root: string) {}

  /** Fired on every user edit (not on programmatic load()). */
  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  async load(content: string): Promise<void> {
    // Drop the old view up front: it's destroyed below, and search methods
    // read this.view, so this prevents any operation on a torn-down view.
    this.view = null;
    if (this.crepe) await this.crepe.destroy();
    const crepe = new Crepe({ root: this.root, defaultValue: content });
    // Configure the serializer before create() so saves are deterministic.
    // Defensive: a config hiccup must never prevent the editor from rendering.
    crepe.editor.config((ctx) => {
      try {
        ctx.set(remarkStringifyOptionsCtx, {
          ...ctx.get(remarkStringifyOptionsCtx),
          ...STRINGIFY_OPTIONS,
        });
      } catch (err) {
        console.warn("Could not configure markdown serializer:", err);
      }
    });
    // Register prosemirror-search's plugin into the same ProseMirror instance
    // Milkdown uses. $prose appends to prosePluginsCtx using Milkdown's bundled
    // prosemirror-state/view, so highlight decorations and commands work.
    crepe.editor.use($prose(() => search()));
    await crepe.create();
    // Attached after create() so the initial document load doesn't mark dirty.
    crepe.on((listener) => listener.markdownUpdated(() => this.changeCb()));
    this.view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    this.crepe = crepe;
  }

  getMarkdown(): string {
    return this.crepe?.getMarkdown() ?? "";
  }

  // --- Find / Replace (wraps prosemirror-search against the captured view) ---

  /**
   * Highlight all matches for `query`. Returns the match count (cheap doc
   * scan), or null if the editor/view isn't ready or the query is empty.
   */
  setSearch(opts: SearchOptions): number | null {
    const view = this.view;
    if (!view) return null;
    const query = new SearchQuery({
      search: opts.query,
      replace: opts.replace,
      caseSensitive: opts.caseSensitive,
    });
    view.dispatch(setSearchState(view.state.tr, query));
    if (!query.valid) return 0;
    let count = 0;
    let result = query.findNext(view.state);
    while (result) {
      count++;
      const next = query.findNext(view.state, result.to);
      // Guard against zero-width matches looping forever.
      if (next && next.from <= result.from) break;
      result = next;
    }
    return count;
  }

  findNext(): void {
    this.runSearchCommand(findNext);
  }

  findPrev(): void {
    this.runSearchCommand(findPrev);
  }

  replaceNext(): void {
    this.runSearchCommand(replaceNext);
  }

  replaceAll(): void {
    this.runSearchCommand(replaceAll);
  }

  /** Clear the active query so highlights disappear. */
  clearSearch(): void {
    const view = this.view;
    if (!view) return;
    view.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: "" })));
  }

  private runSearchCommand(cmd: (state: EditorView["state"], dispatch: EditorView["dispatch"]) => boolean): void {
    const view = this.view;
    if (!view) return;
    cmd(view.state, view.dispatch);
    view.focus();
  }
}
