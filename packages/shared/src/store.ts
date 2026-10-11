import { META_KEYS, SCHEMA_VERSION, type BackendInfo, type StoreBackend } from "./backend";
import { nowIso, stampForTitle } from "./clock";
import {
  NotFoundError,
  QuotaExceededError,
  ValidationError,
  VersionConflictError,
} from "./errors";
import { contentHash, sha256Hex } from "./hash";
import { newId } from "./ids";
import { searchNodes, type SearchHit } from "./search";
import {
  assertValidParent,
  buildTree,
  childrenOf,
  findNode,
  liveNodes,
  nextPosition,
  nodePathLabel,
  subtreeIds,
} from "./tree";
import type {
  AttachmentInput,
  AttachmentMeta,
  CreateNodeInput,
  ImportReport,
  Node,
  NodeKind,
  QueuedOp,
  Snapshot,
  StorageInfo,
  SyncState,
  TreeNode,
  UpdateNodePatch,
} from "./types";
import {
  LIMITS,
  extForMime,
  safeFilename,
  validateAttachment,
  validateContent,
  validateTitle,
} from "./validate";

export interface StoreOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export interface RemoteNodeInput {
  id: string;
  /** Provenance of a conflict copy; optional so older payloads still apply. */
  conflictOf?: string | null;
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
}

export type RemoteApplyAction =
  | "created"
  | "updated"
  | "unchanged"
  | "deleted"
  | "rebase"
  | "conflict-copy";

export interface RemoteApplyResult {
  action: RemoteApplyAction;
  nodeId: string;
  conflictCopyId: string | null;
}

export interface ImportSnapshotOptions {
  attachmentBytes?: ReadonlyMap<string, Uint8Array>;
  /** Force fresh ids for every imported object instead of preserving them. */
  regenerateIds?: boolean;
}

const DEFAULT_TITLES: Record<NodeKind, string> = {
  notebook: "Untitled notebook",
  folder: "Untitled folder",
  note: "Untitled note",
};

/**
 * The single place where domain rules live. Every adapter (IndexedDB, SQLite
 * via Tauri, in-memory) only implements `StoreBackend`, so versioning,
 * tombstoning, hashing, ordering and queue coalescing behave identically on
 * every platform and are tested once.
 *
 * One instance per application. Reads are served from an in-memory index that is
 * kept in sync with write-through mutations.
 */
