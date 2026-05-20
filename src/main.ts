import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./styles.css";

import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DEFAULT_DOC = `# Welcome

Start typing. This is a **Typora-style** WYSIWYG markdown editor.

- Live inline rendering
- \`⌘O\` to open · \`⌘S\` to save · \`⇧⌘S\` save as
- Tables, code blocks, and math included

> Built with Tauri 2 + Milkdown.
`;

const filenameEl = document.querySelector<HTMLSpanElement>("#filename")!;
const dirtyEl = document.querySelector<HTMLSpanElement>("#dirty-dot")!;

let editor: Crepe;
let currentPath: string | null = null;
let dirty = false;

// Crepe instances are immutable after create(), so loading a new document
// means tearing down the editor and building a fresh one.
async function mount(content: string, path: string | null) {
  if (editor) await editor.destroy();
  editor = new Crepe({ root: "#editor", defaultValue: content });
  await editor.create();
  editor.on((listener) => listener.markdownUpdated(() => setDirty(true)));
  currentPath = path;
  setDirty(false);
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function setDirty(value: boolean) {
  dirty = value;
  dirtyEl.classList.toggle("hidden", !value);
  void updateTitle();
}

async function updateTitle() {
  const name = currentPath ? basename(currentPath) : "Untitled";
  filenameEl.textContent = name;
  try {
    await getCurrentWindow().setTitle(`${dirty ? "• " : ""}${name}`);
  } catch {
    /* running outside Tauri (e.g. plain vite preview) */
  }
}

async function openFile() {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
  });
  if (typeof selected !== "string") return;
  const text = await readTextFile(selected);
  await mount(text, selected);
}

async function saveFile(forceDialog = false) {
  let path = currentPath;
  if (!path || forceDialog) {
    const chosen = await save({
      defaultPath: path ?? "Untitled.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!chosen) return;
    path = chosen;
  }
  await writeTextFile(path, editor.getMarkdown());
  currentPath = path;
  setDirty(false);
}

window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "o") {
    e.preventDefault();
    void openFile();
  } else if (e.key === "s") {
    e.preventDefault();
    void saveFile(e.shiftKey);
  }
});

await mount(DEFAULT_DOC, null);
