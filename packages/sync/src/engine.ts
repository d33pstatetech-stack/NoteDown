import { errorMessage, nowIso } from "@localnotes/shared";
import type { AttachmentMeta, Store } from "@localnotes/shared";
import type {
  PushOp,
  RemoteAttachment,
  RemoteNode,
  RemoteSyncClient,
} from "./client";
import { isAuthError, isOfflineError, nextAttemptDelay } from "./errors";
import type { SyncReport, SyncStateName, SyncStatusSnapshot } from "./status";

export interface SyncEngineOptions {
  store: Store;
  /** Omitted (or null) means "not configured": the engine stays `disabled`. */
  client?: RemoteSyncClient | null;
  batchSize?: number;
  now?: () => Date;
  random?: () => number;
}

const EMPTY_REPORT: SyncReport = {
  pushed: 0,
  applied: 0,
  conflicts: 0,
  downloaded: 0,
  pushedAttachments: 0,
  downloadedAttachments: 0,
};

/**
 * Drives synchronization. Order matters and is enforced here:
 *
 *  1. **push** queued local operations (each marked sent first, so a 409 can be
 *     classified as "our own earlier write" rather than a real conflict),
 *  2. **pull** changes since the checkpoint and apply them incrementally,
 *  3. advance the checkpoint only after a durable local apply.
 *
 * A failed cloud operation never discards a local edit: the queue entry stays
 * with a backoff timestamp until the server acknowledges it.
 */
export class SyncEngine {
  private readonly store: Store;
  private readonly client: RemoteSyncClient | null;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly listeners = new Set<(status: SyncStatusSnapshot) => void>();

