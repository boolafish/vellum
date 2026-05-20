import { Crepe } from "@milkdown/crepe";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
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
export class EditorController {
  private crepe: Crepe | null = null;
  private changeCb: () => void = () => {};

  constructor(private readonly root: string) {}

  /** Fired on every user edit (not on programmatic load()). */
  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  async load(content: string): Promise<void> {
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
    await crepe.create();
    // Attached after create() so the initial document load doesn't mark dirty.
    crepe.on((listener) => listener.markdownUpdated(() => this.changeCb()));
    this.crepe = crepe;
  }

  getMarkdown(): string {
    return this.crepe?.getMarkdown() ?? "";
  }
}
