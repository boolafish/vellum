import { type Extension, type Range } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";

/**
 * Typora/Obsidian-style "live preview" layer for the CM6 markdown editor.
 *
 * The model: content styling is ALWAYS applied (a heading is always big, bold
 * is always bold) via `Decoration.mark`/`Decoration.line`; only the markdown
 * MARKERS are conditionally hidden. A marker is concealed with a zero-width
 * `Decoration.replace` UNLESS its line is "active" (touched by a selection
 * range) — then the raw source is shown so editing is unambiguous.
 *
 * Decorations are rebuilt on doc/viewport/selection change and walked over the
 * visible ranges only via `syntaxTree`, so large documents stay fast.
 */

/** A marker range that overlaps any selection range is never concealed —
 * concealing under the caret would fight the cursor. */
function overlapsSelection(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/** Bullet widget: renders an inactive `-`/`*`/`+` list marker as a bullet. */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const concealMark = Decoration.replace({});
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });

const HEADING_LINE = [
  "cm-lp-h1",
  "cm-lp-h2",
  "cm-lp-h3",
  "cm-lp-h4",
  "cm-lp-h5",
  "cm-lp-h6",
];

interface LivePreviewDecos {
  /** All decorations (styling marks, line classes, and concealed markers). */
  deco: DecorationSet;
  /** Only the concealed/replaced markers — these alone should be atomic for
   *  cursor motion. Styling marks must NOT be atomic or the caret couldn't
   *  enter bold/link/code text. */
  atomic: DecorationSet;
}

