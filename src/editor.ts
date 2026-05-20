import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

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
    this.crepe = new Crepe({ root: this.root, defaultValue: content });
    await this.crepe.create();
    // Attached after create() so the initial document load doesn't mark dirty.
    this.crepe.on((listener) => listener.markdownUpdated(() => this.changeCb()));
  }

  getMarkdown(): string {
    return this.crepe?.getMarkdown() ?? "";
  }
}