  private state: SyncStateName;
  private pending = 0;
  private error: string | null = null;
  private lastSyncedAt: string | null = null;
  private conflicts = 0;
  private inFlight: Promise<SyncReport> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.client = options.client ?? null;
    this.batchSize = options.batchSize ?? 50;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.state = this.client ? "idle" : "disabled";
  }

  status(): SyncStatusSnapshot {
    return {
      state: this.state,
      pending: this.pending,
      lastSyncedAt: this.lastSyncedAt,
      error: this.error,
      conflicts: this.conflicts,
    };
  }

  subscribe(listener: (status: SyncStatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: SyncStateName, error: string | null = null): void {
    this.state = state;
    this.error = error;
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async refreshPending(): Promise<void> {
    this.pending = await this.store.pendingCount();
  }

  /** Runs one full cycle; concurrent calls share the same in-flight run. */
  async run(): Promise<SyncReport> {
    if (!this.client) {
      await this.refreshPending();
      this.setState("disabled");
      return EMPTY_REPORT;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.cycle().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async cycle(): Promise<SyncReport> {
    await this.refreshPending();
    this.setState("syncing");
    const report: SyncReport = { ...EMPTY_REPORT };
    try {
      const pushed = await this.pushOnce();
      report.pushed = pushed.pushed;
      report.pushedAttachments = pushed.attachments;
      report.conflicts += pushed.conflicts;

      const pulled = await this.pullOnce();
      report.applied = pulled.applied;
      report.downloaded = pulled.downloaded;
      report.downloadedAttachments = pulled.downloadedAttachments;
      report.conflicts += pulled.conflicts;

      await this.store.setMeta("sync.lastSyncedAt", nowIso(this.now()));
      this.lastSyncedAt = nowIso(this.now());
      await this.refreshPending();
      this.setState(this.pending > 0 ? "idle" : "idle");
      return report;
    } catch (error) {
      // A wholesale transport failure still has to schedule the retry: without
      // a backoff the next run would hammer a server that is not there.
      await this.penalizeQueue(errorMessage(error));
      await this.refreshPending();
      if (isOfflineError(error)) {
        this.setState("offline", errorMessage(error));
      } else if (isAuthError(error)) {
        this.setState("error", "Sign in again to sync. Your local notes are unaffected.");
      } else {
        this.setState("error", errorMessage(error));
      }
      return report;
    }
  }

  /** Applies a backoff to every op that is currently ready to send. */
  private async penalizeQueue(message: string): Promise<void> {
    const queue = await this.store.listQueue();
    for (const op of queue) {
      if (op.nextAttemptAt !== null) continue;
      await this.store.failOp(op.opId, message, this.backoffIso(op.attempts));
    }
  }

  private async pushOnce(): Promise<{
    pushed: number;
    attachments: number;
    conflicts: number;
  }> {
    const client = this.client;
    if (!client) return { pushed: 0, attachments: 0, conflicts: 0 };
    const queue = await this.store.listQueue();
    const nowMs = this.now().getTime();
    const ready = queue.filter(
      (op) => op.nextAttemptAt === null || Date.parse(op.nextAttemptAt) <= nowMs,
    );
    const batch = ready.slice(0, this.batchSize);
    if (batch.length === 0) return { pushed: 0, attachments: 0, conflicts: 0 };

    let attachments = 0;
    // Attachment bytes are uploaded before their metadata op is marked done, so
    // a note is never advertised before its image exists for other devices.
    for (const op of batch.filter((candidate) => candidate.type === "put_attachment")) {
      await this.store.markOpSent(op.opId);
      const local = await this.store.getAttachment(op.entityId);
      if (!local) {
        await this.store.ackOps([op.opId]);
        continue;
      }
      try {
        const uploaded = await client.uploadAttachment(local.meta, local.bytes);
        await this.store.markSynced([{ id: op.entityId, serverVersion: uploaded.serverVersion }]);
        attachments += 1;
      } catch (error) {
        await this.store.failOp(
          op.opId,
          errorMessage(error),
          this.backoffIso(op.attempts),
        );
        if (isOfflineError(error) || isAuthError(error)) throw error;
      }
    }

    const nodeOps = batch.filter((candidate) => candidate.type !== "put_attachment");
    if (nodeOps.length === 0) {
      await this.refreshPending();
      return { pushed: 0, attachments, conflicts: 0 };
    }

    const ops: PushOp[] = nodeOps.map((op) => ({
      opId: op.opId,
      type: op.type,
      entityId: op.entityId,
      baseVersion: op.baseVersion,
      payload: op.payload,
      pushedHashes: op.pushedHashes,
    }));

    // Mark as sent *before* the request so the hash is recorded even if the
    // response never arrives (that is what makes 409 classification possible).
    for (const op of batch) await this.store.markOpSent(op.opId);

    const response = await client.push(ops);
    let pushed = 0;
    let conflicts = 0;

    for (const outcome of response.results) {
      const op = nodeOps.find((candidate) => candidate.opId === outcome.opId);
      if (!op) continue;

      if (outcome.status === "applied" || outcome.status === "duplicate") {
        pushed += 1;
        if (outcome.serverVersion !== undefined) {
          await this.store.markSynced([
            { id: op.entityId, serverVersion: outcome.serverVersion },
          ]);
        } else {
          await this.store.ackOps([op.opId]);
        }
        continue;
      }

      if (outcome.status === "conflict") {
        if (!outcome.server) {
          await this.store.failOp(
            op.opId,
            "server reported a conflict without its current version",
            this.backoffIso(op.attempts),
          );
          continue;
        }
        const applied = await this.store.applyRemoteNode(outcome.server);
        await this.store.ackOps([op.opId]);
        if (applied.action === "rebase" || applied.action === "conflict-copy") {
          // Keep the local edit: re-queue it against the new base version.
          await this.store.scheduleUpload(op.entityId);
          if (applied.action === "conflict-copy") conflicts += 1;
        } else if (applied.action === "updated" || applied.action === "unchanged") {
          // Remote already had our content; nothing left to send.
        }
        continue;
      }

      await this.store.failOp(
        op.opId,
        outcome.error ?? "the server rejected this change",
        this.backoffIso(op.attempts),
      );
    }

    await this.refreshPending();
    return { pushed, attachments, conflicts };
  }

  private async pullOnce(): Promise<{
    applied: number;
    downloaded: number;
    downloadedAttachments: number;
    conflicts: number;
  }> {
    const client = this.client;
    if (!client) return { applied: 0, downloaded: 0, downloadedAttachments: 0, conflicts: 0 };
    let checkpoint = await this.store.getCheckpoint();
    let applied = 0;
    let downloadedAttachments = 0;
    let conflicts = 0;
    let hasMore = true;
    let pages = 0;

    while (hasMore && pages < 50) {
      pages += 1;
      const page = await client.fetchChanges(checkpoint, this.batchSize);
      for (const change of page.changes) {
        const result = await this.store.applyRemoteNode(change);
        applied += 1;
        if (result.action === "conflict-copy") conflicts += 1;
      }
      for (const meta of page.attachments) {
        const existing = await this.store.getAttachment(meta.id);
        if (existing) continue;
        const remote = await client.downloadAttachment(meta.id);
        if (!remote) continue;
        await this.store.applyRemoteAttachment(toLocalAttachment(remote.meta, this.now()), remote.bytes);
        downloadedAttachments += 1;
      }
      if (page.nextCheckpoint) {
        checkpoint = page.nextCheckpoint;
        // Persisted only after everything above was applied locally.
        await this.store.setCheckpoint(checkpoint);
      }
      hasMore = page.hasMore;
    }

    return { applied, downloaded: applied, downloadedAttachments, conflicts };
  }

  private backoffIso(attempts: number): string {
    const delay = nextAttemptDelay(attempts + 1, this.random);
    return new Date(this.now().getTime() + delay).toISOString();
  }

  /** Periodic sync while the app is open. Returns a stop function. */
  start(options: { intervalMs?: number } = {}): () => void {
    if (!this.client) return () => undefined;
    const intervalMs = options.intervalMs ?? 60_000;
    this.stop();
    void this.run();
    this.timer = setInterval(() => {
      void this.run();
    }, intervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  return new SyncEngine(options);
}

/** Convenience for the shells: a disabled engine when no client is configured. */
export function createLocalOnlyEngine(store: Store): SyncEngine {
  return new SyncEngine({ store, client: null });
}

export function toLocalAttachment(meta: RemoteAttachment, now: Date): AttachmentMeta {
  return {
    id: meta.id,
    noteId: meta.noteId,
    // The server stores bytes, not display names; the reference is what matters.
    filename: `${meta.id}.${meta.ext}`,
    mime: meta.mime,
    ext: meta.ext,
    size: meta.size,
    sha256: meta.sha256,
    createdAt: now.toISOString(),
    syncState: "synced",
    baseVersion: meta.serverVersion,
  };
}

export type { RemoteNode };
