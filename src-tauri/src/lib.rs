mod menu;

use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| {
            // Predefined items (undo/copy/quit/…) are handled natively and
            // never reach here; only our custom ids do. Forward them verbatim.
            let _ = app.emit("menu:action", event.id().as_ref());
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
