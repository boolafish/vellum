use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Wry};

const FILE: &str = "theme";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    Light,
    Dark,
    System,
}

impl ThemeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ThemeMode::Light => "light",
            ThemeMode::Dark => "dark",
            ThemeMode::System => "system",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "light" => ThemeMode::Light,
            "dark" => ThemeMode::Dark,
            _ => ThemeMode::System,
        }
    }
}

/// The current appearance preference. System means "follow the OS"; the
/// frontend resolves that to light/dark via prefers-color-scheme.
pub struct ThemeState(Mutex<ThemeMode>);

impl ThemeState {
    pub fn get(&self) -> ThemeMode {
        *self.0.lock().unwrap()
    }
}

fn store_path(app: &AppHandle<Wry>) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(FILE))
}

pub fn load(app: &AppHandle<Wry>) -> ThemeState {
    let mode = store_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| ThemeMode::from_str(s.trim()))
        .unwrap_or(ThemeMode::System);
    ThemeState(Mutex::new(mode))
}

/// Persist the preference, refresh the menu checkmarks, and return the new
/// mode so the caller can notify the frontend.
pub fn set(app: &AppHandle<Wry>, mode: ThemeMode) {
    *app.state::<ThemeState>().0.lock().unwrap() = mode;
    if let Some(path) = store_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, mode.as_str());
    }
    crate::refresh_menu(app);
}
