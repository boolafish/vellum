use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Wry};

use crate::theme::ThemeMode;

/// Builds the "Open Recent" submenu. Items carry ids `recent:<path>`, handled
/// in `lib.rs`; `recent:clear` empties the list, `recent:none` is a disabled
/// placeholder.
fn recent_submenu(app: &AppHandle<Wry>, recents: &[String]) -> tauri::Result<Submenu<Wry>> {
    let mut builder = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        builder = builder.item(
            &MenuItemBuilder::with_id("recent:none", "No Recent Files")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for path in recents {
            let label = path.rsplit(['/', '\\']).next().unwrap_or(path);
            builder = builder.item(&MenuItemBuilder::with_id(format!("recent:{path}"), label).build(app)?);
        }
        builder = builder
            .separator()
            .item(&MenuItemBuilder::with_id("recent:clear", "Clear Menu").build(app)?);
    }
    builder.build()
}

/// Appearance submenu: Light / Dark / System as checkmarked items. Ids
/// `theme:<mode>` are handled in `lib.rs`.
fn appearance_submenu(app: &AppHandle<Wry>, theme: ThemeMode) -> tauri::Result<Submenu<Wry>> {
    let item = |id: &str, label: &str, mode: ThemeMode| {
        CheckMenuItemBuilder::with_id(id, label).checked(theme == mode).build(app)
    };
    SubmenuBuilder::new(app, "Appearance")
        .item(&item("theme:light", "Light", ThemeMode::Light)?)
        .item(&item("theme:dark", "Dark", ThemeMode::Dark)?)
        .item(&item("theme:system", "System", ThemeMode::System)?)
        .build()
}

/// Builds the native macOS menu bar. Custom items carry ids that match
/// `src/ipc.ts`; selecting one fires `on_menu_event`, which forwards the id
/// to the frontend. Edit-menu items use predefined (native) actions so
/// undo/redo/clipboard work against WKWebView directly.
pub fn build(app: &AppHandle<Wry>, recents: &[String], theme: ThemeMode) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, "MD Editor")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        // Custom quit (not predefined) so it routes through the dirty guard.
        .item(
            &MenuItemBuilder::with_id("quit", "Quit MD Editor")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new", "New").accelerator("CmdOrCtrl+N").build(app)?)
        .item(&MenuItemBuilder::with_id("open", "Open…").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&recent_submenu(app, recents)?)
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(app)?)
        .item(
            &MenuItemBuilder::with_id("save-as", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("close", "Close").accelerator("CmdOrCtrl+W").build(app)?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        // Disabled until Find lands (Phase 7); avoids a dead menu entry.
        .item(
            &MenuItemBuilder::with_id("find", "Find…")
                .accelerator("CmdOrCtrl+F")
                .enabled(false)
                .build(app)?,
        )
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&appearance_submenu(app, theme)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+Equal")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+Minus")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-reset", "Actual Size")
                .accelerator("CmdOrCtrl+Digit0")
                .build(app)?,
        )
        .build()?;

    // No close_window() here: File ▸ Close (custom "close") owns Cmd+W so the
    // dirty-guard (Phase 2) can intercept it. A native close_window would bind
    // the same accelerator and bypass the dispatcher.
    let window_menu = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}
