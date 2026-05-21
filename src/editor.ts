import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo as cmUndo,
  redo as cmRedo,
} from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages as codeLanguages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import {
  search,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
} from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { livePreview, setDocPath, docPathChanged } from "./live-preview";
import { overlayScrollbar } from "./overlay-scrollbar";

export interface SearchOptions {
  query: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
}

/**
 * Document-style highlighting (NOT code-style). The key to a clean Typora look
 * is restraint: body text stays one ink color, emphasis comes from the
 * live-preview layer's weight/size, and the only real color is for links. The
 * markdown markers (#, **, >, backticks…) are dimmed to a low-contrast gray so
 * that when they're revealed on the active line the reveal is quiet, not noisy.
 * We deliberately do NOT color headings/strong/emphasis here.
 */
// Prose: only dimmed markers + link color (deliberately no heading/strong
// color). The remaining tags only ever appear inside fenced code blocks (via
// the nested language parser), so adding them gives code highlighting without
// coloring prose. GitHub-ish light / VS Code-ish dark palettes.
const lightHighlightStyle = HighlightStyle.define([
  // Warm sepia-gray for concealed markdown markers so revealed syntax sits
  // quietly on the cream paper rather than as a cold gray fleck.
  { tag: [tags.processingInstruction, tags.meta], color: "#c0b49a" },
  { tag: [tags.link, tags.url], color: "#2c8a7c" }, // = --accent (light)
  { tag: tags.keyword, color: "#cf222e" },
  { tag: [tags.string, tags.special(tags.string)], color: "#0a3069" },
  { tag: [tags.number, tags.bool, tags.null], color: "#0550ae" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#8250df" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#953800" },
  { tag: [tags.propertyName, tags.attributeName], color: "#0550ae" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "#24292f" },
  { tag: tags.regexp, color: "#116329" },
]);
const darkHighlightStyle = HighlightStyle.define([
  { tag: [tags.processingInstruction, tags.meta], color: "#5c6470" },
  { tag: [tags.link, tags.url], color: "#4db3a4" }, // = --accent (dark)
  { tag: tags.keyword, color: "#569cd6" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ce9178" },
  { tag: [tags.number, tags.bool, tags.null], color: "#b5cea8" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#6a9955", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#dcdcaa" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#4ec9b0" },
  { tag: [tags.propertyName, tags.attributeName], color: "#9cdcfe" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "#d4d4d4" },
  { tag: tags.regexp, color: "#d16969" },
]);

const baseLightTheme = EditorView.theme({}, { dark: false });
const baseDarkTheme = EditorView.theme({}, { dark: true });

// Force a proportional reading font on the content (CM defaults to monospace
// and its specificity beats a plain .cm-scroller rule). Code is re-monospaced
// by the live-preview .cm-lp-code/.cm-lp-codeblock classes, which win on their
// own spans. Also centers the column reliably via the scroller's flex layout.
const typographyTheme = EditorView.theme({
  ".cm-content": {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    // Set line-height HERE, not in plain CSS: CodeMirror's baseTheme sets
    // .cm-content line-height (1.4) and a .cm-scroller CSS rule loses to it on
    // specificity. EditorView.theme beats the baseTheme, so this actually wins.
    lineHeight: "1.75",
  },
  ".cm-scroller": {
    justifyContent: "center",
  },
});

/**
 * ViewPlugin that decorates matches of the active search query in the visible
 * viewport. @codemirror/search only paints matches while ITS panel is open
 * (which we never open — the app owns ⌘F via the native menu + FindBar), so we
 * roll our own highlighter that reads the live query off the state.
 */
const searchMatchHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      const queryChanged =
        getSearchQuery(update.startState) !== getSearchQuery(update.state);
      if (update.docChanged || update.viewportChanged || update.selectionSet || queryChanged) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const query = getSearchQuery(view.state);
      if (!query.valid) return Decoration.none;
      const sel = view.state.selection.main;
      const deco = [];
      const matchMark = Decoration.mark({ class: "cm-searchMatch" });
      const selectedMark = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });
      for (const { from, to } of view.visibleRanges) {
        const cursor = query.getCursor(view.state.doc, from, to);
        for (let next = cursor.next(); !next.done; next = cursor.next()) {
          const m = next.value;
          if (m.from === m.to) continue; // guard zero-length
          const isSelected = m.from === sel.from && m.to === sel.to;
          deco.push((isSelected ? selectedMark : matchMark).range(m.from, m.to));
        }
      }
      return Decoration.set(deco, true);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * CodeMirror 6 source-mode markdown editor. A single EditorView lives for the
 * lifetime of the controller; load() swaps
 * the document via setState (preserving theme + zoom), and round-trips are
 * byte-faithful (getMarkdown() returns the exact document text).
 */
/** Resolve the URL of a markdown link at `pos`, or null if there isn't one. */
function linkUrlAt(view: EditorView, pos: number): string | null {
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(
    pos,
    1,
  );
  while (node) {
    if (node.name === "Link" || node.name === "Image") {
      let child = node.firstChild;
      while (child) {
        if (child.name === "URL") return view.state.doc.sliceString(child.from, child.to).trim();
        child = child.nextSibling;
      }
      return null;
    }
    node = node.parent;
  }
  return null;
}

export class EditorController {
  private readonly view: EditorView;
  private changeCb: () => void = () => {};
  private linkCb: (url: string) => void = () => {};
  private loading = false;
  private dark = false;
  private fontLevel = 1;

  private readonly themeCompartment = new Compartment();
  private readonly highlightCompartment = new Compartment();
  private readonly fontCompartment = new Compartment();

  constructor(root: string) {
    const parent = document.querySelector(root);
    if (!parent) throw new Error(`Editor mount point not found: ${root}`);
    this.view = new EditorView({
      parent,
      state: this.makeState(""),
    });
  }

  private makeState(content: string): EditorState {
    return EditorState.create({
      doc: content,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Provide the search state field (NOT searchKeymap) so our find bar's
        // findNext/replace commands navigate without CodeMirror bootstrapping
        // its own (ugly) search panel. We never call openSearchPanel.
        search(),
        markdown({ codeLanguages, extensions: [GFM] }),
        EditorView.lineWrapping,
        this.themeCompartment.of(this.dark ? baseDarkTheme : baseLightTheme),
        this.highlightCompartment.of(
          this.dark
            ? syntaxHighlighting(darkHighlightStyle, { fallback: true })
            : syntaxHighlighting(lightHighlightStyle, { fallback: true }),
        ),
        this.fontCompartment.of(this.fontTheme(this.fontLevel)),
        typographyTheme,
        // ⌘/Ctrl-click a link to open it externally (app validates the scheme).
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (!event.metaKey && !event.ctrlKey) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const url = linkUrlAt(view, pos);
            if (!url) return false;
            event.preventDefault();
            this.linkCb(url);
            return true;
          },
        }),
        livePreview(),
        overlayScrollbar,
        // Search highlighter is registered AFTER live-preview so its marks
        // paint on top of the live-preview content styling.
        searchMatchHighlighter,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !this.loading) this.changeCb();
        }),
      ] as Extension[],
    });
  }

  private fontTheme(level: number): Extension {
    return EditorView.theme({ "&": { fontSize: `${16 * level}px` } });
  }

  /** Fired on every user edit (not on programmatic load()). */
  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  /** Fired when the user ⌘/Ctrl-clicks a link; receives the raw URL. */
  onOpenLink(cb: (url: string) => void): void {
    this.linkCb = cb;
  }

  async load(content: string): Promise<void> {
    this.loading = true;
    try {
      // Fresh state: drops undo history (load isn't undoable into the previous
      // file) while makeState re-applies the current theme + zoom compartments.
      this.view.setState(this.makeState(content));
      this.view.dispatch({ selection: { anchor: 0 } });
    } finally {
      this.loading = false;
    }
  }

  getMarkdown(): string {
    return this.view.state.doc.toString();
  }

  /**
   * Record the on-disk path of the current document so the live-preview layer
   * can resolve relative image `src`s against the document's directory. Pass
   * null for unsaved/Untitled docs.
   */
  setDocPath(path: string | null): void {
    setDocPath(path);
    // Force a decoration rebuild so already-rendered images pick up the new
    // base path (a bare setter wouldn't trigger the ViewPlugin's update()).
    this.view.dispatch({ effects: docPathChanged.of(null) });
  }

  setTheme(dark: boolean): void {
    this.dark = dark;
    this.view.dispatch({
      effects: [
        this.themeCompartment.reconfigure(dark ? baseDarkTheme : baseLightTheme),
        this.highlightCompartment.reconfigure(
          dark
            ? syntaxHighlighting(darkHighlightStyle, { fallback: true })
            : syntaxHighlighting(lightHighlightStyle, { fallback: true }),
        ),
      ],
    });
  }

  setZoom(level: number): void {
    this.fontLevel = level;
    this.view.dispatch({
      effects: this.fontCompartment.reconfigure(this.fontTheme(level)),
    });
  }

  // CM6 owns its own undo history; WKWebView's native undo (which the
  // predefined Edit-menu items would trigger) doesn't reach it, so the menu
  // routes Undo/Redo here.
  undo(): void {
    cmUndo(this.view);
    this.view.focus();
  }

  redo(): void {
    cmRedo(this.view);
    this.view.focus();
  }

  // --- Find / Replace (wraps @codemirror/search against the live view) ---

  /**
   * Set the active search query. Returns the match count, or null if the query
   * is empty/invalid.
   */
  setSearch(opts: SearchOptions): number | null {
    const query = new SearchQuery({
      search: opts.query,
      replace: opts.replace,
      caseSensitive: opts.caseSensitive,
      wholeWord: opts.wholeWord ?? false,
      regexp: opts.regexp ?? false,
    });
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (!query.valid) return null;
    let count = 0;
    const cursor = query.getCursor(this.view.state.doc);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      if (next.value.from === next.value.to) continue; // guard zero-length
      count++;
    }
    return count;
  }

  // Find/replace navigation MUST NOT focus the editor: the find bar input keeps
  // focus so the user's next Enter advances the match instead of inserting a
  // newline in the document. The match still scrolls into view (CM scrolls on
  // selection change regardless of focus). Focus returns to the editor only
  // when the bar closes (focusEditor).
  findNext(): void {
    cmFindNext(this.view);
  }

  findPrev(): void {
    cmFindPrevious(this.view);
  }

  replaceNext(): void {
    cmReplaceNext(this.view);
  }

  replaceAll(): void {
    cmReplaceAll(this.view);
  }

  /** Clear the active query so highlights disappear. */
  clearSearch(): void {
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  }

  /** Return focus to the editor (e.g. after the find bar closes). */
  focusEditor(): void {
    this.view.focus();
  }
}
