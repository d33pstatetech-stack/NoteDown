import { describe, expect, it } from "vitest";
import { MemoryBackend, Store } from "../unit/helpers";
import { NetworkError, sha256Hex } from "@localnotes/shared";
import { MemoryRemoteServer, SyncEngine, createSyncEngine } from "@localnotes/sync";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
]);

interface Client {
  store: Store;
  engine: SyncEngine;
  label: string;
}

/**
 * Test-controlled clock: backoff timestamps are real dates, so retry behaviour
 * is exercised by moving time forward rather than by sleeping.
 */
const clock = { t: new Date("2026-01-01T00:00:00.000Z") };
const advance = (ms: number) => {
  clock.t = new Date(clock.t.getTime() + ms);
};

/** A persistent, independent client: its own local database and its own engine. */
function makeClient(server: MemoryRemoteServer, label: string): Client {
  const store = new Store(new MemoryBackend({ location: label }));
  return {
    store,
    engine: createSyncEngine({
      store,
      client: server,
      random: () => 0.5,
      now: () => clock.t,
    }),
    label,
  };
}

async function boot(server: MemoryRemoteServer, label: string): Promise<Client> {
  const client = makeClient(server, label);
  await client.store.init();
  return client;
}

describe("two independent clients against one server", () => {
  it("creates a notebook and note on one device and receives it on the other", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const b = await boot(server, "phone");

    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const note = await a.store.createNode({
      kind: "note",
      parentId: notebook.id,
      title: "Roadmap",
      content: "# Q3\n\nShip the local store.",
    });

    const firstReport = await a.engine.run();
    expect(firstReport.pushed).toBe(2);
    // Pulling its own changes back is idempotent: no duplicates, nothing queued.
    expect(await a.store.pendingCount()).toBe(0);
    expect(await a.store.listNodes()).toHaveLength(2);
    expect(server.nodeCount()).toBe(2);

    const secondReport = await b.engine.run();
    expect(secondReport.applied).toBe(2);
    const mirror = await b.store.getNode(note.id);
    expect(mirror?.title).toBe("Roadmap");
    expect(mirror?.content).toBe("# Q3\n\nShip the local store.");
    expect(mirror?.syncState).toBe("synced");
    expect(mirror?.parentId).toBe(notebook.id);
    expect(await b.store.getCheckpoint()).not.toBeNull();
  });

  it("only sends the delta on a second sync (incremental, not a full download)", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const b = await boot(server, "phone");
    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    await a.store.createNode({ kind: "note", parentId: notebook.id, title: "One", content: "1" });
    await a.engine.run();
    await b.engine.run();

    // A third client joining later is the only one that must download everything.
    await a.store.createNode({ kind: "note", parentId: notebook.id, title: "Two", content: "2" });
    await a.engine.run();
    const delta = await b.engine.run();
    expect(delta.applied).toBe(1);
  });

  it("preserves both versions when two devices edit the same note offline", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const b = await boot(server, "phone");
    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const note = await a.store.createNode({
      kind: "note",
      parentId: notebook.id,
      title: "Shared",
      content: "original",
    });
    await a.engine.run();
    await b.engine.run();
    expect((await b.store.getNode(note.id))?.content).toBe("original");

    // Both go offline and edit.
    const aLocal = await a.store.getNode(note.id);
    const bLocal = await b.store.getNode(note.id);
    await a.store.updateNode(note.id, { content: "edited on laptop" }, aLocal?.localVersion);
    await b.store.updateNode(note.id, { content: "edited on phone" }, bLocal?.localVersion);

    // Laptop reconnects first and wins the race.
    const aReport = await a.engine.run();
    expect(aReport.conflicts).toBe(0);

    // Phone reconnects: the divergence must be preserved, not silently merged.
    const bReport = await b.engine.run();
    expect(bReport.conflicts).toBe(1);
    const phoneNodes = await b.store.listNodes();
    const conflictCopy = phoneNodes.find((node) => node.conflictOf === note.id);
    expect(conflictCopy).toBeDefined();
    expect(conflictCopy?.title).toMatch(/conflict copy/);
    expect(conflictCopy?.content).toBe("edited on laptop");
    expect((await b.store.getNode(note.id))?.content).toBe("edited on phone");

    // Everything converges: the laptop learns about the conflict copy too.
    await b.engine.run();
    await a.engine.run();
    const laptopNodes = await a.store.listNodes();
    expect(laptopNodes.filter((node) => node.conflictOf === note.id)).toHaveLength(1);
    expect((await a.store.getNode(note.id))?.content).toBe("edited on phone");
    expect(laptopNodes.some((node) => node.content === "edited on laptop")).toBe(true);
    expect(await a.store.pendingCount()).toBe(0);
    expect(await b.store.pendingCount()).toBe(0);
  });

  it("rebases instead of duplicating when the server echoes an earlier write", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const note = await a.store.createNode({ kind: "note", parentId: notebook.id, content: "v1" });
    await a.engine.run();

    // Two rapid edits: the first is sent, the second coalesces into the queue.
    const first = await a.store.getNode(note.id);
    await a.store.updateNode(note.id, { content: "v2" }, first?.localVersion);
    const queued = (await a.store.listQueue()).find((op) => op.entityId === note.id);
    if (!queued) throw new Error("expected a queued op");
    await a.store.markOpSent(queued.opId);
    const second = await a.store.getNode(note.id);
    await a.store.updateNode(note.id, { content: "v3" }, second?.localVersion);

    const report = await a.engine.run();
    expect(report.conflicts).toBe(0);
    expect((await a.store.listNodes()).filter((node) => node.conflictOf !== null)).toHaveLength(0);
    expect((await a.store.getNode(note.id))?.content).toBe("v3");
    expect(await a.store.pendingCount()).toBe(0);
    expect(server.peekNode(note.id)?.content).toBe("v3");
  });

  it("is idempotent under duplicate delivery", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const note = await a.store.createNode({ kind: "note", parentId: notebook.id, content: "once" });
    const [op] = await a.store.listQueue();
    if (!op) throw new Error("expected an op");

    const response = await server.push([
      {
        opId: op.opId,
        type: op.type,
        entityId: op.entityId,
        baseVersion: op.baseVersion,
        payload: op.payload,
        pushedHashes: op.pushedHashes,
      },
    ]);
    expect(response.results[0]?.status).toBe("applied");
    const versionAfterFirst = server.currentVersion();

    const again = await server.push([
      {
        opId: op.opId,
        type: op.type,
        entityId: op.entityId,
        baseVersion: 0,
        payload: op.payload,
        pushedHashes: op.pushedHashes,
      },
    ]);
    expect(again.results[0]?.status).toBe("duplicate");
    expect(server.currentVersion()).toBe(versionAfterFirst);
    expect((await a.store.listQueue()).some((candidate) => candidate.opId === op.opId)).toBe(true);
    expect(note.id).toBeTruthy();
  });

  it("keeps the queued change and retries after a network failure", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    await a.store.createNode({ kind: "note", parentId: notebook.id, content: "offline" });

    server.failNextPush = new NetworkError("connection lost");
    const failed = await a.engine.run();
    expect(failed.pushed).toBe(0);
    expect(a.engine.status().state).toBe("offline");
    expect(await a.store.pendingCount()).toBe(2);

    // The local edit is still there, and the ops are queued with a backoff.
    const queued = await a.store.listQueue();
    expect(queued.every((op) => op.attempts >= 1)).toBe(true);
    expect(queued.some((op) => op.lastError !== null)).toBe(true);

    // The backoff keeps the next run from hammering the server...
    expect((await a.engine.run()).pushed).toBe(0);

    // ...and once the backoff elapses the same ops (same ids) are re-sent.
    advance(5 * 60 * 1000);
    const recovered = await a.engine.run();
    expect(recovered.pushed).toBe(2);
    expect(await a.store.pendingCount()).toBe(0);
    expect(a.engine.status().state).toBe("idle");
  });

  it("uploads attachment bytes before advertising the note, and downloads them elsewhere", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const b = await boot(server, "phone");
    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const note = await a.store.createNode({ kind: "note", parentId: notebook.id, content: "image" });
    const attachment = await a.store.putAttachment({
      noteId: note.id,
      filename: "diagram.png",
      bytes: PNG,
    });
    await a.store.updateNode(
      note.id,
      { content: `![d](attachments/${attachment.id}.png)` },
      (await a.store.getNode(note.id))?.localVersion,
    );

    const report = await a.engine.run();
    expect(report.pushedAttachments).toBe(1);
    expect(server.peekAttachment(attachment.id)?.sha256).toBe(await sha256Hex(PNG));

    const mirror = await b.engine.run();
    expect(mirror.downloadedAttachments).toBe(1);
    const downloaded = await b.store.getAttachment(attachment.id);
    expect(Array.from(downloaded?.bytes ?? [])).toEqual(Array.from(PNG));
    expect(downloaded?.meta.mime).toBe("image/png");
  });

  it("propagates deletions as tombstones and never as a silent disappearance", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const b = await boot(server, "phone");
    const notebook = await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    const note = await a.store.createNode({ kind: "note", parentId: notebook.id, content: "bye" });
    await a.engine.run();
    await b.engine.run();

    await a.store.deleteNode(note.id);
    await a.engine.run();
    expect(server.peekNode(note.id)?.deletedAt).not.toBeNull();

    await b.engine.run();
    expect(await b.store.getNode(note.id)).toBeNull();
    const tombstone = await b.store.getNode(note.id, { includeDeleted: true });
    expect(tombstone?.syncState).toBe("deleted");
    expect(await b.store.pendingCount()).toBe(0);
  });

  it("reports progress through the status API", async () => {
    const server = new MemoryRemoteServer();
    const a = await boot(server, "laptop");
    const seen: string[] = [];
    const unsubscribe = a.engine.subscribe((status) => seen.push(status.state));
    await a.store.createNode({ kind: "notebook", parentId: null, title: "Work" });
    expect(a.engine.status().state).toBe("idle");
    await a.engine.run();
    expect(seen).toContain("syncing");
    expect(a.engine.status()).toMatchObject({ state: "idle", pending: 0, error: null });
    expect(a.engine.status().lastSyncedAt).not.toBeNull();
    unsubscribe();
  });

  it("stays disabled and never throws when no client is configured", async () => {
    const store = new Store(new MemoryBackend());
    await store.init();
    const engine = createSyncEngine({ store });
    const report = await engine.run();
    expect(engine.status().state).toBe("disabled");
    expect(report.pushed).toBe(0);
    expect(store).toBeDefined();
  });
});
