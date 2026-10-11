import type { AttachmentMeta, NodeKind, OpType, SyncState } from "@localnotes/shared";

/** A node as the server sees it. `serverVersion` is assigned by the server. */
export interface RemoteNode {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  title: string;
  content: string;
  position: number;
  contentHash: string;
  serverVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Provenance of a conflict copy, when the server knows it. */
  conflictOf?: string | null;
}

export interface RemoteAttachment {
  id: string;
  noteId: string | null;
  mime: string;
  ext: string;
  size: number;
  sha256: string;
  serverVersion: number;
}

export interface PushOp {
  opId: string;
  type: OpType;
  entityId: string;
  baseVersion: number;
  payload: unknown;
  /** Content hashes this client has already sent for the entity (see protocol §5). */
  pushedHashes: string[];
}

export type PushOutcomeStatus = "applied" | "duplicate" | "conflict" | "rejected";

export interface PushOutcome {
  opId: string;
  status: PushOutcomeStatus;
  serverVersion?: number;
  /** Present on `conflict`: the server's current row, never a silent overwrite. */
  server?: RemoteNode;
  error?: string;
}

export interface PushResponse {
  results: PushOutcome[];
  checkpoint: string | null;
}

export interface ChangesPage {
  changes: RemoteNode[];
  attachments: RemoteAttachment[];
  nextCheckpoint: string | null;
  hasMore: boolean;
}

/**
 * The sync transport. Deliberately small and fully mockable: the engine is
 * tested against an in-memory implementation, and `HttpRemoteClient` is the only
 * place that knows about HTTP.
 */
export interface RemoteSyncClient {
  push(ops: readonly PushOp[]): Promise<PushResponse>;
  fetchChanges(since: string | null, limit?: number): Promise<ChangesPage>;
  uploadAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<{ serverVersion: number }>;
  downloadAttachment(id: string): Promise<{ meta: RemoteAttachment; bytes: Uint8Array } | null>;
  deleteAttachment(id: string): Promise<void>;
}

export interface RemoteNodeSnapshot {
  state: SyncState;
  localVersion: number;
}
