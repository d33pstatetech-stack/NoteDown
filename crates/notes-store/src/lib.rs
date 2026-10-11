//! Narrow SQLite storage core for the Local-First Markdown Notes desktop app.
//!
//! The design rule for this crate: **no domain policy here**. Notebook/folder/
//! note hierarchy rules, versioning, tombstoning subtrees, hashing and the
//! change-queue coalescing all live once in `packages/shared` and run in the
//! webview, so the browser and the desktop build cannot drift apart. This crate
//! only has to be correct about the parts TypeScript cannot do safely:
//!
//! * transactional, all-or-nothing batch writes,
//! * an on-disk SQLite database with explicit, versioned migrations,
//! * attachment bytes in an application-managed directory with path-traversal
//!   and digest checks,
//! * and a durable change queue that survives a restart.
//!
//! `apps/desktop/src-tauri` exposes these methods as `#[tauri::command]`s;
//! `packages/storage/src/tauri.ts` is the matching client.

pub mod error;
pub mod model;
pub mod paths;
pub mod repo;
pub mod schema;

pub use error::{Result, StoreError};
pub use model::{AttachmentMeta, MetaEntry, Node, QueuedOp, StoreInfo};
pub use repo::NoteStore;

/// Opens the store at the platform's documented data location.
pub fn open_default() -> Result<NoteStore> {
    NoteStore::open(paths::database_path())
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn formats_known_epoch_seconds_as_utc_iso() {
        assert_eq!(repo::format_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(repo::format_iso(1_700_000_000), "2023-11-14T22:13:20.000Z");
        // Leap-day boundary.
        assert_eq!(repo::format_iso(951_782_400), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn now_is_a_utc_iso_timestamp() {
        let value = repo::now_iso();
        assert_eq!(value.len(), 24);
        assert!(value.ends_with('Z'));
        assert!(value.starts_with("20"));
    }

    #[test]
    fn rejects_path_unsafe_filename_components() {
        assert!(repo::is_path_safe_component("6f1c1f9a-4a2b-4d31-9c8e-0a1b2c3d4e5f"));
        assert!(repo::is_path_safe_component("png"));
        assert!(!repo::is_path_safe_component(".."));
        assert!(!repo::is_path_safe_component("../etc/passwd"));
        assert!(!repo::is_path_safe_component("a/b"));
        assert!(!repo::is_path_safe_component(""));
        assert!(!repo::is_path_safe_component("a\\b"));
    }

    #[test]
    fn documents_the_per_os_data_directory() {
        let dir = paths::data_dir();
        assert!(dir.to_string_lossy().contains(paths::APP_ID));
        assert!(paths::database_path().ends_with("notes.sqlite3"));
        assert!(paths::attachments_path().ends_with("attachments"));
    }
}
