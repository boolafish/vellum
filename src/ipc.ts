// Shared contract between the native (Rust) menu and the frontend.
// Rust emits MENU_EVENT with an Action string payload; app.ts dispatches it.
// Keep these ids in sync with src-tauri/src/menu.rs.

export const Action = {
  New: "new",
  Open: "open",
  Save: "save",
  SaveAs: "save-as",
  Close: "close",
  Quit: "quit",
  Find: "find",
  ZoomIn: "zoom-in",
  ZoomOut: "zoom-out",
  ZoomReset: "zoom-reset",
} as const;

export type Action = (typeof Action)[keyof typeof Action];

/** Event name Rust emits when a custom menu item is selected. Payload: Action. */
export const MENU_EVENT = "menu:action";

/** Event Rust emits with a file path to open (Finder "Open With", drag-on-dock). */
export const OPEN_FILE_EVENT = "open-path";

const ACTION_VALUES = new Set<string>(Object.values(Action));

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && ACTION_VALUES.has(value);
}
