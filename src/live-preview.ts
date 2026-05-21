import {
  type Extension,
  type Range,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from "@codemirror/state";
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
import { convertFileSrc } from "@tauri-apps/api/core";
import katex from "katex";

/**
 * Path of the currently-open document, used to resolve RELATIVE image `src`s
 * against the document's directory. Wired from app.ts via
 * EditorController.setDocPath(). A module variable (not a StateField) keeps the
 * decoration builder simple; setDocPath dispatches `docPathChanged` to force a
 * rebuild so already-rendered images update.
 */
let currentDocPath: string | null = null;
export function setDocPath(path: string | null): void {
  currentDocPath = path;
}
/** Dispatched by setDocPath to make the ViewPlugin rebuild decorations. */
export const docPathChanged = StateEffect.define<null>();

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

/** Renders a markdown thematic break (`---`) as a horizontal divider line. */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-hr-line";
    return span;
  }
}

/** Resolve an image `src` to a URL the webview can load.
 *  - http(s) / data: → used as-is
 *  - absolute / relative local paths → Tauri asset protocol (convertFileSrc),
 *    relative paths resolved against the current document's directory.
 *  Falls back to the raw src if no doc path is available or resolution fails. */
function resolveImageSrc(src: string): string {
  const trimmed = src.trim();
  if (/^(https?:|data:)/i.test(trimmed)) return trimmed;
  try {
    let abs = trimmed;
    if (!trimmed.startsWith("/")) {
      // Relative: resolve against the document's directory.
      if (!currentDocPath) return trimmed; // unknown base; let <img> try & fail
      const dir = currentDocPath.replace(/[/\\][^/\\]*$/, "");
      abs = `${dir}/${trimmed}`;
    }
    return convertFileSrc(abs);
  } catch {
    return trimmed;
  }
}

