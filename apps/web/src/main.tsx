import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@localnotes/ui";
import { Store } from "@localnotes/shared";
import { selectBackend } from "@localnotes/storage";
import { createSyncEngine } from "@localnotes/sync";
import { isDesktop, saveExportOnDesktop } from "./desktop";

/**
 * The web shell. Storage is IndexedDB (in-memory only if the browser refuses),
 * and sync is a no-op client until an account is configured — the app is fully
 * usable offline without it.
 */
const store = new Store(selectBackend());
const sync = createSyncEngine({ store });

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element in index.html");
}

// The desktop build writes exports through the Rust core so the archive lands
// in a known location; the browser build uses an ordinary download.
const onDownload = isDesktop()
  ? (bytes: Uint8Array, filename: string) => {
      void saveExportOnDesktop(bytes, filename).catch((error: unknown) => {
        console.error("Could not save the export", error);
      });
    }
  : undefined;

createRoot(container).render(
  <StrictMode>
    <App store={store} {...(onDownload ? { onDownload } : {})} sync={sync.status()} />
  </StrictMode>,
);
