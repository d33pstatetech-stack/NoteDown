/**
 * Desktop-only bridge.
 *
 * The same frontend runs in the browser and inside the Tauri webview; this
 * module is the only place that knows the difference. It is written so that
 * importing it in a browser is harmless: everything is guarded by a runtime
 * check for the Tauri bridge, and the `@tauri-apps/*` imports are dynamic so a
 * browser bundle never loads them.
 */

interface TauriInternals {
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

export function isDesktop(): boolean {
  return typeof (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ !==
    "undefined";
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

/**
 * Saves an exported archive next to the local database (and reports the path).
 * A native "save as" dialog is used when the dialog plugin is available, so the
 * user always knows where the file went; the app-data fallback keeps export
 * working even if the dialog is unavailable.
 */
export async function saveExportOnDesktop(bytes: Uint8Array, filename: string): Promise<string> {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("The desktop bridge is not available");
  const invoke = internals.invoke;
  const encoded = toBase64(bytes);
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (path) {
      await invoke("save_export", { path, bytesBase64: encoded });
      return path;
    }
  } catch {
    // Fall through to the app-data directory below.
  }
  return invoke<string>("save_export_to_app_dir", { filename, bytesBase64: encoded });
}
