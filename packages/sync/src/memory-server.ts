import { nowIso } from "@localnotes/shared";
import type { AttachmentMeta, DeleteNodePayload, UpsertNodePayload } from "@localnotes/shared";
import type {
  ChangesPage,
  PushOp,
  PushOutcome,
  PushResponse,
  RemoteAttachment,
  RemoteNode,
  RemoteSyncClient,
} from "./client";

export interface MemoryServerOptions {
  userId?: string;
  now?: () => Date;
}

/**
 * In-memory stand-in for the Cloudflare Worker. It implements the same
 * semantics the Worker will: a single monotonic per-user `serverVersion`,
 * `opId` idempotency, conditional writes that return `409` + the server row
 * instead of overwriting, tombstones, and a checkpoint-based change feed.
 *
 * Used by the integration tests to drive two independent clients against one
 * "server", including offline edits, duplicate delivery and partial failures.
 */
export class MemoryRemoteServer implements RemoteSyncClient {
  private version = 0;
  private readonly nodes = new Map<string, RemoteNode>();
  private readonly attachments = new Map<string, { meta: RemoteAttachment; bytes: Uint8Array }>();
  private readonly handled = new Map<string, PushOutcome>();
  private readonly userId: string;
  private readonly now: () => Date;

  /** Set to make the next push/fetch throw once, to exercise retry paths. */
  failNextPush: Error | null = null;
  failNextFetch: Error | null = null;
  failNextUpload: Error | null = null;

  constructor(options: MemoryServerOptions = {}) {
    this.userId = options.userId ?? "user_1";
    this.now = options.now ?? (() => new Date());
  }

  /** Test helper: the raw server row, bypassing ownership. */
  peekNode(id: string): RemoteNode | undefined {
    return this.nodes.get(id);
  }

  peekAttachment(id: string): RemoteAttachment | undefined {
    return this.attachments.get(id)?.meta;
  }

  nodeCount(): number {
    return [...this.nodes.values()].filter((node) => node.deletedAt === null).length;
  }

  private checkpoint(): string {
    return `${this.version}:${this.userId}`;
  }

  async push(ops: readonly PushOp[]): Promise<PushResponse> {
    if (this.failNextPush) {
      const error = this.failNextPush;
      this.failNextPush = null;
      throw error;
    }
    const results: PushOutcome[] = [];
    for (const op of ops) {
      const already = this.handled.get(op.opId);
      if (already) {
        results.push({ ...already, status: "duplicate" });
        continue;
      }
      const outcome = this.apply(op);
      this.handled.set(op.opId, outcome);
      results.push(outcome);
    }
    return { results, checkpoint: this.checkpoint() };
  }

