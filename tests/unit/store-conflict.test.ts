import { describe, expect, it } from "vitest";
import { MemoryBackend, Store } from "./helpers";
import type { Node } from "@localnotes/shared";

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function make(backend = new MemoryBackend(), now = "2026-01-01T00:00:00.000Z") {
  return new Store(backend, { now: () => new Date(now), idFactory: ids() });
}

async function remote(node: Node, serverVersion: number) {
  return {
    id: node.id,
    kind: node.kind,
    parentId: node.parentId,
    title: node.title,
    content: node.content,
    position: node.position,
    contentHash: node.contentHash,
    serverVersion,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    deletedAt: node.deletedAt,
  };
}

async function seed() {
  const store = make();
  await store.init();
  const nb = await store.createNode({ kind: "notebook", parentId: null, title: "Work" });
  const note = await store.createNode({
    kind: "note",
    parentId: nb.id,
    title: "Plan",
    content: "local",
  });
  return { store, nb, note };
}

describe("Store — applying remote changes", () => {
  it("creates nodes it has never seen and records them as synced", async () => {
    const store = make();
    await store.init();
    const result = await store.applyRemoteNode({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "notebook",
      parentId: null,
      title: "From other device",
      content: "",
      position: 0,
      contentHash: "h",
      serverVersion: 9,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    expect(result.action).toBe("created");
    const created = await store.getNode(result.nodeId);
    expect(created?.syncState).toBe("synced");
    expect(created?.baseVersion).toBe(9);
    expect(await store.pendingCount()).toBe(0);
  });

  it("fast-forwards a clean local copy", async () => {
    const { store, note } = await seed();
    // Make the local copy clean first: a never-synced node is by definition a
    // local edit, and remote changes must never win over an unsynced edit.
    await store.markSynced([{ id: note.id, serverVersion: 1 }]);
    const result = await store.applyRemoteNode(
      await remote({ ...note, content: "server text", contentHash: "h-remote" }, 4),
    );
    expect(result.action).toBe("updated");
    const updated = await store.getNode(note.id);
    expect(updated?.content).toBe("server text");
    expect(updated?.baseVersion).toBe(4);
    expect(updated?.syncState).toBe("synced");
  });

  it("treats an identical payload as a no-op even when versions differ", async () => {
    const { store, nb, note } = await seed();
    await store.markSynced([
      { id: nb.id, serverVersion: 1 },
      { id: note.id, serverVersion: 1 },
    ]);
    const result = await store.applyRemoteNode(await remote(nb, 2));
    expect(result.action).toBe("unchanged");
    expect(await store.pendingCount()).toBe(0);
  });

  it("preserves BOTH versions when two devices edited the same note", async () => {
    const { store, note } = await seed();
    const result = await store.applyRemoteNode(
      await remote({ ...note, content: "remote text", contentHash: "h-remote" }, 7),
    );

    expect(result.action).toBe("conflict-copy");
    expect(result.conflictCopyId).not.toBeNull();

    // Local edit survives untouched.
    const local = await store.getNode(note.id);
    expect(local?.content).toBe("local");

    // The other device's text is preserved verbatim in a labelled sibling.
    const copy = await store.getNode(result.conflictCopyId ?? "");
    expect(copy?.content).toBe("remote text");
    expect(copy?.title).toMatch(/conflict copy/);
    expect(copy?.conflictOf).toBe(note.id);
    expect(copy?.baseVersion).toBe(7);
    // The conflict copy is queued for upload so the other device sees it too.
    expect(await store.hasPendingOp(result.conflictCopyId ?? "")).toBe(true);
  });

  it("rebases instead of conflicting when the remote text is our own earlier write", async () => {
    const { store, nb, note } = await seed();
    await store.ackOps((await store.listQueue()).map((op) => op.opId));
    const first = await store.updateNode(note.id, { content: "v2" }, note.localVersion);
    const op = (await store.listQueue()).find((candidate) => candidate.entityId === note.id);
    if (!op) throw new Error("expected op");
    await store.markOpSent(op.opId);
    await store.updateNode(note.id, { content: "v3" }, first.localVersion);

    // The server echoes back the intermediate "v2" this client already pushed.
    const echo = { ...note, content: "v2", contentHash: await hashOf("v2") };
    const result = await store.applyRemoteNode(await remote(echo, 11));
    expect(result.action).toBe("rebase");
    const rebased = await store.getNode(note.id);
    expect(rebased?.content).toBe("v3");
    expect(rebased?.baseVersion).toBe(11);
    expect(await store.pendingCount()).toBeGreaterThan(0);
    expect(await store.getNode(nb.id)).not.toBeNull();
  });

  it("applies a tombstone to the whole local subtree", async () => {
    const { store, nb } = await seed();
    const folder = await store.createNode({ kind: "folder", parentId: nb.id });
    const child = await store.createNode({ kind: "note", parentId: folder.id });
    await store.ackOps((await store.listQueue()).map((op) => op.opId));

    const tombstone = await store.applyRemoteNode({
      ...(await remote(nb, 12)),
      deletedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(tombstone.action).toBe("deleted");
    for (const id of [nb.id, folder.id, child.id]) {
      expect(await store.getNode(id)).toBeNull();
      expect((await store.getNode(id, { includeDeleted: true }))?.syncState).toBe("deleted");
    }
  });

  it("ignores a tombstone for a note it never had (never invents a deletion)", async () => {
    const { store, nb } = await seed();
    const result = await store.applyRemoteNode({
      ...(await remote(nb, 13)),
      id: "22222222-2222-4222-8222-222222222222",
      deletedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(result.action).toBe("unchanged");
    expect(await store.listNodes()).toHaveLength(2);
  });

  it("marks rows synced and clears their queue entries", async () => {
    const { store, nb, note } = await seed();
    expect(await store.pendingCount()).toBe(2);
    await store.markSynced([
      { id: nb.id, serverVersion: 3 },
      { id: note.id, serverVersion: 4 },
    ]);
    expect(await store.pendingCount()).toBe(0);
    expect((await store.getNode(note.id))?.syncState).toBe("synced");
  });
});

async function hashOf(text: string): Promise<string> {
  const { sha256Hex } = await import("@localnotes/shared");
  return sha256Hex(text);
}
