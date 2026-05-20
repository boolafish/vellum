mod menu;
mod recents;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager, State};

use recents::RecentsState;

/// Paths the app was asked to open before the frontend was ready (cold launch
/// via Finder "Open With" / double-click). Drained by `frontend_ready`.
#[derive(Default)]
struct PendingOpen(Mutex<Vec<String>>);

/// Whether the frontend has signalled it can receive open-file events.
#[derive(Default)]
struct FrontendReady(AtomicBool);

/// Frontend handshake on startup: marks the UI ready and returns any files the
/// app was launched with so they can be opened once the editor exists.
#[tauri::command]
fn frontend_ready(pending: State<PendingOpen>, ready: State<FrontendReady>) -> Vec<String> {
    ready.0.store(true, Ordering::SeqCst);
    std::mem::take(&mut pending.0.lock().unwrap())
}

#[tauri::command]
fn get_recents(state: State<RecentsState>) -> Vec<String> {
    state.list.lock().unwrap().clone()
}

#[tauri::command]
fn add_recent(app: tauri::AppHandle, path: String) {
    recents::add(&app, &path);
}

fn handle_opened(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<String> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return;
    }
    if app.state::<FrontendReady>().0.load(Ordering::SeqCst) {
        for path in &paths {
            let _ = app.emit("open-path", path);
        }
    } else {
        app.state::<PendingOpen>().0.lock().unwrap().extend(paths);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(PendingOpen::default())
        .manage(FrontendReady::default())
        .invoke_handler(tauri::generate_handler![frontend_ready, get_recents, add_recent])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(rest) = id.strip_prefix("recent:") {
                // Recorded paths are always absolute, so `rest` can never be
                // the bare sentinels "clear"/"none" — no spoofing risk.
                match rest {
                    "clear" => recents::clear(app),
                    "none" => {}
                    path => {
                        let _ = app.emit("open-path", path);
                    }
                }
            } else {
                // Predefined items (undo/copy/…) are handled natively and never
                // reach here; only our custom ids do. Forward them verbatim.
                let _ = app.emit("menu:action", id);
            }
        })
        .setup(|app| {
            let handle = app.handle();
            let initial = recents::load(handle);
            app.manage(RecentsState {
                list: Mutex::new(initial.clone()),
            });
            app.set_menu(menu::build(handle, &initial)?)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Finder "Open With" / double-click while the app is alive or cold.
            tauri::RunEvent::Opened { urls } => handle_opened(app, urls),
            // Single-window app: closing the window quits.
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => app.exit(0),
            _ => {}
        });
}