/** Renders a GFM table block as a real <table>, honoring column alignment. */
type Align = "left" | "center" | "right" | "";
class TableWidget extends WidgetType {
  constructor(private readonly src: string) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.src === this.src;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table-wrap";
    const lines = this.src.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      wrap.textContent = this.src;
      return wrap;
    }
    const headerCells = splitRow(lines[0]);
    const aligns = lines.length > 1 ? parseAligns(lines[1]) : [];
    const bodyRows = lines.slice(2).map(splitRow);

    const table = document.createElement("table");
    table.className = "cm-lp-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    headerCells.forEach((cell, i) => {
      const th = document.createElement("th");
      th.textContent = cell;
      const a = aligns[i];
      if (a) th.style.textAlign = a;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of bodyRows) {
      const tr = document.createElement("tr");
      // Pad/truncate to header column count.
      for (let i = 0; i < headerCells.length; i++) {
        const td = document.createElement("td");
        td.textContent = row[i] ?? "";
        const a = aligns[i];
        if (a) td.style.textAlign = a;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** Split a GFM table row into trimmed cell strings, dropping leading/trailing
 *  pipes. Escaped `\|` is treated as a literal pipe within a cell. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // Drop empty leading/trailing cells produced by the bounding pipes.
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Parse alignment from the delimiter row (`:--` left, `:--:` center, `--:` right). */
function parseAligns(line: string): Align[] {
  return splitRow(line).map((c): Align => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

/** Parse an `Image` syntax node into src/alt and whether it stands alone on
 *  its line (→ block). Returns null for a malformed image (no URL). */
function parseImage(
  node: SyntaxNodeRef,
  doc: EditorState["doc"],
): { src: string; alt: string; block: boolean } | null {
  let alt = "";
  let src = "";
  const marks: { from: number; to: number }[] = [];
  let c = node.node.firstChild;
  while (c) {
    if (c.name === "LinkMark") marks.push({ from: c.from, to: c.to });
    if (c.name === "URL") src = doc.sliceString(c.from, c.to);
    c = c.nextSibling;
  }
  if (marks.length >= 2 && marks[1].from > marks[0].to) {
    alt = doc.sliceString(marks[0].to, marks[1].from);
  }
  if (!src) return null;
  const line = doc.lineAt(node.from);
  const block = line.from === node.from && line.to === node.to;
  return { src, alt, block };
}

/** Renders a markdown image as an <img> (block or inline variant via class). */
class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly block: boolean,
    private readonly docPath: string | null,
  ) {
    super();
  }
  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.block === this.block &&
      other.docPath === this.docPath
    );
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement(this.block ? "div" : "span");
    wrap.className = this.block ? "cm-lp-img-block" : "cm-lp-img-inline";
    const img = document.createElement("img");
    img.src = resolveImageSrc(this.src);
    img.alt = this.alt;
    img.className = "cm-lp-img";
    img.onerror = () => {
      // Graceful fallback: replace the broken image with its alt text.
      const fallback = document.createElement("span");
      fallback.className = "cm-lp-img-fallback";
      fallback.textContent = this.alt || this.src;
      wrap.replaceChildren(fallback);
    };
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** Renders inline `$...$` or block `$$...$$` math via KaTeX. On any KaTeX error
 *  it shows the raw source so a single bad formula can't break the build. */
class MathWidget extends WidgetType {
  constructor(
    private readonly tex: string,
    private readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM(): HTMLElement {
    const span = document.createElement(this.display ? "div" : "span");
    span.className = this.display ? "cm-lp-math-block" : "cm-lp-math-inline";
    try {
      span.innerHTML = katex.renderToString(this.tex, {
        throwOnError: false,
        displayMode: this.display,
      });
    } catch {
      span.className = "cm-lp-math-error";
      span.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
    }
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** Small language label shown in the corner of a code block (replaces the
 *  closing ``` fence line when the block isn't being edited). */
class LangBadgeWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: LangBadgeWidget): boolean {
    return other.lang === this.lang;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-lang";
    span.textContent = this.lang;
    return span;
  }
}

const concealMark = Decoration.replace({});
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });
const ruleDeco = Decoration.replace({ widget: new RuleWidget() });

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

/** True if `pos` falls inside an inline-code / code-text / fenced-code node, in
 *  which case a `$` there must NOT be treated as a math delimiter. */
function inCode(tree: ReturnType<typeof syntaxTree>, pos: number): boolean {
  let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 0);
  while (n) {
    const nm = n.name;
    if (nm === "InlineCode" || nm === "CodeText" || nm === "FencedCode" || nm === "CodeBlock") {
      return true;
    }
    n = n.parent;
  }
  return false;
}

/**
 * Scan visible ranges for `$$...$$` (block) and `$...$` (inline) math and emit
 * widgets when their line(s) are inactive. Conservative inline rule (KaTeX/
 * markdown convention): the `$` opening must not be followed by whitespace, the
 * closing `$` must not be preceded by whitespace, and a `$` adjacent to a digit
 * is treated as currency (skipped) — so "$5 and $10" is left alone.
 */
function buildMath(
  view: EditorView,
  tree: ReturnType<typeof syntaxTree>,
  deco: Range<Decoration>[],
  atomic: Range<Decoration>[],
  lineActive: (pos: number) => boolean,
  rangeActive: (from: number, to: number) => boolean,
): void {
  const doc = view.state.doc;
  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    const text = doc.sliceString(vFrom, vTo);
    let i = 0;
    while (i < text.length) {
      if (text[i] !== "$") {
        i++;
        continue;
      }
      const absStart = vFrom + i;
      if (inCode(tree, absStart)) {
        i++;
        continue;
      }
      // Block math: $$ ... $$ (may span lines).
      if (text[i + 1] === "$") {
        const close = text.indexOf("$$", i + 2);
        if (close !== -1) {
          const absEnd = vFrom + close + 2;
          const tex = text.slice(i + 2, close).trim();
          if (tex.length > 0 && !inCode(tree, vFrom + close)) {
            const sameLine = doc.lineAt(absStart).number === doc.lineAt(absEnd).number;
            // Single-line `$$…$$` is a non-block replace and is safe to emit
            // from the ViewPlugin. MULTI-LINE `$$…$$` is a block decoration and
            // is owned by the StateField (buildBlockDecorations) — we only skip
            // past it here so its inner `$` aren't mis-parsed as inline math.
            if (
              sameLine &&
              !rangeActive(absStart, absEnd) &&
              !overlapsSelection(view, absStart, absEnd)
            ) {
              const w = Decoration.replace({
                widget: new MathWidget(tex, false),
              }).range(absStart, absEnd);
              deco.push(w);
              atomic.push(w);
            }
            i = close + 2;
            continue;
          }
        }
        i += 2;
        continue;
      }
      // Inline math: $ ... $ on a single line.
      const nextOpen = text[i + 1];
      // Opening `$` must be followed by a non-space, non-digit char.
      if (nextOpen === undefined || /\s/.test(nextOpen) || /\d/.test(nextOpen)) {
        i++;
        continue;
      }
      // Find a closing `$` on the same line.
      let j = i + 1;
      let found = -1;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "$") {
          const prev = text[j - 1];
          // Closing `$` must not be preceded by whitespace and not followed by
          // a digit (currency guard).
          const after = text[j + 1];
          if (!/\s/.test(prev) && !(after !== undefined && /\d/.test(after))) {
            found = j;
            break;
          }
        }
        j++;
      }
      if (found !== -1 && !inCode(tree, vFrom + found)) {
        const absEnd = vFrom + found + 1;
        const tex = text.slice(i + 1, found);
        if (!lineActive(absStart) && !overlapsSelection(view, absStart, absEnd)) {
          const w = Decoration.replace({
            widget: new MathWidget(tex, false),
          }).range(absStart, absEnd);
          deco.push(w);
          atomic.push(w);
        }
        i = found + 1;
        continue;
      }
      i++;
    }
  }
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

  /** True if any line in [from,to] is active (selection-touched). Used for
   *  multi-line block widgets (tables, block math) which must reveal source
   *  whenever the cursor is anywhere inside them. */
  const rangeActive = (from: number, to: number) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (activeLines.has(n)) return true;
    return false;
  };

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

  // Conceal the delimiter marks of an inline construct UNLESS the selection
  // touches that construct's own range (Typora-style: reveal `**` only when the
  // cursor is in/at that bold span, not anywhere on the line). `markNames` are
  // the delimiter child node names to hide.
  const concealInlineMarks = (
    node: SyntaxNodeRef,
    markNames: ReadonlySet<string>,
  ): void => {
    if (overlapsSelection(view, node.from, node.to)) return; // cursor in span: show source
    let child = node.node.firstChild;
    while (child) {
      if (markNames.has(child.name) && child.to > child.from) {
        const r = concealMark.range(child.from, child.to);
        deco.push(r);
        atomic.push(r);
      }
      child = child.nextSibling;
    }
  };

  const EMPHASIS_MARKS = new Set(["EmphasisMark", "StrikethroughMark"]);
  const CODE_MARKS = new Set(["CodeMark"]);

  const tree = syntaxTree(state);

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    tree.iterate({
      from: vFrom,
      to: vTo,
      enter: (node: SyntaxNodeRef): boolean | void => {
        const name = node.name;

        // --- GFM table: the rendered <table> is a BLOCK widget, owned by the
        // StateField (buildBlockDecorations). Here we only avoid double-
        // decoration: when the table is INACTIVE the field replaces the whole
        // range, so skip its subtree; when ACTIVE, descend so inline
        // decorations inside cells still apply. ---
        if (name === "Table") {
          if (!rangeActive(node.from, node.to) && !overlapsSelection(view, node.from, node.to)) {
            return false;
          }
          return;
        }

        // --- Image: INLINE images (not alone on their line) render here as a
        // non-block replace widget. BLOCK images (alone on the line) are owned
        // by the StateField; we skip them so they aren't double-decorated. ---
        if (name === "Image") {
          if (lineActive(node.from) || overlapsSelection(view, node.from, node.to)) return;
          const img = parseImage(node, doc);
          if (!img) return; // malformed; leave source
          if (img.block) return false; // block image: StateField owns it
          const w = Decoration.replace({
            widget: new ImageWidget(img.src, img.alt, false, currentDocPath),
          }).range(node.from, node.to);
          deco.push(w);
          atomic.push(w);
          return false;
        }

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

        // --- Strong / Emphasis / Strikethrough: style content; conceal the
        // delimiter marks unless the cursor is within THIS span (per-construct
        // reveal, not whole-line). ---
        if (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough") {
          const cls =
            name === "StrongEmphasis"
              ? "cm-lp-strong"
              : name === "Emphasis"
                ? "cm-lp-em"
                : "cm-lp-strike";
          deco.push(Decoration.mark({ class: cls }).range(node.from, node.to));
          concealInlineMarks(node, EMPHASIS_MARKS);
          return;
        }

        // --- Inline code: chip style on content; conceal backticks unless the
        // cursor is within this code span. ---
        if (name === "InlineCode") {
          deco.push(Decoration.mark({ class: "cm-lp-code" }).range(node.from, node.to));
          concealInlineMarks(node, CODE_MARKS);
          return;
        }

        // --- Links: style text, conceal `[` `]` `(url)` unless cursor in link ---
        if (name === "Link") {
          // Style the visible link text (between the first `[` and `]`).
          let firstMarkEnd = -1;
          let secondMarkStart = -1;
          let secondMarkEnd = -1;
          const urlEnd = node.to;
          let c = node.node.firstChild;
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
          // Per-construct reveal: conceal the brackets/URL unless the cursor is
          // within the link itself. Conceal unconditionally here (gate already
          // checked) rather than via the line-based `conceal`.
          if (!overlapsSelection(view, node.from, node.to)) {
            const hide = (from: number, to: number) => {
              if (to <= from) return;
              const r = concealMark.range(from, to);
              deco.push(r);
              atomic.push(r);
            };
            if (marks.length >= 1) hide(marks[0].from, marks[0].to); // `[`
            if (marks.length >= 2) hide(secondMarkStart, Math.min(secondMarkEnd, urlEnd)); // `]…)`
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

        // --- Fenced code: monospace card. When the block isn't being edited,
        // hide the ``` fence lines and show the language as a corner badge
        // (Typora-style); reveal the raw fences when the cursor is inside. ---
        if (name === "FencedCode") {
          const startLine = doc.lineAt(node.from).number;
          const endLine = doc.lineAt(node.to).number;
          let active = false;
          for (let n = startLine; n <= endLine; n++) {
            if (activeLines.has(n)) {
              active = true;
              break;
            }
          }
          let lang = "";
          let cc = node.node.firstChild;
          while (cc) {
            if (cc.name === "CodeInfo") lang = doc.sliceString(cc.from, cc.to).trim();
            cc = cc.nextSibling;
          }
          for (let n = startLine; n <= endLine; n++) {
            const ln = doc.line(n);
            let cls = "cm-lp-codeblock";
            if (n === startLine) cls += " cm-lp-codeblock-first";
            if (n === endLine) cls += " cm-lp-codeblock-last";
            deco.push(Decoration.line({ class: cls }).range(ln.from));
          }
          if (!active) {
            // Conceal the opening fence line; the closing fence line shows the
            // language badge (bottom-right) or is concealed if no language.
            const openLine = doc.line(startLine);
            const o = concealMark.range(openLine.from, openLine.to);
            deco.push(o);
            atomic.push(o);
            if (endLine > startLine) {
              const closeLine = doc.line(endLine);
              const close = lang
                ? Decoration.replace({ widget: new LangBadgeWidget(lang) }).range(
                    closeLine.from,
                    closeLine.to,
                  )
                : concealMark.range(closeLine.from, closeLine.to);
              deco.push(close);
              atomic.push(close);
            }
          }
          return;
        }

        // --- Horizontal rule: render as a divider when inactive ---
        if (name === "HorizontalRule") {
          const line = doc.lineAt(node.from);
          if (!activeLines.has(line.number) && !overlapsSelection(view, line.from, line.to)) {
            const r = ruleDeco.range(line.from, line.to);
            deco.push(r);
            atomic.push(r);
          } else {
            deco.push(Decoration.line({ class: "cm-lp-hr" }).range(line.from));
          }
          return;
        }
      },
    });
  }

  // --- Math ($...$ inline, $$...$$ block) — not in the markdown grammar, so
  // scan the visible text directly. Skip any `$` that sits inside code so code
  // snippets containing `$` aren't mangled. ---
  buildMath(view, tree, deco, atomic, lineActive, rangeActive);

  // Decorations must be sorted by `from`, and line/replace ordering matters.
  return { deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

/**
 * Build the BLOCK-level decorations: rendered tables, block (`$$…$$`) math, and
 * block images (an image alone on its line). These are `block: true` /
 * across-line-break `replace` decorations, which CodeMirror only permits from
 * editor STATE — never from a ViewPlugin — because they affect vertical layout.
 * So they live in a StateField and scan the WHOLE syntax tree (these nodes are
 * sparse, so a full scan per update is cheap). Reveal-on-active still works
 * because we recompute on selection change and skip any block whose lines are
 * touched by the selection.
 */
function buildBlockDecorations(state: EditorState): {
  deco: DecorationSet;
  atomic: DecorationSet;
} {
  const doc = state.doc;
  const deco: Range<Decoration>[] = [];

  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) activeLines.add(n);
  }
  const rangeActive = (from: number, to: number) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (activeLines.has(n)) return true;
    return false;
  };
  const selOverlaps = (from: number, to: number) => {
    for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
    return false;
  };

  const tree = syntaxTree(state);

  tree.iterate({
    enter: (node: SyntaxNodeRef): boolean | void => {
      const name = node.name;

      // GFM table → block <table> widget.
      if (name === "Table") {
        if (!rangeActive(node.from, node.to) && !selOverlaps(node.from, node.to)) {
          const src = doc.sliceString(node.from, node.to);
          deco.push(
            Decoration.replace({ widget: new TableWidget(src), block: true }).range(
              node.from,
              node.to,
            ),
          );
        }
        return false; // never descend; inline plugin handles the active case
      }

      // Block image (alone on its line) → block <img> widget.
      if (name === "Image") {
        if (rangeActive(node.from, node.to) || selOverlaps(node.from, node.to)) return;
        const img = parseImage(node, doc);
        if (!img || !img.block) return; // inline images are owned by the plugin
        deco.push(
          Decoration.replace({
            widget: new ImageWidget(img.src, img.alt, true, currentDocPath),
            block: true,
          }).range(node.from, node.to),
        );
        return false;
      }
    },
  });

  // Block math ($$…$$ spanning >1 line) — not in the grammar, scan the doc.
  scanBlockMath(state, tree, deco, rangeActive, selOverlaps);

  const set = Decoration.set(deco, true);
  // Block-replace decorations must be atomic so the caret steps over them.
  return { deco: set, atomic: set };
}

