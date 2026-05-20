use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Wry};

const MAX_RECENTS: usize = 10;
const FILE: &str = "recents.json";

/// Most-recently-opened file paths, newest first. Single source of truth for
/// both the Open Recent submenu and the launch "reopen last file" behavior.
#[derive(Default)]
pub struct RecentsState {
    pub list: Mutex<Vec<String>>,
}

fn store_path(app: &AppHandle<Wry>) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(FILE))
}

/// Read the persisted list, dropping any paths that no longer exist on disk.
pub fn load(app: &AppHandle<Wry>) -> Vec<String> {
    let Some(path) = store_path(app) else {
        return Vec::new();
    };
    let Ok(data) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let all: Vec<String> = serde_json::from_str(&data).unwrap_or_default();
    let pruned: Vec<String> = all.iter().filter(|p| Path::new(p).exists()).cloned().collect();
    // Write back so dead entries don't accumulate across launches.
    if pruned.len() != all.len() {
        persist(app, &pruned);
    }
    pruned
}

fn persist(app: &AppHandle<Wry>, list: &[String]) {
    let Some(path) = store_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(list) {
        let _ = fs::write(path, data);
    }
}

fn rebuild_menu(app: &AppHandle<Wry>, list: &[String]) {
    if let Ok(menu) = crate::menu::build(app, list) {
        let _ = app.set_menu(menu);
    }
}

/// Promote `new_path` to the front, persist, and refresh the menu. The lock is
/// held across persist+rebuild so concurrent adds can't reorder the menu/file.
/// (`add` is invoked from Tauri command handlers; the lock is brief.)
pub fn add(app: &AppHandle<Wry>, new_path: &str) {
    let state = app.state::<RecentsState>();
    let mut list = state.list.lock().unwrap();
    if list.first().is_some_and(|p| p == new_path) {
        return; // already most-recent; nothing to persist or rebuild
    }
    list.retain(|p| p != new_path);
    list.insert(0, new_path.to_string());
    list.truncate(MAX_RECENTS);
    persist(app, &list);
    rebuild_menu(app, &list);
}

pub fn clear(app: &AppHandle<Wry>) {
    let state = app.state::<RecentsState>();
    let mut list = state.list.lock().unwrap();
    list.clear();
    persist(app, &list);
    rebuild_menu(app, &list);
}
