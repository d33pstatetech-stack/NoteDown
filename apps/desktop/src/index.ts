/**
 * The desktop shell ships the shared frontend (`apps/web`) unchanged; the
 * storage layer is swapped for `TauriStore` at runtime. The Cargo crate under
 * `apps/desktop/src-tauri` is the only native code.
 */
export const DESKTOP_APP_ID = "com.localnotes.app";
