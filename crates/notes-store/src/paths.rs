use std::path::PathBuf;

/// Application identifier, also the directory name under the OS data directory.
pub const APP_ID: &str = "com.localnotes.app";

/// Where the database and attachment directory live, per operating system:
///
/// | OS      | Directory                                                       |
/// |---------|-----------------------------------------------------------------|
/// | Linux   | `$XDG_DATA_HOME/com.localnotes.app` or `~/.local/share/…`        |
/// | Windows | `%APPDATA%\com.localnotes.app`                                   |
/// | macOS   | `~/Library/Application Support/com.localnotes.app`               |
///
/// Documented in `docs/DATA-LOCATIONS.md`; the same table appears in the README
/// so a user can find (and back up) their notes without the app.
pub fn data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join(APP_ID);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_ID);
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            let value = PathBuf::from(xdg);
            if value.is_absolute() {
                return value.join(APP_ID);
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local").join("share").join(APP_ID);
        }
    }

    std::env::temp_dir().join(APP_ID)
}

pub fn database_path() -> PathBuf {
    data_dir().join("notes.sqlite3")
}

pub fn attachments_path() -> PathBuf {
    data_dir().join("attachments")
}
