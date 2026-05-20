import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

const OPEN_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];
const SAVE_FILTERS = [{ name: "Markdown", extensions: ["md"] }];

/** Show the open dialog. Returns the chosen path, or null if cancelled. */
export async function pickOpenPath(): Promise<string | null> {
  const selected = await open({ multiple: false, filters: OPEN_FILTERS });
  return typeof selected === "string" ? selected : null;
}

/** Show the save dialog. Returns the chosen path, or null if cancelled. */
export async function pickSavePath(defaultPath: string): Promise<string | null> {
  const chosen = await save({ defaultPath, filters: SAVE_FILTERS });
  return chosen ?? null;
}

export function readFile(path: string): Promise<string> {
  return readTextFile(path);
}

export function writeFile(path: string, contents: string): Promise<void> {
  return writeTextFile(path, contents);
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
