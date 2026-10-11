//! Tauri entry point. The webview loads the shared frontend bundle built from
//! `apps/web` and talks to the native store through the commands in
//! `commands.rs`, which is the only place platform code touches the database.

pub mod commands;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Only the dialog plugin is enabled: the webview needs it to pick a
        // destination for an exported archive. Notes are written by the Rust
        // core, so no filesystem permissions are granted to the frontend.
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::store_init,
            commands::store_read_nodes,
            commands::store_write_nodes,
            commands::store_read_attachments,
            commands::store_write_attachment,
            commands::store_read_attachment_bytes,
            commands::store_delete_attachments,
            commands::store_read_queue,
            commands::store_write_ops,
            commands::store_read_meta,
            commands::store_write_meta,
            commands::store_clear,
            commands::store_info,
            commands::save_export,
            commands::save_export_to_app_dir,
            commands::set_sync_token,
            commands::get_sync_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Local Notes desktop application");
}
