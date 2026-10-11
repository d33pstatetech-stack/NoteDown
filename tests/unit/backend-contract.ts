import { describe, expect, it } from "vitest";
import type { AttachmentMeta, Node, QueuedOp, StoreBackend } from "@localnotes/shared";

/** Minimal row builders; the contract only cares about round-tripping. */
export function nodeRow(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: "note",
    parentId: "nb",
    title: `Note ${id}`,
    content: `content of ${id}`,
    position: 0,
    contentHash: `hash-${id}`,
    localVersion: 1,
    baseVersion: 0,
    syncState: "local-only",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    conflictOf: null,
    conflictRecordedAt: null,
    ...overrides,
  };
}

export function attachmentRow(id: string, overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id,
    noteId: "n1",
    filename: "diagram.png",
    mime: "image/png",
    ext: "png",
    size: 16,
    sha256: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    syncState: "local-only",
    baseVersion: 0,
    ...overrides,
  };
}

export function opRow(opId: string, entityId: string): QueuedOp {
  return {
    opId,
    entityId,
    type: "upsert_node",
    baseVersion: 0,
    pushedHashes: [],
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      kind: "note",
      parentId: "nb",
      title: "t",
      content: "c",
      position: 0,
      contentHash: "h",
    },
  };
}

/**
 * The `StoreBackend` contract. Every adapter must pass this unchanged, which is
 * what lets one `Store` implementation serve browsers, the desktop SQLite core
 * and tests without behavioural drift.
 */
export function describeBackend(name: string, create: () => Promise<StoreBackend>): void {
  describe(`StoreBackend contract: ${name}`, () => {
    it("starts empty and reports its kind", async () => {
      const backend = await create();
      await backend.init();
      expect(await backend.readNodes()).toEqual([]);
      expect(await backend.readAttachments()).toEqual([]);
      expect(await backend.readQueue()).toEqual([]);
      expect(await backend.readMeta("missing")).toBeNull();
      expect(["memory", "indexeddb", "sqlite"]).toContain(backend.kind);
    });

    it("upserts and deletes node rows in one atomic batch", async () => {
      const backend = await create();
      await backend.init();
      await backend.writeNodes([nodeRow("a"), nodeRow("b")], []);
      expect((await backend.readNodes()).map((n) => n.id).sort()).toEqual(["a", "b"]);

      await backend.writeNodes([nodeRow("b", { title: "renamed" })], ["a"]);
      const rows = await backend.readNodes();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("renamed");
    });

    it("keeps tombstones as rows (deletion is never 'absent')", async () => {
      const backend = await create();
      await backend.init();
      await backend.writeNodes([nodeRow("a", { deletedAt: "2026-02-01T00:00:00.000Z" })], []);
      const rows = await backend.readNodes();
      expect(rows[0]?.deletedAt).toBe("2026-02-01T00:00:00.000Z");
    });

    it("round-trips attachment bytes losslessly", async () => {
      const backend = await create();
      await backend.init();
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      await backend.writeAttachment(attachmentRow("att", { size: bytes.length }), bytes);

      const read = await backend.readAttachmentBytes("att");
      expect(read).not.toBeNull();
      expect(Array.from(read ?? [])).toEqual(Array.from(bytes));
      expect(await backend.readAttachments()).toHaveLength(1);

      // Mutating the returned buffer must not corrupt stored data.
      read?.fill(9);
      expect(Array.from((await backend.readAttachmentBytes("att")) ?? [])).toEqual(
        Array.from(bytes),
      );

      await backend.deleteAttachments(["att"]);
      expect(await backend.readAttachmentBytes("att")).toBeNull();
      expect(await backend.readAttachments()).toEqual([]);
    });

    it("persists the queue and removes acknowledged ops", async () => {
      const backend = await create();
      await backend.init();
      await backend.writeOps([opRow("op1", "a"), opRow("op2", "b")], []);
      expect((await backend.readQueue()).map((o) => o.opId).sort()).toEqual(["op1", "op2"]);

      await backend.writeOps([opRow("op1", "a")], ["op2"]);
      expect((await backend.readQueue()).map((o) => o.opId)).toEqual(["op1"]);
    });

    it("writes and deletes metadata entries", async () => {
      const backend = await create();
      await backend.init();
      await backend.writeMeta([
        { key: "k1", value: "v1" },
        { key: "k2", value: "v2" },
      ]);
      expect(await backend.readMeta("k1")).toBe("v1");
      await backend.writeMeta([{ key: "k1", value: null }]);
      expect(await backend.readMeta("k1")).toBeNull();
      expect(await backend.readMeta("k2")).toBe("v2");
    });

    it("clears everything", async () => {
      const backend = await create();
      await backend.init();
      await backend.writeNodes([nodeRow("a")], []);
      await backend.writeOps([opRow("op1", "a")], []);
      await backend.writeMeta([{ key: "k", value: "v" }]);
      await backend.clear();
      expect(await backend.readNodes()).toEqual([]);
      expect(await backend.readQueue()).toEqual([]);
      expect(await backend.readMeta("k")).toBeNull();
    });

    it("reports storage info", async () => {
      const backend = await create();
      await backend.init();
      const info = await backend.info();
      expect(info).toHaveProperty("persistent");
      expect(info).toHaveProperty("usageBytes");
      expect(info).toHaveProperty("quotaBytes");
    });
  });
}