/** Scan the whole document for MULTI-LINE `$$…$$` math blocks (single-line
 *  `$$…$$` is handled inline by the ViewPlugin). Skips `$` inside code. */
function scanBlockMath(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree>,
  deco: Range<Decoration>[],
  rangeActive: (from: number, to: number) => boolean,
  selOverlaps: (from: number, to: number) => boolean,
): void {
  const doc = state.doc;
  const text = doc.toString();
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "$" && !inCode(tree, i)) {
      const close = text.indexOf("$$", i + 2);
      if (close === -1) break;
      const tex = text.slice(i + 2, close).trim();
      const absEnd = close + 2;
      if (tex.length > 0 && !inCode(tree, close)) {
        const multiLine = doc.lineAt(i).number !== doc.lineAt(absEnd).number;
        if (multiLine && !rangeActive(i, absEnd) && !selOverlaps(i, absEnd)) {
          deco.push(
            Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(
              i,
              absEnd,
            ),
          );
        }
        i = close + 2;
        continue;
      }
    }
    i++;
  }
}

const blockField = StateField.define<{ deco: DecorationSet; atomic: DecorationSet }>({
  create(state) {
    return buildBlockDecorations(state);
  },
  update(value, tr: Transaction) {
    // Recompute on doc change OR selection change (reveal-on-active), and when
    // the document path changes (image src resolution depends on it).
    const docPathFx = tr.effects.some((e) => e.is(docPathChanged));
    if (tr.docChanged || tr.selection || docPathFx) {
      return buildBlockDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

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
      const docPathFx = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(docPathChanged)),
      );
      if (update.docChanged || update.viewportChanged || update.selectionSet || docPathFx) {
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
  // Order: block field first so its layout-affecting decorations are
  // established, then the viewport-bounded inline plugin on top.
  return [blockField, livePreviewPlugin, livePreviewTheme];
}