function buildDecorations(view: EditorView): LivePreviewDecos {
  const deco: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const { state } = view;
  const doc = state.doc;

  // Active lines = every line touched by any selection range.
  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const fromLine = doc.lineAt(r.from).number;
    const toLine = doc.lineAt(r.to).number;
    for (let n = fromLine; n <= toLine; n++) activeLines.add(n);
  }
  const lineActive = (pos: number) => activeLines.has(doc.lineAt(pos).number);

  // A construct's line(s) are active -> reveal (skip concealing). Helper for
  // single-position constructs.
  const conceal = (from: number, to: number) => {
    if (from >= to) return;
    if (lineActive(from)) return;
    if (overlapsSelection(view, from, to)) return;
    const r = concealMark.range(from, to);
    deco.push(r);
    atomic.push(r);
  };

  const tree = syntaxTree(state);

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    tree.iterate({
      from: vFrom,
      to: vTo,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name;

        // --- ATX headings: h1..h6 ---
        const hMatch = /^ATXHeading([1-6])$/.exec(name);
        if (hMatch) {
          const level = Number(hMatch[1]);
          const line = doc.lineAt(node.from);
          // Line-level size class is ALWAYS applied.
          deco.push(
            Decoration.line({ class: HEADING_LINE[level - 1] }).range(line.from),
          );
          // Conceal the `#`s + the single trailing space after them.
          const child = node.node.firstChild;
          if (child && child.name === "HeaderMark") {
            // include one trailing space if present
            let markTo = child.to;
            if (doc.sliceString(markTo, markTo + 1) === " ") markTo += 1;
            conceal(child.from, markTo);
          }
          return;
        }

        // --- Strong / Emphasis / Strikethrough: style content, conceal marks ---
        if (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough") {
          const cls =
            name === "StrongEmphasis"
              ? "cm-lp-strong"
              : name === "Emphasis"
                ? "cm-lp-em"
                : "cm-lp-strike";
          deco.push(Decoration.mark({ class: cls }).range(node.from, node.to));
          return;
        }
        if (name === "EmphasisMark" || name === "StrikethroughMark") {
          conceal(node.from, node.to);
          return;
        }

        // --- Inline code: chip style on content, conceal backticks ---
        if (name === "InlineCode") {
          deco.push(Decoration.mark({ class: "cm-lp-code" }).range(node.from, node.to));
          return;
        }
        if (name === "CodeMark") {
          conceal(node.from, node.to);
          return;
        }

        // --- Links: style text, conceal `[` `]` `(url)` ---
        if (name === "Link") {
          const lineActiveHere = lineActive(node.from);
          // Style the visible link text (between the first `[` and `]`).
          let firstMarkEnd = -1;
          let secondMarkStart = -1;
          let secondMarkEnd = -1;
          let urlEnd = node.to;
          const child = node.node.firstChild;
          let c = child;
          const marks: { from: number; to: number }[] = [];
          while (c) {
            if (c.name === "LinkMark") marks.push({ from: c.from, to: c.to });
            c = c.nextSibling;
          }
          // Expected marks: `[`  `]`  `(`  `)`  (4 marks for inline links).
          if (marks.length >= 2) {
            firstMarkEnd = marks[0].to; // after `[`
            secondMarkStart = marks[1].from; // the `]`
            secondMarkEnd = marks[marks.length - 1].to; // closing `)`
          }
          if (firstMarkEnd >= 0 && secondMarkStart > firstMarkEnd) {
            deco.push(
              Decoration.mark({ class: "cm-lp-link" }).range(firstMarkEnd, secondMarkStart),
            );
          }
          if (!lineActiveHere && !overlapsSelection(view, node.from, node.to)) {
            // Conceal `[`
            if (marks.length >= 1) conceal(marks[0].from, marks[0].to);
            // Conceal everything from `]` through the closing `)` (incl. URL).
            if (marks.length >= 2) conceal(secondMarkStart, secondMarkEnd > urlEnd ? urlEnd : secondMarkEnd);
          }
          return;
        }

        // --- List item line: enables inter-item spacing + hanging indent so
        // wrapped continuation text aligns under the item text (not the margin).
        if (name === "ListItem") {
          const line = doc.lineAt(node.from);
          deco.push(Decoration.line({ class: "cm-lp-li" }).range(line.from));
          return;
        }

        // --- List markers ---
        if (name === "ListMark") {
          const text = doc.sliceString(node.from, node.to);
          deco.push(
            Decoration.mark({ class: "cm-lp-listmark" }).range(node.from, node.to),
          );
          // Render unordered bullets as • when inactive.
          if (
            (text === "-" || text === "*" || text === "+") &&
            !lineActive(node.from) &&
            !overlapsSelection(view, node.from, node.to)
          ) {
            const b = bulletDeco.range(node.from, node.to);
            deco.push(b);
            atomic.push(b);
          }
          return;
        }

        // --- Blockquote: left bar + dimmed; conceal `>` when inactive ---
        if (name === "Blockquote") {
          // Apply a line decoration to every line of the blockquote for the bar.
          const startLine = doc.lineAt(node.from).number;
          const endLine = doc.lineAt(node.to).number;
          for (let n = startLine; n <= endLine; n++) {
            const ln = doc.line(n);
            deco.push(Decoration.line({ class: "cm-lp-quote" }).range(ln.from));
          }
          return;
        }
        if (name === "QuoteMark") {
          // dim + conceal the `>` (and following space) when inactive
          let markTo = node.to;
          if (doc.sliceString(markTo, markTo + 1) === " ") markTo += 1;
          conceal(node.from, markTo);
          return;
        }

        // --- Fenced code: monospace block; round the first/last lines so it
        // reads as one padded card (Typora-style) rather than a flat band. ---
        if (name === "FencedCode") {
          const startLine = doc.lineAt(node.from).number;
          const endLine = doc.lineAt(node.to).number;
          for (let n = startLine; n <= endLine; n++) {
            const ln = doc.line(n);
            let cls = "cm-lp-codeblock";
            if (n === startLine) cls += " cm-lp-codeblock-first";
            if (n === endLine) cls += " cm-lp-codeblock-last";
            deco.push(Decoration.line({ class: cls }).range(ln.from));
          }
          return;
        }

        // --- Horizontal rule: style the line ---
        if (name === "HorizontalRule") {
          const line = doc.lineAt(node.from);
          deco.push(Decoration.line({ class: "cm-lp-hr" }).range(line.from));
          return;
        }
      },
    });
  }

  // Decorations must be sorted by `from`, and line/replace ordering matters.
  return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;
    constructor(view: EditorView) {
      const built = buildDecorations(view);
      this.decorations = built.deco;
      this.atomic = built.atomic;
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        const built = buildDecorations(update.view);
        this.decorations = built.deco;
        this.atomic = built.atomic;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Only the concealed markers are atomic, so the caret steps over hidden
    // markers cleanly while still being able to enter styled (bold/link) text.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
);

/** Base theme for the live-preview layer (sizes/weights/colors). Uses the same
 * palette spirit as the chrome; light/dark are handled via CSS vars in
 * styles.css for the structural pieces, while font sizing lives here. */
const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-h1": { fontSize: "1.9em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h2": { fontSize: "1.6em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h3": { fontSize: "1.35em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h4": { fontSize: "1.18em", fontWeight: "700", lineHeight: "1.35" },
  ".cm-lp-h5": { fontSize: "1.05em", fontWeight: "700", lineHeight: "1.4" },
  ".cm-lp-h6": { fontSize: "1em", fontWeight: "700" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through" },
});

export function livePreview(): Extension {
  return [livePreviewPlugin, livePreviewTheme];
}
