import { describe, expect, it } from "vitest";
import { MemoryBackend, Store } from "./helpers";
import { newId, sha256Hex } from "@localnotes/shared";
import type { Node, Snapshot } from "@localnotes/shared";

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function make(backend = new MemoryBackend(), now = "2026-01-01T00:00:00.000Z") {
  return new Store(backend, { now: () => new Date(now), idFactory: ids() });
}

describe("Store — durable local change queue", () => {
  it("enqueues exactly one coalesced op per entity", async () => {
    const store = make();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id, content: "a" });
    await store.updateNode(note.id, { content: "b" }, note.localVersion);
    const reloaded = await store.getNode(note.id);
    await store.updateNode(note.id, { content: "c" }, reloaded?.localVersion);

    const queue = await store.listQueue();
    const forNote = queue.filter((op) => op.entityId === note.id);
    expect(forNote).toHaveLength(1);
    const op = forNote[0];
    expect(op?.type).toBe("upsert_node");
    if (op?.type === "upsert_node") expect(op.payload.content).toBe("c");
  });

  it("survives an application restart (queue is persisted, not in memory)", async () => {
    const backend = new MemoryBackend();
    const store = make(backend);
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id, content: "offline edit" });

    // Simulate a quit/relaunch: a brand new Store over the persisted bytes.
    const restarted = make(MemoryBackend.fromJSON(backend.toJSON()));
    await restarted.init();
    const pending = await restarted.listQueue();
    expect(pending).toHaveLength(2);
    expect((await restarted.getNode(note.id))?.content).toBe("offline edit");
    expect(pending.every((op) => op.attempts === 0)).toBe(true);
  });

  it("records retries with backoff and keeps the op until acknowledged", async () => {
    const store = make();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const [op] = await store.listQueue();
    expect(op).toBeDefined();
    if (!op) throw new Error("expected an op");

    await store.markOpSent(op.opId);
    await store.failOp(op.opId, "network down", "2026-01-01T00:01:00.000Z");
    let queued = (await store.listQueue()).find((candidate) => candidate.opId === op.opId);
    expect(queued?.attempts).toBe(1);
    expect(queued?.lastError).toBe("network down");
    expect(queued?.nextAttemptAt).toBe("2026-01-01T00:01:00.000Z");

    // Retrying is idempotent: the same opId is re-sent, never duplicated.
    await store.markOpSent(op.opId);
    await store.markOpSent(op.opId);
    expect((await store.listQueue()).filter((c) => c.opId === op.opId)).toHaveLength(1);

    await store.ackOps([op.opId]);
    expect((await store.listQueue()).find((c) => c.opId === op.opId)).toBeUndefined();
    expect(await store.getNode(nb.id)).not.toBeNull();
  });

  it("carries sent hashes so a rebase can be told from a real conflict", async () => {
    const store = make();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id, content: "v1" });
    const first = (await store.listQueue()).find((op) => op.entityId === note.id);
    if (!first) throw new Error("expected an op for the note");

    // First version is handed to the transport...
    await store.markOpSent(first.opId);
    expect(await store.pendingHashes(note.id)).toEqual([await sha256Hex("v1")]);

    // ...then the user edits again. The coalesced op still remembers the hash it
    // already sent, which is what makes a later 409 identifiable as our own write.
    await store.updateNode(note.id, { content: "v2" }, note.localVersion);
    const hashes = await store.pendingHashes(note.id);
    expect(hashes).toEqual([await sha256Hex("v1")]);

    // A never-sent edit must not claim its hash was pushed.
    const store2 = make();
    await store2.init();
    const nb2 = await store2.createNode({ kind: "notebook", parentId: null });
    const note2 = await store2.createNode({ kind: "note", parentId: nb2.id, content: "x" });
    await store2.updateNode(note2.id, { content: "y" }, note2.localVersion);
    expect(await store2.pendingHashes(note2.id)).toEqual([]);
  });

  it("enqueues delete operations for every tombstoned descendant", async () => {
    const store = make();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const folder = await store.createNode({ kind: "folder", parentId: nb.id });
    const note = await store.createNode({ kind: "note", parentId: folder.id });
    await store.ackOps((await store.listQueue()).map((op) => op.opId));

    await store.deleteNode(folder.id);
    const queue = await store.listQueue();
    expect(queue.map((op) => op.type)).toEqual(["delete_node", "delete_node"]);
    expect(queue.map((op) => op.entityId).sort()).toEqual([folder.id, note.id].sort());
    for (const op of queue) {
      if (op.type === "delete_node") expect(op.payload.deletedAt).not.toBeNull();
    }
  });

  it("drops a pending upload when the attachment is deleted locally", async () => {
    const store = make();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const meta = await store.putAttachment({
      noteId: nb.id,
      filename: "a.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    await store.deleteAttachment(meta.id);
    const queue = await store.listQueue();
    expect(queue.some((op) => op.type === "put_attachment")).toBe(false);
    expect(queue.some((op) => op.type === "delete_attachment")).toBe(true);
  });

  it("persists and restores the sync checkpoint", async () => {
    const backend = new MemoryBackend();
    const store = make(backend);
    await store.init();
    expect(await store.getCheckpoint()).toBeNull();
    await store.setCheckpoint("4312:user_1");
    const restarted = make(MemoryBackend.fromJSON(backend.toJSON()));
    await restarted.init();
    expect(await restarted.getCheckpoint()).toBe("4312:user_1");
  });
});

