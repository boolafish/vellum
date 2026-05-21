// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { Table } from "@lezer/markdown";
import { livePreview } from "./live-preview";

/**
 * Regression test for the block-decoration architecture: rendered tables,
 * `$$…$$` block math, and block images are `block: true` decorations, which
 * CodeMirror only permits from editor STATE (a StateField), never from a
 * ViewPlugin. Mounting a real EditorView exercises the layout/measure path that
 * validates this — if those decorations ever leak back into the ViewPlugin, the
 * dispatch below throws "Block decorations may not be specified via plugins".
 */
function mount(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [Table] }), livePreview()],
  });
  return new EditorView({ state, parent: document.body });
}

describe("livePreview block decorations", () => {
  it("renders a table + block math + block image without throwing", () => {
    const doc = `# Doc

| A | B |
| :-- | --: |
| 1 | 2 |
| 3 | 4 |

$$
x^2 + y^2 = z^2
$$

![alt text](image.png)

Some **bold** and \`code\` and inline $a+b$ math and a [link](https://x).
`;
    let view!: EditorView;
    expect(() => {
      view = mount(doc);
      // Move the cursor to the end (outside every block) so all blocks render.
      view.dispatch({ selection: { anchor: doc.length } });
    }).not.toThrow();

    // The block widgets' toDOM runs during measure; assert they rendered.
    const html = view.dom.innerHTML;
    expect(html).toContain("<table");
    expect(html).toContain("katex"); // block math rendered via KaTeX
    expect(html).toContain("<img"); // block image widget

    view.destroy();
  });

  it("reveals source (no block widget) when the cursor is inside a table", () => {
    const doc = `| A | B |
| :-- | --: |
| 1 | 2 |
`;
    let view!: EditorView;
    expect(() => {
      view = mount(doc);
      view.dispatch({ selection: { anchor: 2 } }); // inside the header row
    }).not.toThrow();
    expect(view.dom.innerHTML).not.toContain("<table");
    view.destroy();
  });
});
