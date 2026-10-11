import type { ReactNode } from "react";
import type { StorageInfo } from "@localnotes/shared";
import type { SaveState } from "../app/workspace";
import type { ThemeMode } from "../app/theme";
import type { SyncController } from "../app/sync-controller";

export type SyncStatus = SyncController;

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

/**
 * The one place the sync state is turned into words. Every branch states what is
 * true about the user's data — local safety first, cloud second — because this
 * is the only feedback a user gets about whether their work reached the server.
 */
export function describeSync(sync: SyncStatus): { label: string; tone: "ok" | "warn" | "error" } {
  if (sync.unavailable) {
    return { label: "Local only — sign in to sync", tone: "warn" };
  }
  if (sync.authState === "checking") return { label: "Checking account…", tone: "warn" };
  if (sync.authState === "signed-out") return { label: "Local only — sign in to sync", tone: "warn" };

  const { state, pending } = sync.status;
  switch (state) {
    case "syncing":
      return { label: "Syncing…", tone: "ok" };
    case "offline":
      return {
        label: pending > 0 ? `Offline — ${pending} change(s) queued` : "Offline — all changes saved here",
        tone: "warn",
      };
    case "error":
      return { label: `Sync error — ${pending} change(s) queued`, tone: "error" };
    case "disabled":
      return { label: "Local only — sign in to sync", tone: "warn" };
    default:
      if (sync.status.conflicts > 0) {
        return { label: `Synced — ${sync.status.conflicts} conflict copy/copies to review`, tone: "warn" };
      }
      return pending > 0 ? { label: `${pending} change(s) to sync`, tone: "warn" } : { label: "Synced", tone: "ok" };
  }
}

export function StatusBar(props: StatusBarProps): ReactNode {
  const { storage, sync } = props;
  const storageLabel = storage
    ? `${storage.backend}${storage.persistent === false ? " (best-effort, may be evicted)" : ""}`
    : "…";
  const { label: syncLabel, tone: syncTone } = describeSync(sync);
  const signedIn = sync.authState === "signed-in" && !sync.unavailable;
  const canSyncNow =
    signedIn && (sync.status.state === "idle" || sync.status.state === "error" || sync.status.state === "offline");

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
        <span data-testid="sync-status" data-tone={syncTone}>
          {syncLabel}
        </span>
        {signedIn ? (
          <button
            type="button"
            className="ln-link"
            onClick={() => void sync.syncNow()}
            disabled={!canSyncNow}
          >
            Sync now
          </button>
        ) : (
          <button
            type="button"
            className="ln-link"
            onClick={() => document.dispatchEvent(new CustomEvent("localnotes:sign-in"))}
          >
            Sign in
          </button>
        )}
        {signedIn ? (
          <button type="button" className="ln-link" onClick={() => void sync.signOut()}>
            Sign out
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