  private apply(op: PushOp): PushOutcome {
    switch (op.type) {
      case "upsert_node": {
        const current = this.nodes.get(op.entityId);
        if (current && current.serverVersion !== op.baseVersion) {
          return { opId: op.opId, status: "conflict", server: current, serverVersion: current.serverVersion };
        }
        const payload = op.payload as UpsertNodePayload;
        if (current?.deletedAt && payload.kind === "note") {
          return { opId: op.opId, status: "conflict", server: current, serverVersion: current.serverVersion };
        }
        const version = ++this.version;
        const timestamp = nowIso(this.now());
        const node: RemoteNode = {
          id: op.entityId,
          kind: payload.kind,
          parentId: payload.parentId,
          title: payload.title,
          content: payload.content,
          position: payload.position,
          contentHash: payload.contentHash,
          serverVersion: version,
          createdAt: current?.createdAt ?? timestamp,
          updatedAt: timestamp,
          deletedAt: null,
          conflictOf: payload.conflictOf ?? null,
        };
        this.nodes.set(node.id, node);
        return { opId: op.opId, status: "applied", serverVersion: version };
      }
      case "delete_node": {
        const current = this.nodes.get(op.entityId);
        if (!current) return { opId: op.opId, status: "applied" };
        if (current.serverVersion !== op.baseVersion) {
          return { opId: op.opId, status: "conflict", server: current, serverVersion: current.serverVersion };
        }
        const payload = op.payload as DeleteNodePayload;
        const version = ++this.version;
        this.nodes.set(op.entityId, {
          ...current,
          deletedAt: payload.deletedAt,
          serverVersion: version,
          updatedAt: payload.deletedAt,
        });
        return { opId: op.opId, status: "applied", serverVersion: version };
      }
      case "put_attachment": {
        const existing = this.attachments.get(op.entityId);
        if (existing && existing.meta.serverVersion !== op.baseVersion) {
          return { opId: op.opId, status: "duplicate", serverVersion: existing.meta.serverVersion };
        }
        const payload = op.payload as {
          mime: string;
          ext: string;
          size: number;
          sha256: string;
          noteId: string | null;
        };
        const version = ++this.version;
        const meta: RemoteAttachment = {
          id: op.entityId,
          noteId: payload.noteId,
          mime: payload.mime,
          ext: payload.ext,
          size: payload.size,
          sha256: payload.sha256,
          serverVersion: version,
        };
        this.attachments.set(op.entityId, {
          meta,
          bytes: existing?.bytes ?? new Uint8Array(0),
        });
        return { opId: op.opId, status: "applied", serverVersion: version };
      }
      case "delete_attachment": {
        if (!this.attachments.has(op.entityId)) return { opId: op.opId, status: "applied" };
        this.attachments.delete(op.entityId);
        return { opId: op.opId, status: "applied", serverVersion: ++this.version };
      }
      default:
        return { opId: op.opId, status: "rejected", error: "unknown operation" };
    }
  }

  async fetchChanges(since: string | null, limit = 200): Promise<ChangesPage> {
    if (this.failNextFetch) {
      const error = this.failNextFetch;
      this.failNextFetch = null;
      throw error;
    }
    const sinceVersion = parseCheckpoint(since)?.version ?? 0;
    const changed = [...this.nodes.values()]
      .filter((node) => node.serverVersion > sinceVersion)
      .sort((a, b) => a.serverVersion - b.serverVersion);
    const page = changed.slice(0, limit);
    const changedAttachments = [...this.attachments.values()]
      .map((entry) => entry.meta)
      .filter((meta) => meta.serverVersion > sinceVersion)
      .sort((a, b) => a.serverVersion - b.serverVersion);
    const highest = Math.max(
      sinceVersion,
      ...page.map((node) => node.serverVersion),
      ...changedAttachments.slice(0, limit).map((meta) => meta.serverVersion),
    );
    this.version = Math.max(this.version, highest);
    return {
      changes: page,
      attachments: changedAttachments.slice(0, limit),
      nextCheckpoint: `${highest}:${this.userId}`,
      hasMore: changed.length > page.length,
    };
  }

  async uploadAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<{ serverVersion: number }> {
    if (this.failNextUpload) {
      const error = this.failNextUpload;
      this.failNextUpload = null;
      throw error;
    }
    const existing = this.attachments.get(meta.id);
    const version = existing ? existing.meta.serverVersion : ++this.version;
    this.attachments.set(meta.id, {
      meta: {
        id: meta.id,
        noteId: meta.noteId,
        mime: meta.mime,
        ext: meta.ext,
        size: bytes.length,
        sha256: meta.sha256,
        serverVersion: version,
      },
      bytes: new Uint8Array(bytes),
    });
    return { serverVersion: version };
  }

  async downloadAttachment(
    id: string,
  ): Promise<{ meta: RemoteAttachment; bytes: Uint8Array } | null> {
    const entry = this.attachments.get(id);
    if (!entry) return null;
    return { meta: entry.meta, bytes: new Uint8Array(entry.bytes) };
  }

  async deleteAttachment(id: string): Promise<void> {
    this.attachments.delete(id);
  }

  /** Test helper: total versions assigned so far. */
  currentVersion(): number {
    return this.version;
  }
}

export function parseCheckpoint(token: string | null): { version: number; user: string } | null {
  if (!token) return null;
  const [version, user] = token.split(":");
  const parsed = Number(version);
  if (!Number.isFinite(parsed)) return null;
  return { version: parsed, user: user ?? "" };
}