describe("Store — snapshot export/import", () => {
  async function seeded() {
    const store = make();
    await store.init();
    const backend = store.backend as MemoryBackend;
    const nb = await store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const folder = await store.createNode({ kind: "folder", parentId: nb.id, title: "Design" });
    const note = await store.createNode({
      kind: "note",
      parentId: folder.id,
      title: "Architecture",
      content: "![d](attachments/abc.png)",
    });
    const meta = await store.putAttachment({
      noteId: note.id,
      filename: "diagram.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    return { store, backend, nb, folder, note, meta };
  }

  it("round-trips a snapshot into an empty store, preserving ids and structure", async () => {
    const a = await seeded();
    const snapshot = await a.store.exportSnapshot();
    const bytes = new Map<string, Uint8Array>();
    for (const meta of snapshot.attachments) {
      const read = await a.store.getAttachment(meta.id);
      if (read) bytes.set(meta.id, read.bytes);
    }

    const target = make();
    await target.init();
    const report = await target.importSnapshot(snapshot, { attachmentBytes: bytes });
    expect(report.createdNodes).toBe(3);
    expect(report.attachments).toBe(1);
    expect(report.remapped).toEqual([]);

    const imported = await target.getTree();
    expect(imported[0]?.title).toBe("Work");
    expect(imported[0]?.children[0]?.children[0]?.content).toBe("![d](attachments/abc.png)");
    expect(await target.getAttachment(a.meta.id)).not.toBeNull();
  });

  it("re-importing the same snapshot is idempotent (no duplicate notes)", async () => {
    const a = await seeded();
    const snapshot = await a.store.exportSnapshot();
    const first = await a.store.importSnapshot(snapshot);
    const second = await a.store.importSnapshot(snapshot);
    expect(first.skippedNodes).toBe(3);
    expect(second.skippedNodes).toBe(3);
    expect(await a.store.listNodes()).toHaveLength(3);
  });

  it("remaps colliding ids instead of overwriting different content", async () => {
    const a = await seeded();
    const snapshot = await a.store.exportSnapshot();

    const b = make();
    await b.init();
    // Same id, different content already present locally.
    const clash: Node = { ...snapshot.nodes[2]!, content: "local content", contentHash: "different" };
    await b.importSnapshot({ ...snapshot, nodes: [clash], attachments: [] } as Snapshot);
    const existing = await b.getNode(snapshot.nodes[2]!.id);
    expect(existing?.content).toBe("local content");

    const report = await b.importSnapshot(snapshot);
    expect(report.remapped.length).toBeGreaterThan(0);
    expect(report.createdNodes).toBe(3);
    // The original local note is untouched, and the import is a separate note.
    expect((await b.getNode(snapshot.nodes[2]!.id))?.content).toBe("local content");
    expect((await b.listNodes()).length).toBe(4);
  });

  it("can regenerate every id for a clean-slate import", async () => {
    const a = await seeded();
    const snapshot = await a.store.exportSnapshot();
    // Real UUIDs here: a second deterministic counter would collide with the
    // snapshot's ids and mask the regeneration being tested.
    const b = new Store(new MemoryBackend(), { idFactory: newId });
    await b.init();
    const report = await b.importSnapshot(snapshot, { regenerateIds: true });
    expect(report.createdNodes).toBe(3);
    expect(report.remapped).toHaveLength(3);
    const ids = (await b.listNodes()).map((n) => n.id);
    expect(ids).not.toContain(a.note.id);
  });

  it("warns instead of failing when an attachment has no bytes", async () => {
    const a = await seeded();
    const snapshot = await a.store.exportSnapshot();
    const b = make();
    await b.init();
    const report = await b.importSnapshot(snapshot);
    expect(report.attachments).toBe(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/skipped/);
  });
});
