import { describe, expect, it } from "vitest";
import { MemoryBackend, Store } from "./helpers";
import {
  InvalidParentError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  sha256Hex,
} from "@localnotes/shared";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

export function deterministicIds() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

export function fixture() {
  return new Store(new MemoryBackend(), {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    idFactory: deterministicIds(),
  });
}

describe("Store — hierarchy, identity and versions", () => {
  it("creates a notebook → folder → note tree with valid parents", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const folder = await store.createNode({ kind: "folder", parentId: nb.id, title: "Design" });
    const note = await store.createNode({
      kind: "note",
      parentId: folder.id,
      title: "Architecture",
      content: "# Hello",
    });

    expect(nb.parentId).toBeNull();
    expect(folder.parentId).toBe(nb.id);
    expect(note.parentId).toBe(folder.id);
    expect(note.contentHash).toBe(await sha256Hex("# Hello"));
    expect(note.syncState).toBe("local-only");

    const tree = await store.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.children[0]?.id).toBe(note.id);
    expect(await store.getPathLabel(note.id)).toBe("Work / Design / Architecture");
  });

  it("refuses illegal parents and content on non-notes", async () => {
    const store = fixture();
    await store.init();
    await expect(store.createNode({ kind: "folder", parentId: null })).rejects.toBeInstanceOf(
      InvalidParentError,
    );
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id });
    await expect(
      store.createNode({ kind: "note", parentId: note.id, title: "child" }),
    ).rejects.toBeInstanceOf(InvalidParentError);
    await expect(
      store.createNode({ kind: "folder", parentId: nb.id, content: "# nope" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("increments localVersion and recomputes the hash on every edit", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id, content: "one" });
    const first = note.contentHash;

    const edited = await store.updateNode(note.id, { content: "two" }, note.localVersion);
    expect(edited.localVersion).toBe(note.localVersion + 1);
    expect(edited.contentHash).not.toBe(first);
    expect(edited.contentHash).toBe(await sha256Hex("two"));

    const renamed = await store.renameNode(note.id, "Renamed", edited.localVersion);
    expect(renamed.title).toBe("Renamed");
    expect(renamed.id).toBe(note.id);
    expect(renamed.localVersion).toBe(edited.localVersion + 1);
    // Renaming must not change the content hash.
    expect(renamed.contentHash).toBe(edited.contentHash);

    const noop = await store.updateNode(note.id, { content: renamed.content }, renamed.localVersion);
    expect(noop.localVersion).toBe(renamed.localVersion);
  });

  it("rejects stale writes instead of clobbering a newer edit", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id, content: "a" });
    await store.updateNode(note.id, { content: "b" }, note.localVersion);
    await expect(
      store.updateNode(note.id, { content: "c" }, note.localVersion),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await store.getNode(note.id))?.content).toBe("b");
  });

  it("keeps identity and sync history across rename and move", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const other = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id, title: "Note" });

    const moved = await store.moveNode(note.id, other.id);
    expect(moved.id).toBe(note.id);
    expect(moved.createdAt).toBe(note.createdAt);
    expect(moved.parentId).toBe(other.id);
    expect(moved.localVersion).toBeGreaterThan(note.localVersion);

    await expect(store.moveNode(other.id, nb.id)).rejects.toThrow(/top-level/);
    const folder = await store.createNode({ kind: "folder", parentId: nb.id });
    await expect(store.moveNode(folder.id, folder.id)).rejects.toThrow(/own parent/);
    const child = await store.createNode({ kind: "folder", parentId: folder.id });
    await expect(store.moveNode(folder.id, child.id)).rejects.toThrow(/subtree/);
  });

  it("normalizes positions when moving inside the same parent", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const a = await store.createNode({ kind: "note", parentId: nb.id, title: "a" });
    const b = await store.createNode({ kind: "note", parentId: nb.id, title: "b" });
    const c = await store.createNode({ kind: "note", parentId: nb.id, title: "c" });

    await store.moveNode(c.id, nb.id, 0);
    const children = await store.children(nb.id);
    expect(children.map((n) => n.id)).toEqual([c.id, a.id, b.id]);
    expect(children.map((n) => n.position)).toEqual([0, 1, 2]);
  });

  it("tombstones a whole subtree and never treats absence as deletion", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const folder = await store.createNode({ kind: "folder", parentId: nb.id });
    const note = await store.createNode({ kind: "note", parentId: folder.id });

    const { deletedIds } = await store.deleteNode(folder.id);
    expect(deletedIds.sort()).toEqual([folder.id, note.id].sort());
    expect(await store.getNode(folder.id)).toBeNull();
    expect(await store.getNode(note.id)).toBeNull();
    expect(await store.exists(note.id)).toBe(false);

    const all = await store.listNodes({ includeDeleted: true });
    const tombstoned = all.find((n) => n.id === note.id);
    expect(tombstoned?.deletedAt).not.toBeNull();
    expect(tombstoned?.syncState).toBe("deleted");
    expect(await store.listNodes()).toHaveLength(1);
    await expect(store.deleteNode(folder.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stores attachments with a sniffed type and a safe filename", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    const note = await store.createNode({ kind: "note", parentId: nb.id });

    const meta = await store.putAttachment({
      noteId: note.id,
      filename: "../../sneaky/diagram.PNG",
      bytes: PNG,
    });
    expect(meta.mime).toBe("image/png");
    expect(meta.ext).toBe("png");
    expect(meta.filename).toBe("sneaky-diagram.PNG");
    expect(meta.sha256).toHaveLength(64);

    const read = await store.getAttachment(meta.id);
    expect(read?.bytes.length).toBe(PNG.length);
    expect(await store.listAttachments(note.id)).toHaveLength(1);

    await store.deleteAttachment(meta.id);
    expect(await store.getAttachment(meta.id)).toBeNull();
    await expect(store.deleteAttachment(meta.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects attachments that are not allow-listed images", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    await expect(
      store.putAttachment({ noteId: nb.id, filename: "x.txt", bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("searches across the live tree only", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const keep = await store.createNode({
      kind: "note",
      parentId: nb.id,
      title: "Retention policy",
      content: "database backups",
    });
    const drop = await store.createNode({
      kind: "note",
      parentId: nb.id,
      title: "Retention old",
      content: "database backups",
    });
    await store.deleteNode(drop.id);
    const hits = await store.search("retention");
    expect(hits.map((h) => h.node.id)).toEqual([keep.id]);
  });

  it("reports storage statistics", async () => {
    const store = fixture();
    await store.init();
    const nb = await store.createNode({ kind: "notebook", parentId: null });
    await store.putAttachment({ noteId: nb.id, filename: "a.png", bytes: PNG });
    const stats = await store.stats();
    expect(stats.backend).toBe("memory");
    expect(stats.nodeCount).toBe(1);
    expect(stats.attachmentBytes).toBe(PNG.length);
    expect(stats.pendingOps).toBeGreaterThan(0);
  });
});
