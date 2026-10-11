export type SyncStateName = "disabled" | "idle" | "syncing" | "offline" | "error";

export interface SyncStatusSnapshot {
  state: SyncStateName;
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
  conflicts: number;
}

export interface SyncReport {
  pushed: number;
  applied: number;
  conflicts: number;
  downloaded: number;
  pushedAttachments: number;
  downloadedAttachments: number;
}
