# Vellum

A lightweight, fast, Mac-only Markdown editor. **Tauri 2** (Rust +
WKWebView) shell, **CodeMirror 6** editor (source mode: syntax-highlighted
markdown), vanilla TypeScript + Vite frontend. Single-window, document-centric.

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
- `editor.ts` — `EditorController` wraps a single CodeMirror 6 `EditorView`.
  `load()` swaps the document via `setState` (preserving theme + zoom
  compartments, dropping undo history). Round-trips are byte-faithful —
  `getMarkdown()` returns the exact document text. Theme/zoom live in
  `Compartment`s; a custom ViewPlugin paints search-match highlights (CM's
  built-in highlighter only paints while its panel is open, which we never use).
- `live-preview.ts` — Typora/Obsidian-style WYSIWYG layer over the CM6 source.
  Content styling is ALWAYS applied (headings big, bold bold) via
  `Decoration.mark`/`.line`; only the markdown MARKERS are concealed
  (`Decoration.replace`) UNLESS their line is selection-touched ("active"), then
  raw source shows. Inline constructs + viewport-bounded math live in a
  ViewPlugin; layout-affecting BLOCK widgets (tables, block `$$…$$`, block
  images) must come from editor state, so they live in a `StateField`. KaTeX
  (lazy-loaded on first math render) handles `$…$`/`$$…$$`.
- `find.ts` — Find/Replace bar driving `@codemirror/search` via EditorController.
- `dialog.ts` — custom 3-button Save/Don't Save/Cancel sheet (native dialog only
  does 2).
- `theme.ts` — Light/Dark/System; sets `data-theme` for the chrome and calls
  `editor.setTheme(dark)` to reconfigure CM's theme + syntax highlighting.
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
- Markdown round-trips are byte-faithful: the editor edits source text directly,
  so saving writes back exactly what's in the buffer (no normalization).
- Live-preview marker-hiding (Typora-style WYSIWYG) is **implemented** in
  `live-preview.ts` and layered on top of the syntax-highlighted source. Reveal
  is per-active-line (and per-construct for inline marks); block widgets reveal
  whenever the selection touches any of their lines.
- Capabilities live in `src-tauri/capabilities/default.json`; app-defined
  commands need no ACL entry, but `core:event`/window perms do.
