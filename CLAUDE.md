# MD Editor

A lightweight, fast, Mac-only Typora-style markdown editor. **Tauri 2** (Rust +
WKWebView) shell, **Milkdown Crepe** WYSIWYG editor, vanilla TypeScript + Vite
frontend. Single-window, document-centric.

## Commands

```bash
npm install
npm run tauri dev      # run the app (Vite + Rust, hot reload)
npm run build          # tsc + vite build (frontend only)
npm test               # vitest unit tests
cargo check --manifest-path src-tauri/Cargo.toml
SMOKE_RUN_SECONDS=8 bash scripts/smoke.sh   # launch + panic/accelerator check
npm run tauri build    # release .app + .dmg (see RELEASE.md)
```

## Architecture

**Frontend (`src/`)** — one mutating action at a time via `App.runExclusive`.
- `app.ts` — top-level controller; owns document state (path/dirty/zoom), routes
  menu actions, the unsaved-changes guard, window-close interception, and OS
  file-opening. `Action.Find` is handled before the busy gate (view-only).
- `editor.ts` — `EditorController` wraps Crepe. Crepe is immutable post-create,
  so `load()` tears down and rebuilds; the ProseMirror view + search plugin are
  recaptured each load. Pins remark-stringify options for stable round-trips.
- `find.ts` — Find/Replace bar driving `prosemirror-search`.
- `dialog.ts` — custom 3-button Save/Don't Save/Cancel sheet (native dialog only
  does 2).
- `theme.ts` — Light/Dark/System; swaps Crepe's frame stylesheet + `data-theme`.
- `ipc.ts` — the Rust↔TS action contract (ids must match `menu.rs`).
- `files.ts` — dialog + fs wrappers.

**Backend (`src-tauri/src/`)**
- `lib.rs` — builder, plugins, command handlers, menu-event routing, the
  `RunEvent::Opened` (Finder "Open With") + `WindowEvent::Destroyed` (quit)
  loop, and `refresh_menu` (rebuilds the menu from recents + theme).
- `menu.rs` — native menu; `build(app, recents, theme)`. Edit menu uses
  predefined items so undo/redo/clipboard hit WKWebView natively.
- `recents.rs` — Open Recent list, persisted to app config dir, pruned for
  missing files.
- `theme.rs` — appearance preference, persisted.

## Conventions & gotchas

- **Menu owns shortcuts** (native accelerators), not webview keydown — avoids
  double-handling. Custom item ids in `menu.rs` must match `Action` in `ipc.ts`.
- **Quit/Close are custom** (not predefined) so they route through the dirty
  guard. Closing the single window quits the app (`Destroyed` → `exit(0)`).
- **`refresh_menu` must not be called while holding a state lock it re-reads**
  (RecentsState/ThemeState) — std Mutex isn't reentrant.
- **No macOS WebDriver** → native-menu/GUI behavior is manual
  (`docs/QA-CHECKLIST.md`); only logic + launch are automated.
- Markdown round-trips through a doc tree, so saving normalizes formatting
  (intentional, pinned in `editor.ts`). The ~1.5MB JS chunk is the Crepe core
  (grammars lazy-split) — fine for a local app.
- Capabilities live in `src-tauri/capabilities/default.json`; app-defined
  commands need no ACL entry, but `core:event`/window perms do.
