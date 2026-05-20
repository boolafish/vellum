mod menu;
mod recents;
mod theme;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use recents::RecentsState;
use theme::{ThemeMode, ThemeState};

/// Rebuild and install the app menu from current state (recents + theme).
/// Called whenever either changes. Must not be called while holding a state
/// lock it re-reads (RecentsState / ThemeState).
pub fn refresh_menu(app: &AppHandle) {
    let recents = app.state::<RecentsState>().list.lock().unwrap().clone();
    let theme = app.state::<ThemeState>().get();
    if let Ok(menu) = menu::build(app, &recents, theme) {
        let _ = app.set_menu(menu);
    }
}

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
fn add_recent(app: AppHandle, path: String) {
    recents::add(&app, &path);
}

#[tauri::command]
fn get_theme(state: State<ThemeState>) -> String {
    state.get().as_str().to_string()
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
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            get_recents,
            add_recent,
            get_theme
        ])
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
            } else if let Some(mode) = id.strip_prefix("theme:") {
                // Persist + refresh checkmarks, then tell the frontend to apply.
                theme::set(app, ThemeMode::from_str(mode));
                let _ = app.emit("theme-changed", mode);
            } else {
                // Predefined items (undo/copy/…) are handled natively and never
                // reach here; only our custom ids do. Forward them verbatim.
                let _ = app.emit("menu:action", id);
            }
        })
        .setup(|app| {
            let handle = app.handle();
            let recents = recents::load(handle);
            app.manage(RecentsState {
                list: Mutex::new(recents.clone()),
            });
            app.manage(theme::load(handle));
            let theme = app.state::<ThemeState>().get();
            app.set_menu(menu::build(handle, &recents, theme)?)?;
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
