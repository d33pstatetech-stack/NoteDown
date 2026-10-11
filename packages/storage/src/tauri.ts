import type {
  AttachmentMeta,
  BackendInfo,
  Node,
  QueuedOp,
  StoreBackend,
} from "@localnotes/shared";
import { StorageError, fromBase64, toBase64 } from "@localnotes/shared";

/** The subset of Tauri's `invoke` this adapter needs (injectable for tests). */
export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface RawBackendInfo {
  persistent: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
  location: string | null;
}

/**
 * Desktop adapter. Nothing but serialization happens here: the Rust core in
 * `crates/notes-store` owns the SQLite connection, the schema and the
 * transactions. Attachment bytes cross the IPC boundary as base64 because
 * Tauri's default serializer would otherwise expand a `Uint8Array` into a JSON
 * array of numbers (~3.6x larger); the raw-IPC fast path is noted in
 * `docs/DECISIONS.md`.
 */
export class TauriBackend implements StoreBackend {
  readonly kind = "sqlite" as const;

  constructor(private readonly invoke: InvokeFn) {}

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await this.invoke<T>(command, args);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Native storage call failed";
      throw new StorageError(message, { details: { command }, cause: error });
    }
  }

  async init(): Promise<void> {
    await this.call<void>("store_init");
  }

  async readNodes(): Promise<Node[]> {
    return this.call<Node[]>("store_read_nodes");
  }

  async writeNodes(nodes: readonly Node[], deletedIds: readonly string[]): Promise<void> {
    await this.call<void>("store_write_nodes", { nodes, deletedIds });
  }

  async readAttachments(): Promise<AttachmentMeta[]> {
    return this.call<AttachmentMeta[]>("store_read_attachments");
  }

  async writeAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<void> {
    await this.call<void>("store_write_attachment", {
      meta,
      bytesBase64: toBase64(bytes),
    });
  }

  async readAttachmentBytes(id: string): Promise<Uint8Array | null> {
    const encoded = await this.call<string | null>("store_read_attachment_bytes", { id });
    return encoded === null ? null : fromBase64(encoded);
  }

  async deleteAttachments(ids: readonly string[]): Promise<void> {
    await this.call<void>("store_delete_attachments", { ids });
  }

  async readQueue(): Promise<QueuedOp[]> {
    return this.call<QueuedOp[]>("store_read_queue");
  }

  async writeOps(ops: readonly QueuedOp[], ackedOpIds: readonly string[]): Promise<void> {
    await this.call<void>("store_write_ops", { ops, ackedOpIds });
  }

  async readMeta(key: string): Promise<string | null> {
    return this.call<string | null>("store_read_meta", { key });
  }

  async writeMeta(entries: ReadonlyArray<{ key: string; value: string | null }>): Promise<void> {
    await this.call<void>("store_write_meta", { entries });
  }

  async clear(): Promise<void> {
    await this.call<void>("store_clear");
  }

  async info(): Promise<BackendInfo> {
    return this.call<RawBackendInfo>("store_info");
  }
}
