import type {
  AttachmentMeta,
  BackendInfo,
  Node,
  QueuedOp,
  StoreBackend,
} from "@localnotes/shared";

interface MemoryState {
  nodes: Map<string, Node>;
  attachments: Map<string, AttachmentMeta>;
  bytes: Map<string, Uint8Array>;
  ops: Map<string, QueuedOp>;
  meta: Map<string, string>;
  persistent: boolean | null;
  location: string | null;
}

export interface MemoryBackendOptions {
  persistent?: boolean | null;
  location?: string | null;
  /** Simulate a backend failure on the Nth write to exercise recovery paths. */
  failWritesAfter?: number;
}

/**
 * Deterministic in-process backend. Used by the unit and integration tests and
 * as a fallback when neither IndexedDB nor Tauri is available (for example when
 * rendering the app server-side in a test).
 */
export class MemoryBackend implements StoreBackend {
  readonly kind = "memory" as const;
  private state: MemoryState;
  private writes = 0;

  constructor(private readonly options: MemoryBackendOptions = {}) {
    this.state = {
      nodes: new Map(),
      attachments: new Map(),
      bytes: new Map(),
      ops: new Map(),
      meta: new Map(),
      persistent: options.persistent ?? true,
      location: options.location ?? "memory",
    };
  }

  private maybeFail(): void {
    this.writes += 1;
    if (this.options.failWritesAfter !== undefined && this.writes > this.options.failWritesAfter) {
      throw new Error("simulated backend failure");
    }
  }

  async init(): Promise<void> {
    // nothing to do
  }

  async readNodes(): Promise<Node[]> {
    return [...this.state.nodes.values()].map(cloneNode);
  }

  async writeNodes(nodes: readonly Node[], deletedIds: readonly string[]): Promise<void> {
    // Validate the whole batch before mutating, so the write is all-or-nothing.
    const next = new Map(this.state.nodes);
    for (const id of deletedIds) next.delete(id);
    for (const node of nodes) next.set(node.id, cloneNode(node));
    this.maybeFail();
    this.state.nodes = next;
  }

  async readAttachments(): Promise<AttachmentMeta[]> {
    return [...this.state.attachments.values()].map((meta) => ({ ...meta }));
  }

  async writeAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<void> {
    this.maybeFail();
    this.state.attachments.set(meta.id, { ...meta });
    this.state.bytes.set(meta.id, new Uint8Array(bytes));
  }

  async readAttachmentBytes(id: string): Promise<Uint8Array | null> {
    const bytes = this.state.bytes.get(id);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async deleteAttachments(ids: readonly string[]): Promise<void> {
    this.maybeFail();
    for (const id of ids) {
      this.state.attachments.delete(id);
      this.state.bytes.delete(id);
    }
  }

  async readQueue(): Promise<QueuedOp[]> {
    return [...this.state.ops.values()].map((op) => structuredCloneOp(op));
  }

  async writeOps(ops: readonly QueuedOp[], ackedOpIds: readonly string[]): Promise<void> {
    const next = new Map(this.state.ops);
    for (const id of ackedOpIds) next.delete(id);
    for (const op of ops) next.set(op.opId, structuredCloneOp(op));
    this.maybeFail();
    this.state.ops = next;
  }

  async readMeta(key: string): Promise<string | null> {
    return this.state.meta.get(key) ?? null;
  }

  async writeMeta(entries: ReadonlyArray<{ key: string; value: string | null }>): Promise<void> {
    this.maybeFail();
    for (const entry of entries) {
      if (entry.value === null) this.state.meta.delete(entry.key);
      else this.state.meta.set(entry.key, entry.value);
    }
  }

  async clear(): Promise<void> {
    this.state.nodes.clear();
    this.state.attachments.clear();
    this.state.bytes.clear();
    this.state.ops.clear();
    this.state.meta.clear();
  }

  async info(): Promise<BackendInfo> {
    const usageBytes = [...this.state.bytes.values()].reduce((sum, b) => sum + b.length, 0);
    return {
      persistent: this.state.persistent,
      usageBytes,
      quotaBytes: null,
      location: this.state.location,
    };
  }

  /** Serializes state so a test can simulate an application restart. */
  toJSON(): string {
    const encode = (bytes: Uint8Array) => Array.from(bytes);
    return JSON.stringify({
      nodes: [...this.state.nodes.values()],
      attachments: [...this.state.attachments.values()],
      bytes: [...this.state.bytes.entries()].map(([id, bytes]) => [id, encode(bytes)]),
      ops: [...this.state.ops.values()],
      meta: [...this.state.meta.entries()],
      persistent: this.state.persistent,
      location: this.state.location,
    });
  }

  static fromJSON(json: string, options: MemoryBackendOptions = {}): MemoryBackend {
    const parsed = JSON.parse(json) as {
      nodes: Node[];
      attachments: AttachmentMeta[];
      bytes: Array<[string, number[]]>;
      ops: QueuedOp[];
      meta: Array<[string, string]>;
      persistent: boolean | null;
      location: string | null;
    };
    const backend = new MemoryBackend({
      persistent: parsed.persistent,
      location: parsed.location,
      ...options,
    });
    for (const node of parsed.nodes) backend.state.nodes.set(node.id, node);
    for (const meta of parsed.attachments) backend.state.attachments.set(meta.id, meta);
    for (const [id, bytes] of parsed.bytes) {
      backend.state.bytes.set(id, Uint8Array.from(bytes));
    }
    for (const op of parsed.ops) backend.state.ops.set(op.opId, op);
    for (const [key, value] of parsed.meta) backend.state.meta.set(key, value);
    return backend;
  }
}

function cloneNode(node: Node): Node {
  return { ...node };
}

function structuredCloneOp(op: QueuedOp): QueuedOp {
  return JSON.parse(JSON.stringify(op)) as QueuedOp;
}
