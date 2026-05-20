# Manual QA Checklist — MD Editor (macOS)

Tauri's WebDriver layer (`tauri-driver`) has **no macOS WKWebView driver**, so the
native menu bar, OS keyboard shortcuts, window chrome, and theme switching cannot
be exercised by an automated GUI harness on this platform. The items below must be
verified by hand. Automatable layers are covered by `npm test` (Vitest) and
`scripts/smoke.sh` (launch smoke test) instead.

How to run a manual pass:

```
npm run tauri dev      # or open a release build
```

Legend: **[now]** = implemented on current HEAD · **[later]** = planned for a
future phase, expected to be inert/disabled today.

---

## File menu

| Item | Shortcut | Expected | Status |
| --- | --- | --- | --- |
| New | ⌘N | Clears the editor to an empty doc; filename → "Untitled"; dirty dot off. | [now] |
| Open… | ⌘O | Opens native file dialog (md/markdown/txt); chosen file loads; title shows its name; not dirty. | [now] |
| Save | ⌘S | If no path yet, prompts Save dialog (default `Untitled.md`); otherwise writes silently. Dirty dot clears after save. | [now] |
| Save As… | ⇧⌘S | Always prompts the Save dialog; writes to the new path and adopts it as current. | [now] |
| Close | ⌘W | Closes the current window. (Dirty-guard / "save before closing?" prompt is **[later]**, Phase 2 — today it closes without warning.) | [now] (no guard) |

- [ ] Cancelling the Open dialog leaves the current document untouched.
- [ ] Cancelling the Save / Save As dialog does NOT clear the dirty dot.
- [ ] Save on a never-saved doc routes through the Save As dialog.

## Edit menu (native WKWebView actions)

These use Tauri predefined items and act on the focused webview; they do **not**
emit a custom action.

| Item | Shortcut | Expected | Status |
| --- | --- | --- | --- |
| Undo | ⌘Z | Reverts last edit in the editor. | [now] |
| Redo | ⇧⌘Z | Re-applies the undone edit. | [now] |
| Cut | ⌘X | Removes selection to clipboard. | [now] |
| Copy | ⌘C | Copies selection. | [now] |
| Paste | ⌘V | Inserts clipboard text. | [now] |
| Select All | ⌘A | Selects whole document. | [now] |
| Find… | ⌘F | **Disabled** menu entry; does nothing. | [later] (Phase 7) |

- [ ] Undo/redo behave against the Milkdown editor, not the OS-level field only.
- [ ] Find… appears greyed out and ⌘F is a no-op.

## View menu (zoom)

| Item | Shortcut | Expected | Status |
| --- | --- | --- | --- |
| Zoom In | ⌘= | Editor content scales up by 0.1, capped at 2.5×. | [now] |
| Zoom Out | ⌘- | Editor content scales down by 0.1, floored at 0.5×. | [now] |
| Actual Size | ⌘0 | Resets zoom to 1.0×. | [now] |

- [ ] Repeated Zoom In stops at 2.5× (does not grow unbounded).
- [ ] Repeated Zoom Out stops at 0.5×.
- [ ] Zoom affects the editor content only, not the title bar / menu.

## Dirty-dot behavior

- [ ] Fresh load (default doc / New / Open / after Save) shows **no** dirty dot.
- [ ] Typing/editing turns the dirty dot **on**.
- [ ] Programmatic `load()` (New/Open) does **not** mark dirty (listener attaches after create).
- [ ] Successful Save / Save As clears the dirty dot.
- [ ] Cancelled Save keeps the dirty dot on.

## Title bar / filename

- [ ] Title bar shows the current filename (basename), or "Untitled" before first save.
- [ ] Dirty state prefixes the OS window title with "• ".
- [ ] In-window `#filename` element matches the OS window title's name.
- [ ] Opening a file with a path containing folders shows only the file's basename.

## Light / dark appearance

- [ ] App follows the macOS system appearance (System Settings ▸ Appearance).
- [ ] Switching system Light↔Dark while the app is open updates editor styling.
- [ ] Text, code blocks, tables, and the dirty dot remain legible in both modes.

> Note: explicit in-app theme toggle is **[later]** — today appearance follows the OS.

## Launch / stability (also covered by `scripts/smoke.sh`)

- [ ] App launches with no Rust panic in the terminal log.
- [ ] No "failed to parse accelerator" errors at startup (validates `menu.rs` shortcuts).
- [ ] Window opens at the configured size with hidden/overlay title bar.
