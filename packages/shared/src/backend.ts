import type { AttachmentMeta, Node, QueuedOp } from "./types";

export interface BackendInfo {
  persistent: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  location: string | null;
}

/**
 * The narrow port every platform implements. Adapters deal only in whole-row
 * reads and atomic batch writes; **all** domain rules (versioning, hashing,
 * tombstoning subtrees, coalescing the change queue) live in `Store` so the
 * behaviour is identical on IndexedDB, SQLite and in memory.
 *
 * Contract notes:
 * - `writeNodes(nodes, deletedIds)` must be atomic: either all of it lands or none.
 * - Deletes are hard deletes of rows that the caller has already tombstoned or
 *   decided to physically remove (queue acknowledgements, `clear`).
 * - Reads return every row, including tombstoned nodes; `Store` filters.
 */
export interface StoreBackend {
  readonly kind: "memory" | "indexeddb" | "sqlite";
  init(): Promise<void>;
  readNodes(): Promise<Node[]>;
  writeNodes(nodes: readonly Node[], deletedIds: readonly string[]): Promise<void>;
  readAttachments(): Promise<AttachmentMeta[]>;
  writeAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<void>;
  readAttachmentBytes(id: string): Promise<Uint8Array | null>;
  deleteAttachments(ids: readonly string[]): Promise<void>;
  readQueue(): Promise<QueuedOp[]>;
  /** Replaces/inserts `ops` and removes `ackedOpIds`, in one transaction. */
  writeOps(ops: readonly QueuedOp[], ackedOpIds: readonly string[]): Promise<void>;
  readMeta(key: string): Promise<string | null>;
  writeMeta(entries: ReadonlyArray<{ key: string; value: string | null }>): Promise<void>;
  clear(): Promise<void>;
  info(): Promise<BackendInfo>;
}

export const META_KEYS = {
  schemaVersion: "schemaVersion",
  checkpoint: "sync.checkpoint",
  localOwnerId: "account.localOwnerId",
  deviceId: "device.id",
  lastSyncedAt: "sync.lastSyncedAt",
} as const;

export const SCHEMA_VERSION = "1";