export class Store {
  private readonly nodes = new Map<string, Node>();
  private readonly attachments = new Map<string, AttachmentMeta>();
  private queue: QueuedOp[] = [];
  private loaded = false;

  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    readonly backend: StoreBackend,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.idFactory ?? newId;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.backend.init();
    await this.reload();
    await this.backend.writeMeta([{ key: META_KEYS.schemaVersion, value: SCHEMA_VERSION }]);
  }

  async reload(): Promise<void> {
    const [nodes, attachments, queue] = await Promise.all([
      this.backend.readNodes(),
      this.backend.readAttachments(),
      this.backend.readQueue(),
    ]);
    this.nodes.clear();
    for (const node of nodes) this.nodes.set(node.id, node);
    this.attachments.clear();
    for (const meta of attachments) this.attachments.set(meta.id, meta);
    this.queue = [...queue].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.reload();
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Live nodes only. Tombstones are hidden unless `includeDeleted` is set. */
  async listNodes(options: { includeDeleted?: boolean } = {}): Promise<Node[]> {
    await this.ensureLoaded();
    const all = [...this.nodes.values()];
    return options.includeDeleted ? all : liveNodes(all);
  }

  async getNode(id: string, options: { includeDeleted?: boolean } = {}): Promise<Node | null> {
    await this.ensureLoaded();
    const node = this.nodes.get(id) ?? null;
    if (!node) return null;
    if (node.deletedAt !== null && !options.includeDeleted) return null;
    return node;
  }

  async getTree(options: { includeDeleted?: boolean } = {}): Promise<TreeNode[]> {
    return buildTree(await this.listNodes(options), options);
  }

  async getPathLabel(id: string, separator = " / "): Promise<string> {
    const nodes = await this.listNodes({ includeDeleted: true });
    return nodePathLabel(nodes, id, separator);
  }

  async search(query: string, limit = 50): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    return searchNodes(await this.listNodes(), trimmed, { limit });
  }

  async stats(): Promise<StorageInfo> {
    await this.ensureLoaded();
    const info: BackendInfo = await this.backend.info();
    const nodes = liveNodes([...this.nodes.values()]);
    const attachmentBytes = [...this.attachments.values()].reduce((sum, a) => sum + a.size, 0);
    return {
      backend: this.backend.kind,
      persistent: info.persistent,
      usageBytes: info.usageBytes,
      quotaBytes: info.quotaBytes,
      location: info.location,
      nodeCount: nodes.length,
      attachmentBytes,
      pendingOps: this.queue.length,
    };
  }

  // ── mutations ────────────────────────────────────────────────────────────

  async createNode(input: CreateNodeInput): Promise<Node> {
    await this.ensureLoaded();
    const all = [...this.nodes.values()];
    assertValidParent(all, input.kind, input.parentId);
    if (input.kind !== "note" && (input.content ?? "") !== "") {
      throw new ValidationError(`A ${input.kind} cannot hold Markdown content`);
    }
    const title = validateTitle(input.title ?? DEFAULT_TITLES[input.kind]);
    const content = input.kind === "note" ? validateContent(input.content ?? "") : "";
    const timestamp = nowIso(this.now());
    const node: Node = {
      id: input.id ?? this.createId(),
      kind: input.kind,
      parentId: input.parentId,
      title,
      content,
      position: input.position ?? nextPosition(all, input.parentId),
      contentHash: await contentHash(content),
      localVersion: 1,
      baseVersion: 0,
      syncState: "local-only",
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      conflictOf: null,
      conflictRecordedAt: null,
    };
    if (this.nodes.has(node.id)) {
      throw new ValidationError(`Node id already exists: ${node.id}`, { id: node.id });
    }
    await this.persistNodes([node], []);
    this.nodes.set(node.id, node);
    await this.enqueueUpsert(node);
    return node;
  }

  /**
   * Updates title and/or content. Pass `expectedLocalVersion` (the version the
   * caller last read) to make the write conditional: a stale value raises
   * `VersionConflictError` instead of clobbering a newer edit.
   */
  async updateNode(
    id: string,
    patch: UpdateNodePatch,
    expectedLocalVersion?: number,
  ): Promise<Node> {
    await this.ensureLoaded();
    const current = this.requireLiveNode(id);
    if (expectedLocalVersion !== undefined && expectedLocalVersion !== current.localVersion) {
      throw new VersionConflictError(expectedLocalVersion, current.localVersion);
    }
    const next: Node = { ...current };
    let changed = false;

    if (patch.title !== undefined) {
      const title = validateTitle(patch.title);
      if (title !== current.title) {
        next.title = title;
        changed = true;
      }
    }
    if (patch.content !== undefined) {
      if (current.kind !== "note") {
        throw new ValidationError(`A ${current.kind} cannot hold Markdown content`);
      }
      const content = validateContent(patch.content);
      if (content !== current.content) {
        next.content = content;
        next.contentHash = await contentHash(content);
        changed = true;
      }
    }
    if (!changed) return current;

    next.localVersion = current.localVersion + 1;
    next.updatedAt = nowIso(this.now());
    next.syncState = nextSyncState(current.syncState);
    await this.persistNodes([next], []);
    this.nodes.set(id, next);
    await this.enqueueUpsert(next);
    return next;
  }

  /**
   * Reparents and/or reorders a node. Positions are recomputed for both the
   * source and the target sibling list, so an explicit `position` is honoured
   * exactly and no two siblings share a position.
   */
  async moveNode(id: string, parentId: string | null, position?: number): Promise<Node> {
    await this.ensureLoaded();
    const moving = this.requireLiveNode(id);
    const all = [...this.nodes.values()];
    assertValidParent(all, moving.kind, parentId, moving.id);

    const timestamp = nowIso(this.now());
    const before = new Map(all.map((node) => [node.id, node]));
    const after = new Map(before);

    const reorder = (
      targetParent: string | null,
      insert?: { index: number },
    ): void => {
      const siblings = childrenOf([...after.values()], targetParent).filter(
        (node) => node.id !== id,
      );
      if (insert) {
        const at = Math.max(0, Math.min(insert.index, siblings.length));
        siblings.splice(at, 0, { ...moving, parentId: targetParent });
      }
      siblings.forEach((sibling, index) => {
        const previous = before.get(sibling.id);
        const changed =
          !previous ||
          previous.position !== index ||
          previous.parentId !== targetParent ||
          previous.localVersion !== sibling.localVersion;
        if (!changed) return;
        const base = previous ?? sibling;
        after.set(sibling.id, {
          ...base,
          parentId: targetParent,
          position: index,
          localVersion: base.localVersion + 1,
          updatedAt: timestamp,
          syncState: nextSyncState(base.syncState),
        });
      });
    };

    const siblingsInTarget = childrenOf(all, parentId).filter((node) => node.id !== id);
    const insertAt =
      position === undefined ? siblingsInTarget.length : Math.max(0, Math.min(position, siblingsInTarget.length));

    reorder(parentId, { index: insertAt });
    if (moving.parentId !== parentId) reorder(moving.parentId);

    const upserts = [...after.values()].filter((node) => {
      const previous = before.get(node.id);
      return (
        !previous ||
        previous.position !== node.position ||
        previous.parentId !== node.parentId ||
        previous.localVersion !== node.localVersion
      );
    });

    await this.persistNodes(upserts, []);
    for (const node of upserts) this.nodes.set(node.id, node);
    for (const node of upserts) await this.enqueueUpsert(node);
    return this.requireLiveNode(id);
  }

  async renameNode(id: string, title: string, expectedLocalVersion?: number): Promise<Node> {
    return this.updateNode(id, { title }, expectedLocalVersion);
  }

  /**
   * Tombstones a node and its whole subtree. Deletion is recorded as a tombstone
   * (never as an absent row) so a delete replicates and can never be confused
   * with "not yet downloaded".
   */
  async deleteNode(id: string): Promise<{ deletedIds: string[] }> {
    await this.ensureLoaded();
    const target = this.requireLiveNode(id);
    const all = [...this.nodes.values()];
    const ids = subtreeIds(all, target.id);
    const timestamp = nowIso(this.now());
    const upserts: Node[] = [];
    for (const nodeId of ids) {
      const node = all.find((candidate) => candidate.id === nodeId);
      if (!node || node.deletedAt !== null) continue;
      upserts.push({
        ...node,
        deletedAt: timestamp,
        syncState: "deleted",
        localVersion: node.localVersion + 1,
        updatedAt: timestamp,
      });
    }
    await this.persistNodes(upserts, []);
    for (const node of upserts) this.nodes.set(node.id, node);
    for (const node of upserts) await this.enqueueDelete(node);
    return { deletedIds: upserts.map((node) => node.id) };
  }

  // ── attachments ──────────────────────────────────────────────────────────

  async putAttachment(input: AttachmentInput): Promise<AttachmentMeta> {
    await this.ensureLoaded();
    const mime = validateAttachment(input.bytes);
    const ext = extForMime(mime);
    if (!ext) throw new ValidationError(`Unsupported image type: ${mime}`);
    const total = [...this.attachments.values()].reduce((sum, a) => sum + a.size, 0);
    if (total + input.bytes.length > LIMITS.attachmentTotalBytes) {
      throw new QuotaExceededError("Local attachment storage limit reached", {
        limitBytes: LIMITS.attachmentTotalBytes,
      });
    }
    const id = this.createId();
    const meta: AttachmentMeta = {
      id,
      noteId: input.noteId,
      filename: safeFilename(input.filename, ext),
      mime,
      ext,
      size: input.bytes.length,
      sha256: await sha256Hex(input.bytes),
      createdAt: nowIso(this.now()),
      syncState: "local-only",
      baseVersion: 0,
    };
    await this.backend.writeAttachment(meta, input.bytes);
    this.attachments.set(id, meta);
    await this.enqueuePutAttachment(meta);
    return meta;
  }

  async listAttachments(noteId?: string): Promise<AttachmentMeta[]> {
    await this.ensureLoaded();
    const all = [...this.attachments.values()];
    const filtered = noteId === undefined ? all : all.filter((a) => a.noteId === noteId);
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getAttachment(id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | null> {
    await this.ensureLoaded();
    const meta = this.attachments.get(id);
    if (!meta) return null;
    const bytes = await this.backend.readAttachmentBytes(id);
    if (!bytes) return null;
    return { meta, bytes };
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.attachments.has(id)) throw new NotFoundError("Attachment", id);
    await this.backend.deleteAttachments([id]);
    this.attachments.delete(id);
    const removed = this.queue
      .filter((op) => op.entityId === id && op.type === "put_attachment")
      .map((op) => op.opId);
    if (removed.length > 0) await this.ackOps(removed);
    await this.enqueue({
      entityId: id,
      type: "delete_attachment",
      baseVersion: 0,
      payload: { deletedAt: nowIso(this.now()) },
    });
  }

  // ── change queue ─────────────────────────────────────────────────────────

  async listQueue(): Promise<QueuedOp[]> {
    await this.ensureLoaded();
    return [...this.queue];
  }

  async pendingCount(): Promise<number> {
    await this.ensureLoaded();
    return this.queue.length;
  }

  /**
   * Coalesces at most one op per entity. When a replaced op had already been
   * sent, its content hash is carried into `pushedHashes` so a later 409 can be
   * recognised as "my own earlier write" (rebase) instead of a real conflict.
   *
   * The idempotency key is deliberately re-minted whenever the payload changes.
   * The server records every `opId` it has seen and answers `duplicate` to a
   * replay, so keeping the old key after the payload changed would make the
   * server silently drop the newer edit — the user's text would be acked as
   * "already applied" and never reach any other device.
   */
  private async enqueue(op: EnqueueInput): Promise<QueuedOp> {
    const existingIndex = this.queue.findIndex(
      (candidate) => candidate.entityId === op.entityId && candidate.type === op.type,
    );
    const existing = existingIndex === -1 ? null : (this.queue[existingIndex] as QueuedOp);
    const carried: string[] = op.pushedHashes ? [...op.pushedHashes] : [];
    let payloadChanged = false;
    if (existing) {
      carried.push(...existing.pushedHashes);
      const hash = opPayloadHash(existing);
      // Only a hash we actually handed to the transport can come back to us.
      if (existing.attempts > 0 && hash) carried.push(hash);
      payloadChanged = opRequestFingerprint(existing) !== opRequestFingerprint(op);
    }

    const queued = {
      ...op,
      opId: existing && !payloadChanged ? existing.opId : this.createId(),
      pushedHashes: dedupe(carried),
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      createdAt: existing?.createdAt ?? nowIso(this.now()),
    } as QueuedOp;

    const isNew = existingIndex === -1;
    if (isNew) this.queue.push(queued);
    else this.queue[existingIndex] = queued;
    // When the idempotency key was re-minted the previous row would otherwise
    // linger in the backend and reappear on the next reload.
    const stale = existing && existing.opId !== queued.opId ? [existing.opId] : [];
    await this.backend.writeOps([queued], stale);
    return queued;
  }

  private async enqueueUpsert(node: Node): Promise<void> {
    await this.enqueue({
      entityId: node.id,
      type: "upsert_node",
      baseVersion: node.baseVersion,
      payload: {
        kind: node.kind,
        parentId: node.parentId,
        title: node.title,
        content: node.content,
        position: node.position,
        contentHash: node.contentHash,
        conflictOf: node.conflictOf,
      },
    });
  }

  private async enqueueDelete(node: Node): Promise<void> {
    if (node.deletedAt === null) return;
    await this.enqueue({
      entityId: node.id,
      type: "delete_node",
      baseVersion: node.baseVersion,
      payload: { deletedAt: node.deletedAt },
    });
  }

  private async enqueuePutAttachment(meta: AttachmentMeta): Promise<void> {
    await this.enqueue({
      entityId: meta.id,
      type: "put_attachment",
      baseVersion: meta.baseVersion,
      payload: {
        noteId: meta.noteId,
        mime: meta.mime,
        ext: meta.ext,
        size: meta.size,
        sha256: meta.sha256,
      },
    });
  }

  /**
   * Re-queues the current local state of a node for upload. Used after a rebase
   * (the server echoed an earlier write) and after a conflict copy, so the
   * pending local edit is never dropped.
   */
  async scheduleUpload(id: string): Promise<void> {
    await this.ensureLoaded();
    const node = this.nodes.get(id);
    if (!node || node.deletedAt !== null) return;
    await this.enqueueUpsert(node);
  }

  /**
   * Stores an attachment that arrived from the server, preserving its stable id
   * so Markdown references keep resolving. Never used for local edits, which
   * always get a fresh id.
   */
  async applyRemoteAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<void> {
    await this.ensureLoaded();
    const existing = this.attachments.get(meta.id);
    if (existing && existing.sha256 === meta.sha256 && existing.baseVersion === meta.baseVersion) {
      return;
    }
    const stored: AttachmentMeta = { ...meta, syncState: "synced" };
    await this.backend.writeAttachment(stored, bytes);
    this.attachments.set(stored.id, stored);
    await this.ackOps(
      this.queue.filter((op) => op.entityId === stored.id).map((op) => op.opId),
    );
  }

  /** Records that an op was handed to the transport, for 409 classification. */
  async markOpSent(opId: string): Promise<void> {
    await this.ensureLoaded();
    const index = this.queue.findIndex((op) => op.opId === opId);
    if (index === -1) return;
    const op = this.queue[index] as QueuedOp;
    const hash = opPayloadHash(op);
    const updated = {
      ...op,
      attempts: op.attempts + 1,
      pushedHashes: hash ? dedupe([...op.pushedHashes, hash]) : op.pushedHashes,
    } as QueuedOp;
    this.queue[index] = updated;
    await this.backend.writeOps([updated], []);
  }

  async failOp(opId: string, error: string, nextAttemptAt: string | null): Promise<void> {
    await this.ensureLoaded();
    const index = this.queue.findIndex((op) => op.opId === opId);
    if (index === -1) return;
    const op = this.queue[index] as QueuedOp;
    const updated = { ...op, lastError: error, nextAttemptAt } as QueuedOp;
    this.queue[index] = updated;
    await this.backend.writeOps([updated], []);
  }

  /** Removes acknowledged ops. Called only after a durable local apply/push. */
  async ackOps(opIds: readonly string[]): Promise<void> {
    await this.ensureLoaded();
    const set = new Set(opIds);
    const remaining = this.queue.filter((op) => !set.has(op.opId));
    if (remaining.length === this.queue.length) return;
    this.queue = remaining;
    await this.backend.writeOps([], [...set]);
  }

  async hasPendingOp(entityId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.queue.some((op) => op.entityId === entityId);
  }

  async pendingHashes(entityId: string): Promise<string[]> {
    await this.ensureLoaded();
    return dedupe(
      this.queue.filter((op) => op.entityId === entityId).flatMap((op) => op.pushedHashes),
    );
  }

  // ── sync support ─────────────────────────────────────────────────────────

  async getCheckpoint(): Promise<string | null> {
    await this.ensureLoaded();
    return this.backend.readMeta(META_KEYS.checkpoint);
  }

  async setCheckpoint(token: string | null): Promise<void> {
    await this.backend.writeMeta([{ key: META_KEYS.checkpoint, value: token }]);
  }

  async getMeta(key: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.backend.readMeta(key);
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    await this.backend.writeMeta([{ key, value }]);
  }

  /** Marks local rows as confirmed by the server and clears their queue entries. */
  async markSynced(entries: ReadonlyArray<{ id: string; serverVersion: number }>): Promise<void> {
    await this.ensureLoaded();
    const upserts: Node[] = [];
    const ackedIds: string[] = [];
    for (const entry of entries) {
      const node = this.nodes.get(entry.id);
      if (node) {
        upserts.push({ ...node, baseVersion: entry.serverVersion, syncState: "synced" });
      }
      const attachment = this.attachments.get(entry.id);
      if (attachment) {
        const bytes = await this.backend.readAttachmentBytes(entry.id);
        const synced: AttachmentMeta = {
          ...attachment,
          baseVersion: entry.serverVersion,
          syncState: "synced",
        };
        if (bytes) await this.backend.writeAttachment(synced, bytes);
        this.attachments.set(entry.id, synced);
      }
      for (const op of this.queue) {
        if (op.entityId === entry.id) ackedIds.push(op.opId);
      }
    }
    if (upserts.length > 0) await this.persistNodes(upserts, []);
    for (const node of upserts) this.nodes.set(node.id, node);
    if (ackedIds.length > 0) await this.ackOps(ackedIds);
  }

  /**
   * Applies one remote change. Local unsynced edits are never overwritten: the
   * divergence is preserved as a sibling conflict copy
   * (see docs/SYNC-PROTOCOL.md §5).
   */
  async applyRemoteNode(remote: RemoteNodeInput): Promise<RemoteApplyResult> {
    await this.ensureLoaded();

    if (remote.deletedAt !== null) {
      const local = this.nodes.get(remote.id);
      if (!local || local.deletedAt !== null) {
        return { action: "unchanged", nodeId: remote.id, conflictCopyId: null };
      }
      const all = [...this.nodes.values()];
      const subtree = subtreeIds(all, remote.id);
      const upserts: Node[] = [];
      for (const id of subtree) {
        const node = this.nodes.get(id);
        if (!node || node.deletedAt !== null) continue;
        upserts.push({
          ...node,
          deletedAt: remote.deletedAt,
          syncState: "deleted",
          baseVersion: id === remote.id ? remote.serverVersion : node.baseVersion,
          localVersion: node.localVersion + 1,
          updatedAt: remote.deletedAt,
        });
      }
      await this.persistNodes(upserts, []);
      for (const node of upserts) this.nodes.set(node.id, node);
      await this.ackOps(
        this.queue.filter((op) => subtree.includes(op.entityId)).map((op) => op.opId),
      );
      return { action: "deleted", nodeId: remote.id, conflictCopyId: null };
    }

    const local = this.nodes.get(remote.id);

    // Idempotence: a change at or below the version we already incorporated has
    // been applied. This is what makes duplicate change-feed delivery, and
    // re-applying the payload we just resolved a conflict against, no-ops.
    if (local && local.deletedAt === null && remote.serverVersion <= local.baseVersion) {
      return { action: "unchanged", nodeId: local.id, conflictCopyId: null };
    }

    const dirty = local ? await this.hasPendingOp(local.id) : false;
    const pushed = local ? await this.pendingHashes(local.id) : [];

    if (!local) {
      const created: Node = {
        id: remote.id,
        kind: remote.kind,
        parentId: remote.parentId,
        title: remote.title,
        content: remote.content,
        position: remote.position,
        contentHash: remote.contentHash,
        localVersion: remote.serverVersion,
        baseVersion: remote.serverVersion,
        syncState: "synced",
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
        deletedAt: null,
        conflictOf: remote.conflictOf ?? null,
        conflictRecordedAt: remote.conflictOf ? nowIso(this.now()) : null,
      };
      await this.persistNodes([created], []);
      this.nodes.set(created.id, created);
      return { action: "created", nodeId: created.id, conflictCopyId: null };
    }

    const identical =
      local.contentHash === remote.contentHash &&
      local.title === remote.title &&
      local.parentId === remote.parentId;

    if (!dirty) {
      if (identical) {
        // Same content: only the version pointer needs to move.
        if (local.baseVersion !== remote.serverVersion) {
          const fastForwarded: Node = {
            ...local,
            baseVersion: remote.serverVersion,
            syncState: "synced",
          };
          await this.persistNodes([fastForwarded], []);
          this.nodes.set(local.id, fastForwarded);
        }
        return { action: "unchanged", nodeId: local.id, conflictCopyId: null };
      }
      const updated: Node = {
        ...local,
        kind: remote.kind,
        parentId: remote.parentId,
        title: remote.title,
        content: remote.content,
        position: remote.position,
        contentHash: remote.contentHash,
        baseVersion: remote.serverVersion,
        syncState: "synced",
        updatedAt: remote.updatedAt,
        deletedAt: null,
        conflictOf: remote.conflictOf ?? local.conflictOf,
      };
      await this.persistNodes([updated], []);
      this.nodes.set(updated.id, updated);
      return { action: "updated", nodeId: updated.id, conflictCopyId: null };
    }

    if (identical) {
      await this.markSynced([{ id: local.id, serverVersion: remote.serverVersion }]);
      return { action: "unchanged", nodeId: local.id, conflictCopyId: null };
    }

    if (pushed.includes(remote.contentHash)) {
      // The server is echoing a write this client already sent: local is newer.
      const rebased: Node = { ...local, baseVersion: remote.serverVersion };
      await this.persistNodes([rebased], []);
      this.nodes.set(rebased.id, rebased);
      return { action: "rebase", nodeId: rebased.id, conflictCopyId: null };
    }

    const parentId = remote.parentId ?? local.parentId;
    const timestamp = nowIso(this.now());
    const copy: Node = {
      id: this.createId(),
      kind: remote.kind,
      parentId,
      title: `${local.title} (conflict copy ${stampForTitle(this.now())})`,
      content: remote.content,
      position: nextPosition([...this.nodes.values()], parentId),
      contentHash: remote.contentHash,
      localVersion: remote.serverVersion,
      baseVersion: remote.serverVersion,
      syncState: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      conflictOf: local.id,
      conflictRecordedAt: timestamp,
    };
    const rebased: Node = { ...local, baseVersion: remote.serverVersion, syncState: "pending" };
    await this.persistNodes([copy, rebased], []);
    this.nodes.set(copy.id, copy);
    this.nodes.set(rebased.id, rebased);
    await this.enqueueUpsert(copy);
    return { action: "conflict-copy", nodeId: local.id, conflictCopyId: copy.id };
  }

  // ── snapshot / portability ───────────────────────────────────────────────

  async exportSnapshot(): Promise<Snapshot> {
    await this.ensureLoaded();
    return {
      version: 1,
      exportedAt: nowIso(this.now()),
      nodes: [...this.nodes.values()],
      attachments: [...this.attachments.values()],
      checkpoint: await this.getCheckpoint(),
    };
  }

  /**
   * Merges a snapshot without silently overwriting: an id already in use with
   * different content is imported under a fresh id and remapped, and the remap
   * is reported.
   */
  async importSnapshot(
    snapshot: Snapshot,
    options: ImportSnapshotOptions = {},
  ): Promise<ImportReport> {
    await this.ensureLoaded();
    const report: ImportReport = {
      createdNodes: 0,
      updatedNodes: 0,
      skippedNodes: 0,
      attachments: 0,
      remapped: [],
      warnings: [],
    };
    const idMap = new Map<string, string>();
    const upserts: Node[] = [];

    for (const incoming of orderParentsFirst(snapshot.nodes)) {
      const existing = this.nodes.get(incoming.id);
      const content = incoming.kind === "note" ? incoming.content : "";
      const hash = await contentHash(content);

      if (
        existing &&
        existing.deletedAt === null &&
        existing.contentHash === hash &&
        existing.title === incoming.title &&
        existing.kind === incoming.kind &&
        existing.parentId === incoming.parentId
      ) {
        idMap.set(incoming.id, existing.id);
        report.skippedNodes += 1;
        continue;
      }

      const idTaken = existing !== undefined;
      const nodeId = options.regenerateIds || idTaken ? this.createId() : incoming.id;
      idMap.set(incoming.id, nodeId);
      if (nodeId !== incoming.id) report.remapped.push({ from: incoming.id, to: nodeId });

      const parentId =
        incoming.parentId === null ? null : (idMap.get(incoming.parentId) ?? incoming.parentId);
      const timestamp = nowIso(this.now());
      const node: Node = {
        id: nodeId,
        kind: incoming.kind,
        parentId,
        title: validateTitle(incoming.title),
        content,
        position: incoming.position,
        contentHash: hash,
        localVersion: 1,
        baseVersion: 0,
        syncState: "local-only",
        createdAt: incoming.createdAt || timestamp,
        updatedAt: timestamp,
        deletedAt: null,
        conflictOf: null,
        conflictRecordedAt: null,
      };
      upserts.push(node);
      this.nodes.set(node.id, node);
      report.createdNodes += 1;
    }

    if (upserts.length > 0) {
      await this.persistNodes(upserts, []);
      for (const node of upserts) await this.enqueueUpsert(node);
    }

    const attachmentBytes = options.attachmentBytes;
    for (const meta of snapshot.attachments) {
      if (this.attachments.has(meta.id)) continue;
      const bytes = attachmentBytes?.get(meta.id);
      if (!bytes) {
        report.warnings.push(`Attachment ${meta.id} had no bytes in the archive; skipped`);
        continue;
      }
      const stored: AttachmentMeta = {
        ...meta,
        noteId: meta.noteId === null ? null : (idMap.get(meta.noteId) ?? meta.noteId),
        syncState: "local-only",
        baseVersion: 0,
      };
      await this.backend.writeAttachment(stored, bytes);
      this.attachments.set(stored.id, stored);
      await this.enqueuePutAttachment(stored);
      report.attachments += 1;
    }

    return report;
  }

  async clear(): Promise<void> {
    await this.backend.clear();
    this.nodes.clear();
    this.attachments.clear();
    this.queue = [];
    this.loaded = false;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private requireLiveNode(id: string): Node {
    const node = this.nodes.get(id);
    if (!node || node.deletedAt !== null) throw new NotFoundError("Node", id);
    return node;
  }

  private async persistNodes(upserts: readonly Node[], deletes: readonly string[]): Promise<void> {
    await this.backend.writeNodes(upserts, deletes);
  }

  /** Live children of a parent. */
  async children(parentId: string | null): Promise<Node[]> {
    return childrenOf(await this.listNodes(), parentId);
  }

  async findByTitle(title: string): Promise<Node | null> {
    const needle = title.trim().toLowerCase();
    return (await this.listNodes()).find((node) => node.title.toLowerCase() === needle) ?? null;
  }

  async exists(id: string): Promise<boolean> {
    return findNode(await this.listNodes(), id) !== null;
  }

  /** Used by the export pipeline to resolve attachment references. */
  async resolveAttachmentPath(reference: string): Promise<AttachmentMeta | null> {
    const byId = this.attachments.get(reference) ?? null;
    if (byId) return byId;
    const byFilename = [...this.attachments.values()].find(
      (meta) => meta.filename === reference,
    );
    return byFilename ?? null;
  }
}

// ── module helpers ─────────────────────────────────────────────────────────

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EnqueueInput = DistributiveOmit<
  QueuedOp,
  "opId" | "attempts" | "lastError" | "nextAttemptAt" | "createdAt" | "pushedHashes"
> & { pushedHashes?: string[] };

function nextSyncState(current: SyncState): SyncState {
  if (current === "local-only" || current === "deleted") return current;
  if (current === "conflict") return "conflict";
  return "pending";
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Picks `type`/`payload` off a queued op while preserving the discriminated
 * union. A plain `Pick<QueuedOp, "type" | "payload">` collapses the union into
 * `{ type: A|B|C; payload: A|B|C }`, which destroys the narrowing that lets the
 * compiler check each op's payload against its own type.
 */
type OpShape = QueuedOp extends infer T
  ? T extends QueuedOp
    ? Pick<T, "type" | "payload">
    : never
  : never;

function opPayloadHash(op: OpShape | null): string | null {
  if (!op) return null;
  if (op.type === "upsert_node") return op.payload.contentHash;
  return null;
}

/**
 * Identity of an op's *request*, used only to decide whether a coalesced op
 * still describes the same thing. `contentHash` alone is not enough: a rename or
 * a move changes the payload without changing the content hash, and replaying
 * such an op under its old idempotency key would make the server answer
 * `duplicate` and drop it.
 */
function opRequestFingerprint(op: OpShape): string {
  return JSON.stringify([op.type, op.payload]);
}

/** Stable topological order: a parent is always imported before its children. */
export function orderParentsFirst(nodes: readonly Node[]): Node[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const out: Node[] = [];
  const visit = (node: Node): void => {
    if (visited.has(node.id)) return;
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (parent) visit(parent);
    visited.add(node.id);
    out.push(node);
  };
  for (const node of nodes) visit(node);
  return out;
}
