import type {
  AttachmentMeta,
  BackendInfo,
  Node,
  QueuedOp,
  StoreBackend,
} from "@localnotes/shared";
import { StorageError } from "@localnotes/shared";

const DB_NAME = "localnotes";
const DB_VERSION = 1;
const STORE_NODES = "nodes";
const STORE_ATTACHMENTS = "attachments";
const STORE_BLOBS = "blobs";
const STORE_QUEUE = "queue";
const STORE_META = "meta";

interface MetaRecord {
  key: string;
  value: string;
}

interface BlobRecord {
  id: string;
  data: Uint8Array;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new StorageError("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new StorageError("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new StorageError("IndexedDB transaction aborted"));
  });
}

export interface IndexedDbBackendOptions {
  /**
   * Injection point for tests (`fake-indexeddb`). Defaults to the global
   * `indexedDB`, so the browser app needs no configuration.
   */
  factory?: IDBFactory;
  databaseName?: string;
  /** Ask the browser for persistent storage on init. */
  requestPersistence?: boolean;
}

/**
 * Browser adapter. One IndexedDB database, five object stores, and every
 * multi-row write inside a single transaction so a browser crash cannot leave a
 * half-applied batch.
 */
export class IndexedDbBackend implements StoreBackend {
  readonly kind = "indexeddb" as const;
  private db: IDBDatabase | null = null;
  private persistent: boolean | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: IndexedDbBackendOptions = {}) {}

  private get factory(): IDBFactory {
    const factory = this.options.factory ?? globalThis.indexedDB;
    if (!factory) {
      throw new StorageError("IndexedDB is not available in this environment");
    }
    return factory;
  }

  async init(): Promise<void> {
    if (this.db) return;
    const databaseName = this.options.databaseName ?? DB_NAME;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.factory.open(databaseName, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE_NODES)) {
          const store = db.createObjectStore(STORE_NODES, { keyPath: "id" });
          store.createIndex("parentId", "parentId");
          store.createIndex("kind", "kind");
          store.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) {
          const store = db.createObjectStore(STORE_ATTACHMENTS, { keyPath: "id" });
          store.createIndex("noteId", "noteId");
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          const store = db.createObjectStore(STORE_QUEUE, { keyPath: "opId" });
          store.createIndex("entityId", "entityId");
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new StorageError("Failed to open IndexedDB"));
      open.onblocked = () => reject(new StorageError("IndexedDB upgrade blocked by another tab"));
    });

    if (this.options.requestPersistence !== false) {
      await this.requestPersistentStorage();
    }
  }

  /**
   * Asks for persistent storage. Denial is normal (Firefox, Safari, private
   * browsing) and must not break the app — the UI surfaces the result instead.
   */
  private async requestPersistentStorage(): Promise<void> {
    try {
      const storage = navigator.storage as StorageManager | undefined;
      if (!storage) {
        this.persistent = null;
        return;
      }
      this.persistent = storage.persisted ? await storage.persisted() : null;
      if (this.persistent === false && typeof storage.persist === "function") {
        this.persistent = await storage.persist();
      }
    } catch (error) {
      this.persistent = null;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private requireDb(): IDBDatabase {
    if (!this.db) throw new StorageError("IndexedDbBackend.init() was not awaited");
    return this.db;
  }

  private store(name: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.requireDb().transaction(name, mode).objectStore(name);
  }

  async readNodes(): Promise<Node[]> {
    const store = this.store(STORE_NODES, "readonly");
    return (await request(store.getAll())) as Node[];
  }

  async writeNodes(nodes: readonly Node[], deletedIds: readonly string[]): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction(STORE_NODES, "readwrite");
    const store = tx.objectStore(STORE_NODES);
    for (const id of deletedIds) store.delete(id);
    for (const node of nodes) store.put(node);
    await transactionDone(tx);
  }

  async readAttachments(): Promise<AttachmentMeta[]> {
    const store = this.store(STORE_ATTACHMENTS, "readonly");
    return (await request(store.getAll())) as AttachmentMeta[];
  }

  async writeAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction([STORE_ATTACHMENTS, STORE_BLOBS], "readwrite");
    tx.objectStore(STORE_ATTACHMENTS).put(meta);
    // Store an independent copy: the caller may reuse its buffer afterwards.
    const record: BlobRecord = { id: meta.id, data: new Uint8Array(bytes) };
    tx.objectStore(STORE_BLOBS).put(record);
    await transactionDone(tx);
  }

  async readAttachmentBytes(id: string): Promise<Uint8Array | null> {
    const store = this.store(STORE_BLOBS, "readonly");
    const record = (await request(store.get(id))) as BlobRecord | undefined;
    if (!record) return null;
    const data = record.data;
    return data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
  }

  async deleteAttachments(ids: readonly string[]): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction([STORE_ATTACHMENTS, STORE_BLOBS], "readwrite");
    const attachments = tx.objectStore(STORE_ATTACHMENTS);
    const blobs = tx.objectStore(STORE_BLOBS);
    for (const id of ids) {
      attachments.delete(id);
      blobs.delete(id);
    }
    await transactionDone(tx);
  }

  async readQueue(): Promise<QueuedOp[]> {
    const store = this.store(STORE_QUEUE, "readonly");
    return (await request(store.getAll())) as QueuedOp[];
  }

  async writeOps(ops: readonly QueuedOp[], ackedOpIds: readonly string[]): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction(STORE_QUEUE, "readwrite");
    const store = tx.objectStore(STORE_QUEUE);
    for (const id of ackedOpIds) store.delete(id);
    for (const op of ops) store.put(op);
    await transactionDone(tx);
  }

  async readMeta(key: string): Promise<string | null> {
    const store = this.store(STORE_META, "readonly");
    const record = (await request(store.get(key))) as MetaRecord | undefined;
    return record?.value ?? null;
  }

  async writeMeta(entries: ReadonlyArray<{ key: string; value: string | null }>): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction(STORE_META, "readwrite");
    const store = tx.objectStore(STORE_META);
    for (const entry of entries) {
      if (entry.value === null) store.delete(entry.key);
      else store.put({ key: entry.key, value: entry.value } satisfies MetaRecord);
    }
    await transactionDone(tx);
  }

  async clear(): Promise<void> {
    const db = this.requireDb();
    const tx = db.transaction(
      [STORE_NODES, STORE_ATTACHMENTS, STORE_BLOBS, STORE_QUEUE, STORE_META],
      "readwrite",
    );
    for (const name of [STORE_NODES, STORE_ATTACHMENTS, STORE_BLOBS, STORE_QUEUE, STORE_META]) {
      tx.objectStore(name).clear();
    }
    await transactionDone(tx);
  }

  async info(): Promise<BackendInfo> {
    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    try {
      const storage = navigator.storage as StorageManager | undefined;
      if (storage?.estimate) {
        const estimate = await storage.estimate();
        usageBytes = estimate.usage ?? null;
        quotaBytes = estimate.quota ?? null;
        if (this.persistent === null && storage.persisted) {
          this.persistent = await storage.persisted();
        }
      }
    } catch {
      // Usage reporting is best-effort.
    }
    return {
      persistent: this.lastError === null ? this.persistent : false,
      usageBytes,
      quotaBytes,
      location: `IndexedDB: ${this.options.databaseName ?? DB_NAME}`,
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
