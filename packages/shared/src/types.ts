/**
 * The domain model. One unified node table holds notebooks, folders and notes:
 * a note is a tree node whose `kind` is `note`. This keeps moves to a single
 * `parentId` update and makes the invariant set small enough to test exhaustively.
 */

export type NodeKind = "notebook" | "folder" | "note";

/**
 * `local-only` — never uploaded.
 * `pending`    — local edit queued for upload.
 * `synced`     — local and remote agree (`localVersion === baseVersion`).
 * `conflict`   — a divergence was detected and preserved (see sync protocol §5).
 * `deleted`    — tombstone awaiting acknowledgement from the server.
 */
export type SyncState = "local-only" | "pending" | "synced" | "conflict" | "deleted";

export interface Node {
  /** Stable UUID. Never derived from a title or a path. */
  id: string;
  kind: NodeKind;
  /** `null` only for notebooks. */
  parentId: string | null;
  title: string;
  /** Markdown source; empty for notebooks and folders. */
  content: string;
  /** Sibling ordering within the parent. */
  position: number;
  /** SHA-256 hex of `content`; the change/conflict detector. */
  contentHash: string;
  /** Incremented on every accepted local write. */
  localVersion: number;
  /** Last server version this copy was based on; 0 means never synced. */
  baseVersion: number;
  syncState: SyncState;
  createdAt: string;
  updatedAt: string;
  /** Tombstone marker; non-null means "deleted", never "not downloaded". */
  deletedAt: string | null;
  /** Set on conflict copies: the id of the note they were copied from. */
  conflictOf: string | null;
  /** Set on conflict copies: when the divergence was recorded. */
  conflictRecordedAt: string | null;
}

export interface CreateNodeInput {
  kind: NodeKind;
  parentId: string | null;
  title?: string;
  content?: string;
  /** Supply to restore a known id (e.g. import); otherwise a fresh UUID is used. */
  id?: string;
  /** Explicit sibling position; `null`/omitted appends. */
  position?: number | null;
}

export interface UpdateNodePatch {
  title?: string;
  content?: string;
}

export interface AttachmentMeta {
  /** Stable UUID; also the object key stem on the server and on disk. */
  id: string;
  /** Note that references this attachment, when known. */
  noteId: string | null;
  /** Display only. Never used to build a filesystem path. */
  filename: string;
  /** Sniffed MIME type, not the client-supplied one. */
  mime: string;
  /** Canonical extension derived from `mime` (no dot). */
  ext: string;
  size: number;
  sha256: string;
  createdAt: string;
  syncState: SyncState;
  baseVersion: number;
}

export type OpType = "upsert_node" | "delete_node" | "put_attachment" | "delete_attachment";

export interface UpsertNodePayload {
  kind: NodeKind;
  parentId: string | null;
  title: string;
  content: string;
  position: number;
  contentHash: string;
  /** Set on conflict copies so the provenance survives a round trip. */
  conflictOf?: string | null;
}

export interface DeleteNodePayload {
  deletedAt: string;
}

export interface PutAttachmentPayload {
  noteId: string | null;
  mime: string;
  ext: string;
  size: number;
  sha256: string;
}

export interface DeleteAttachmentPayload {
  deletedAt: string;
}

interface QueuedOpBase {
  /** Idempotency key: a retried op keeps its id and may be delivered repeatedly. */
  opId: string;
  /** Node id or attachment id, depending on `type`. */
  entityId: string;
  baseVersion: number;
  /**
   * Content hashes this client has already sent for this entity since
   * `baseVersion`. Used after a `conflict` response to tell "my own earlier
   * write came back to me" (rebase, no conflict copy) apart from a genuine
   * two-device divergence (preserve both). See docs/SYNC-PROTOCOL.md §5.
   */
  pushedHashes: string[];
  attempts: number;
  lastError: string | null;
  /** ISO timestamp for the next backoff attempt; null means "ready now". */
  nextAttemptAt: string | null;
  createdAt: string;
}

export type QueuedOp =
  | (QueuedOpBase & { type: "upsert_node"; payload: UpsertNodePayload })
  | (QueuedOpBase & { type: "delete_node"; payload: DeleteNodePayload })
  | (QueuedOpBase & { type: "put_attachment"; payload: PutAttachmentPayload })
  | (QueuedOpBase & { type: "delete_attachment"; payload: DeleteAttachmentPayload });

export interface Snapshot {
  version: 1;
  exportedAt: string;
  nodes: Node[];
  attachments: AttachmentMeta[];
  checkpoint: string | null;
}

export interface ImportReport {
  createdNodes: number;
  updatedNodes: number;
  skippedNodes: number;
  attachments: number;
  /** Ids that could not be preserved (already in use by different content). */
  remapped: Array<{ from: string; to: string }>;
  warnings: string[];
}

export interface StorageInfo {
  backend: "memory" | "indexeddb" | "sqlite";
  /** `null` when the platform does not report it. */
  persistent: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  /** Human-readable location of the local data, when the platform has one. */
  location: string | null;
  nodeCount: number;
  attachmentBytes: number;
  pendingOps: number;
}

export interface TreeNode extends Node {
  depth: number;
  children: TreeNode[];
}

export interface AttachmentInput {
  noteId: string | null;
  filename: string;
  bytes: Uint8Array;
  /** Advertised type; validated against a sniffed type before storage. */
  mime?: string;
}
