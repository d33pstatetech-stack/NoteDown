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

function tauriInvoke(): (<T>(command: string, args?: Record<string, unknown>) => Promise<T>) | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke.bind(internals) : null;
}

export function isDesktop(): boolean {
  return tauriInvoke() !== null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a multi-megabyte export cannot blow the argument limit on a
  // single String.fromCharCode spread.
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return globalThis.btoa(binary);
}

/**
 * Saves an exported archive next to the local database (and reports the path).
 * A native "save as" dialog is used when the dialog plugin is available, so the
 * user always knows where the file went; the app-data fallback keeps export
 * working even if the dialog is unavailable.
 */
export async function saveExportOnDesktop(bytes: Uint8Array, filename: string): Promise<string> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error("The desktop bridge is not available");
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

/**
 * The sync bearer token.
 *
 * Read and written through the Rust core rather than `localStorage`, so it lives
 * in a file with owner-only permissions instead of being readable by any script
 * in the webview, is never part of the SQLite database, and cannot end up
 * inside a ZIP export.
 */
export async function loadDesktopToken(): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    return await invoke<string | null>("get_sync_token");
  } catch {
    // A missing credential store is not an error: the user is simply signed out.
    return null;
  }
}

export async function saveDesktopToken(token: string | null): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  await invoke("set_sync_token", { token });
}
