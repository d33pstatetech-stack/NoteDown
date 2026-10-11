//! The entire native surface. Every command is a thin, typed wrapper over
//! `notes_store::NoteStore`; there is no domain logic here, which keeps the
//! desktop and browser builds behaviourally identical.
//!
//! Argument names arrive camelCased from TypeScript (`deletedIds`) and are
//! mapped to Rust snake_case by Tauri automatically; return values are
//! serialized with `camelCase` field names by serde.

use std::sync::Mutex;

use notes_store::{MetaEntry, NoteStore, QueuedOp, StoreError};
use tauri::{AppHandle, Manager, State};

/// Holds the single SQLite connection for the process. `rusqlite::Connection`
/// is `Send` but not `Sync`, so a mutex serialises access, which is also what
/// keeps each command's transaction atomic with respect to the others.
#[derive(Default)]
pub struct AppState(pub Mutex<Option<NoteStore>>);

impl AppState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

fn open_store(app: &AppHandle) -> Result<NoteStore, String> {
    // Prefer Tauri's own app-data path (it is the documented, per-platform
    // location) and fall back to the identical convention implemented in
    // `notes_store::paths` if the resolver is unavailable.
    let directory = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| notes_store::paths::data_dir());
    NoteStore::open(directory.join("notes.sqlite3")).map_err(StoreError::to_string)
}

fn with_store<T>(
    app: &AppHandle,
    state: &State<'_, AppState>,
    action: impl FnOnce(&mut NoteStore) -> Result<T, StoreError>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;
    if guard.is_none() {
        *guard = Some(open_store(app)?);
    }
    let store = guard.as_mut().expect("store was just initialised");
    action(store).map_err(StoreError::to_string)
}

#[tauri::command]
pub fn store_init(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    with_store(&app, &state, |store| {
        let version = store.schema_version()?;
        debug_assert!(version > 0);
        store.write_meta(&[MetaEntry {
            key: "schemaVersion".to_string(),
            value: Some(version.to_string()),
        }])
    })
}

#[tauri::command]
pub fn store_read_nodes(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<notes_store::Node>, String> {
    with_store(&app, &state, |store| store.read_nodes())
}

#[tauri::command]
pub fn store_write_nodes(
    app: AppHandle,
    state: State<'_, AppState>,
    nodes: Vec<notes_store::Node>,
    deleted_ids: Vec<String>,
) -> Result<(), String> {
    with_store(&app, &state, |store| store.write_nodes(&nodes, &deleted_ids))
}

#[tauri::command]
pub fn store_read_attachments(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<notes_store::AttachmentMeta>, String> {
    with_store(&app, &state, |store| store.read_attachments())
}

#[tauri::command]
pub fn store_write_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    meta: notes_store::AttachmentMeta,
    bytes_base64: String,
) -> Result<(), String> {
    let bytes = decode_base64(&bytes_base64)?;
    with_store(&app, &state, |store| store.write_attachment(&meta, &bytes))
}

#[tauri::command]
pub fn store_read_attachment_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    with_store(&app, &state, |store| store.read_attachment_base64(&id))
}

#[tauri::command]
pub fn store_delete_attachments(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    with_store(&app, &state, |store| store.delete_attachments(&ids))
}

#[tauri::command]
pub fn store_read_queue(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<QueuedOp>, String> {
    with_store(&app, &state, |store| store.read_queue())
}

#[tauri::command]
pub fn store_write_ops(
    app: AppHandle,
    state: State<'_, AppState>,
    ops: Vec<QueuedOp>,
    acked_op_ids: Vec<String>,
) -> Result<(), String> {
    with_store(&app, &state, |store| store.write_ops(&ops, &acked_op_ids))
}

#[tauri::command]
pub fn store_read_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    with_store(&app, &state, |store| store.read_meta(&key))
}

#[tauri::command]
pub fn store_write_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    entries: Vec<MetaEntry>,
) -> Result<(), String> {
    with_store(&app, &state, |store| store.write_meta(&entries))
}

#[tauri::command]
pub fn store_clear(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    with_store(&app, &state, |store| store.clear())
}

#[tauri::command]
pub fn store_info(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<notes_store::StoreInfo, String> {
    with_store(&app, &state, |store| store.info())
}

/// Writes an exported archive to a path the user chose in the file dialog.
/// Exports never write anywhere the user did not explicitly pick.
#[tauri::command]
pub fn save_export(path: String, bytes_base64: String) -> Result<(), String> {
    let bytes = decode_base64(&bytes_base64)?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())
}

/// Writes an export next to the database, for the "export for backup" path where
/// no dialog is involved. Returns the absolute path so the UI can show it.
#[tauri::command]
pub fn save_export_to_app_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    filename: String,
    bytes_base64: String,
) -> Result<String, String> {
    let safe = sanitize_filename(&filename)?;
    let directory = with_store(&app, &state, |store| {
        let location = store.location().to_string();
        Ok(std::path::Path::new(&location)
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| std::path::PathBuf::from(".")))
    })?;
    let target = directory.join(safe);
    std::fs::write(&target, decode_base64(&bytes_base64)?).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| error.to_string())
}

/// Attachment ids and export names are never allowed to become a path.
fn sanitize_filename(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err("the file name is not usable".to_string());
    }
    if trimmed.contains(['/', '\\']) || trimmed.contains("..") || trimmed.starts_with('.') {
        return Err("the file name is not usable".to_string());
    }
    Ok(trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ' ') {
                character
            } else {
                '-'
            }
        })
        .collect())
}
