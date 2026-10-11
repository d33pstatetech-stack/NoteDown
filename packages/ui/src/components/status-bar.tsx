import type { ReactNode } from "react";
import type { StorageInfo } from "@localnotes/shared";
import type { SaveState } from "../app/workspace";
import type { ThemeMode } from "../app/theme";

export interface SyncStatus {
  state: "disabled" | "idle" | "syncing" | "offline" | "error";
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
  onRetry?: () => void;
}

export interface StatusBarProps {
  saveState: SaveState;
  lastSavedAt: string | null;
  pendingOps: number;
  storage: StorageInfo | null;
  sync: SyncStatus;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  onExport: () => void;
  onImport: () => void;
  onFlush: () => void;
}

function saveLabel(saveState: SaveState, lastSavedAt: string | null): string {
  switch (saveState) {
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving locally…";
    case "saved":
      return `Saved locally${lastSavedAt ? ` at ${lastSavedAt.slice(11, 19)}` : ""}`;
    case "error":
      return "Save failed — your text is still in the editor";
    default:
      return "Saved locally";
  }
}

export function StatusBar(props: StatusBarProps): ReactNode {
  const { storage } = props;
  const storageLabel = storage
    ? `${storage.backend}${storage.persistent === false ? " (best-effort, may be evicted)" : ""}`
    : "…";
  const syncLabel =
    props.sync.state === "disabled"
      ? "Cloud sync not configured (local only)"
      : props.sync.state === "syncing"
        ? "Syncing…"
        : props.sync.state === "offline"
          ? `Offline — ${props.sync.pending} change(s) queued`
          : props.sync.state === "error"
            ? `Sync error — ${props.sync.pending} change(s) queued`
            : props.sync.pending > 0
              ? `${props.sync.pending} change(s) to sync`
              : "Synced";

  return (
    <footer className="ln-status">
      <div className="ln-status-group">
        <span
          className={`ln-save-indicator state-${props.saveState}`}
          role="status"
          aria-live="polite"
          data-testid="save-indicator"
        >
          {saveLabel(props.saveState, props.lastSavedAt)}
        </span>
        <button type="button" className="ln-link" onClick={props.onFlush}>
          Save now
        </button>
      </div>

      <div className="ln-status-group">
        <span data-testid="sync-status">{syncLabel}</span>
        {props.sync.onRetry && props.sync.state === "error" ? (
          <button type="button" className="ln-link" onClick={props.sync.onRetry}>
            Retry
          </button>
        ) : null}
        <span className="ln-sep" aria-hidden="true">
          ·
        </span>
        <span data-testid="storage-status">
          {storageLabel} · {props.storage?.nodeCount ?? 0} item(s)
          {storage?.usageBytes ? ` · ${Math.round(storage.usageBytes / 1024)} KiB used` : ""}
        </span>
      </div>

      <div className="ln-status-group">
        <button type="button" className="ln-link" onClick={props.onExport}>
          Export
        </button>
        <button type="button" className="ln-link" onClick={props.onImport}>
          Import
        </button>
        <button
          type="button"
          className="ln-link"
          onClick={props.onCycleTheme}
          aria-label={`Theme: ${props.themeMode}. Switch theme`}
        >
          {props.themeMode === "system" ? "Auto" : props.themeMode === "dark" ? "Dark" : "Light"}
        </button>
      </div>
    </footer>
  );
}
