import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, SyncControllerProvider } from "@localnotes/ui";
import { isDesktop, saveExportOnDesktop } from "./desktop";
import { createRuntime, startSyncLifecycle, type Runtime } from "./runtime";

/**
 * The web/desktop shell.
 *
 * Storage is IndexedDB in a browser and SQLite behind the Tauri bridge on the
 * desktop. Sync is wired only when an API URL is configured, so a build with no
 * backend is a fully working offline app rather than a broken one.
 */
const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element in index.html");
}

const root = createRoot(container);

function renderFatal(message: string): void {
  root.render(
    <div className="ln-app ln-fatal" role="alert">
      <h1>Local storage is unavailable</h1>
      <p>{message}</p>
      <p>Nothing was deleted. Allow storage for this site and reload the app.</p>
    </div>,
  );
}

function renderApp(runtime: Runtime): void {
  // The desktop build writes exports through the Rust core so the archive lands
  // in a known location; the browser build uses an ordinary download.
  const onDownload = isDesktop()
    ? (bytes: Uint8Array, filename: string) => {
        void saveExportOnDesktop(bytes, filename).catch((error: unknown) => {
          console.error("Could not save the export", error);
        });
      }
    : undefined;

  root.render(
    <StrictMode>
      <SyncControllerProvider engine={runtime.sync} auth={runtime.auth}>
        <App store={runtime.store} {...(onDownload ? { onDownload } : {})} />
      </SyncControllerProvider>
    </StrictMode>,
  );
}

void (async () => {
  let runtime: Runtime;
  try {
    runtime = await createRuntime();
  } catch (error) {
    // The Store reports its own failures through the UI, but a failure to build
    // the runtime at all (no IndexedDB, no native bridge) would otherwise leave
    // a blank page with no explanation.
    renderFatal(error instanceof Error ? error.message : String(error));
    return;
  }

  renderApp(runtime);

  // `engine.start()` runs one cycle immediately and then ticks. The app also
  // needs to finish opening the database before the first sync reads from it;
  // `App` owns that initialisation, so the lifecycle simply keeps running.
  if (runtime.sync) {
    const stop = startSyncLifecycle(runtime.sync);
    globalThis.addEventListener?.("beforeunload", stop);
  }
})();
