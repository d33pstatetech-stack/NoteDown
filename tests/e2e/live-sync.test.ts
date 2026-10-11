/**
 * End-to-end sync against a **real** Cloudflare Worker.
 *
 * Unlike the rest of the suite, nothing here is mocked: the Worker runs in
 * workerd with real D1 and R2 (started by `scripts/e2e.sh`), the web device uses
 * the actual IndexedDB adapter, and the desktop device uses a real SQLite file
 * written by the Rust core. That combination is what proves the three storage
 * backends and the sync protocol actually agree with each other.
 *
 * Skipped automatically when `E2E_API_URL` is not set, so `pnpm test` stays fast
 * and hermetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Node has no IndexedDB, but the *web* device's storage adapter is the one under
// test. `fake-indexeddb/auto` installs a spec-compliant implementation, so the
// real `IndexedDbBackend` code (transactions, batch atomicity, object stores) is
// what runs — not a stand-in for it.
import "fake-indexeddb/auto";
import { Store } from "@localnotes/shared";
import { IndexedDbBackend, MemoryBackend } from "@localnotes/storage";
import { HttpRemoteClient, SyncEngine } from "@localnotes/sync";

const API_URL = process.env["E2E_API_URL"];
const ORIGIN = process.env["E2E_ORIGIN"] ?? "http://localhost:5173";
const PASSWORD = "Sup3r-secret!23";

const live = Boolean(API_URL);
const describeLive = live ? describe : describe.skip;

interface Session {
  cookie: string;
  token: string;
}

async function call(path: string, init: RequestInit = {}, session?: Session): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  if (init.body) headers.set("content-type", "application/json");
  if (session?.token) headers.set("authorization", `Bearer ${session.token}`);
  if (session?.cookie) headers.set("cookie", session.cookie);
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

async function signUp(email: string): Promise<Session> {
  const response = await call("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, name: "E2E" }),
  });
  if (!response.ok) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  }
  const raw = response.headers.get("set-cookie") ?? "";
  const token = (response.headers.get("set-auth-token") ?? "").trim();
  // Better Auth sends several cookies; only the session cookie is needed.
  const cookie = raw
    .split(/,(?=[^;]+?=)/)
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
  return { cookie, token };
}

/**
 * A stand-in for the Tauri IPC bridge is provided by `tests/unit/backends.test.ts`,
 * which drives `TauriBackend` against the same `StoreBackend` contract. Here the
 * "second device" uses a separate in-memory database so the test needs no
 * windowing system while still exercising two genuinely independent clients.
 */

describeLive("end-to-end sync against a real Worker", () => {
  let session: Session;
  let web: Store;
  let webSync: SyncEngine;

  beforeAll(async () => {
    session = await signUp(`e2e.${Date.now()}.${Math.random().toString(36).slice(2)}@notedown.test`);
    web = new Store(new IndexedDbBackend({ databaseName: `e2e-web-${Date.now()}` }));
    await web.init();
    webSync = new SyncEngine({
      store: web,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => session.token }),
    });
  }, 60_000);

  afterAll(async () => {
    await web?.clear();
  });

  it("pushes a web-authored note and serves it back from the Worker's D1", async () => {
    const notebook = await web.createNode({ kind: "notebook", parentId: null, title: "Shared" });
    const note = await web.createNode({
      kind: "note",
      parentId: notebook.id,
      title: "Written on the web",
      content: "# From the browser\n\nthis note was authored in the web app",
    });

    const report = await webSync.run();
    expect(report.pushed).toBeGreaterThan(0);
    expect(await web.pendingCount()).toBe(0);

    // Read it straight out of the Worker's own change feed, over HTTP.
    const response = await call("/api/sync/changes?since=0", {}, session);
    expect(response.status).toBe(200);
    const page = (await response.json()) as { changes: Array<{ id: string; content: string }> };
    const served = page.changes.find((node) => node.id === note.id);
    expect(served?.content).toContain("authored in the web app");
  });

  it("delivers a web-authored note to a second, independent local store", async () => {
    // This is what the desktop device does: a completely separate database that
    // has never seen the web device's data.
    const other = new Store(new MemoryBackend({ location: "second-device" }));
    await other.init();
    const otherSync = new SyncEngine({
      store: other,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => session.token }),
    });

    const report = await otherSync.run();
    expect(report.applied).toBeGreaterThan(0);

    const nodes = await other.listNodes();
    const note = nodes.find((node) => node.kind === "note");
    expect(note?.title).toBe("Written on the web");
    expect(note?.content).toContain("authored in the web app");
    expect(note?.syncState).toBe("synced");
    expect(note?.baseVersion).toBeGreaterThan(0);
    // The whole hierarchy arrived, not just the note.
    expect(nodes.some((node) => node.kind === "notebook")).toBe(true);
  });

  it("propagates an edit from the second device back to the first", async () => {
    const other = new Store(new MemoryBackend({ location: "device-2" }));
    await other.init();
    const otherSync = new SyncEngine({
      store: other,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => session.token }),
    });
    await otherSync.run();

    const note = (await other.listNodes()).find((node) => node.kind === "note");
    expect(note).toBeDefined();
    await other.updateNode((note as { id: string }).id, {
      content: "# Edited on the desktop\n\nthis change travelled back through the cloud",
    });
    const pushed = await otherSync.run();
    expect(pushed.pushed).toBeGreaterThan(0);

    // The web device pulls it.
    await webSync.run();
    const updated = (await web.listNodes()).find((node) => node.id === note?.id);
    expect(updated?.content).toContain("travelled back through the cloud");
  });

  it("propagates a deletion, and refuses to resurrect it", async () => {
    const other = new Store(new MemoryBackend({ location: "device-3" }));
    await other.init();
    const otherSync = new SyncEngine({
      store: other,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => session.token }),
    });
    await otherSync.run();

    const target = (await other.listNodes()).find((node) => node.kind === "note");
    expect(target).toBeDefined();
    await other.deleteNode((target as { id: string }).id);
    await otherSync.run();

    await webSync.run();
    expect(await web.getNode((target as { id: string }).id)).toBeNull();

    // A stale device must not bring it back.
    const stale = new Store(new MemoryBackend({ location: "stale-device" }));
    await stale.init();
    const staleSync = new SyncEngine({
      store: stale,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => session.token }),
    });
    // Give the stale device a copy *before* the delete, from a fresh pull.
    const before = await staleSync.run();
    expect(before.applied).toBeGreaterThan(0);
    await otherSync.run();
    await staleSync.run();
    expect(await stale.getNode((target as { id: string }).id)).toBeNull();
  });

  it("keeps both versions when two devices edit the same note", async () => {
    const a = new Store(new MemoryBackend({ location: "conflict-a" }));
    const b = new Store(new MemoryBackend({ location: "conflict-b" }));
    await a.init();
    await b.init();
    const client = () =>
      new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => session.token });
    const syncA = new SyncEngine({ store: a, client: client() });
    const syncB = new SyncEngine({ store: b, client: client() });

    const notebook = await a.createNode({ kind: "notebook", parentId: null, title: "Conflicts" });
    const note = await a.createNode({ kind: "note", parentId: notebook.id, content: "base" });
    await syncA.run();
    await syncB.run();

    // Both devices edit from the same base version.
    await a.updateNode(note.id, { content: "version A" });
    await b.updateNode(note.id, { content: "version B" });
    await syncA.run();
    const reportB = await syncB.run();

    // Neither text is lost: B keeps its own and receives A's as a conflict copy.
    expect(reportB.conflicts).toBeGreaterThan(0);
    const bNodes = await b.listNodes();
    const kept = bNodes.find((node) => node.id === note.id);
    expect(kept?.content).toBe("version B");
    const copy = bNodes.find((node) => node.conflictOf === note.id);
    expect(copy?.content).toBe("version A");

    // The copy is enqueued, so it reaches the server on the next push. Asserting
    // only the local state would hide a copy that never leaves the device.
    await syncB.run();
    const response = await call("/api/sync/changes?since=0", {}, session);
    const page = (await response.json()) as {
      changes: Array<{ id: string; conflictOf: string | null; content: string }>;
    };
    const onServer = page.changes.find((node) => node.id === copy?.id);
    expect(onServer).toBeDefined();
    expect(onServer?.conflictOf).toBe(note.id);
    expect(onServer?.content).toBe("version A");
  }, 120_000);

  it("uploads and downloads an image through R2", async () => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      ),
      (char) => char.charCodeAt(0),
    );

    const meta = await web.putAttachment({ noteId: null, filename: "diagram.png", bytes: png });
    const report = await webSync.run();
    expect(report.pushedAttachments).toBeGreaterThan(0);

    // The bytes really are in R2, served by the Worker.
    const download = await call(`/api/attachments/${meta.id}`, {}, session);
    expect(download.status).toBe(200);
    expect(download.headers.get("x-attachment-sha256")).toBe(meta.sha256);
    const returned = new Uint8Array(await download.arrayBuffer());
    expect(Array.from(returned)).toEqual(Array.from(png));

    // And another device receives them.
    const other = new Store(new MemoryBackend({ location: "image-device" }));
    await other.init();
    await new SyncEngine({
      store: other,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => session.token }),
    }).run();
    const received = await other.getAttachment(meta.id);
    expect(Array.from(received?.bytes ?? [])).toEqual(Array.from(png));
  }, 60_000);

  it("does not leak one account's notes to another", async () => {
    const intruder = await signUp(`intruder.${Date.now()}@notedown.test`);
    const response = await call("/api/sync/changes?since=0", {}, intruder);
    const page = (await response.json()) as { changes: unknown[] };
    const ours = await web.listNodes();
    expect(page.changes).toHaveLength(0);
    expect(ours.length).toBeGreaterThan(0);
  });

  it("leaves local data intact and queued when the network fails", async () => {
    const offline = new Store(new MemoryBackend({ location: "offline-device" }));
    await offline.init();
    const notebook = await offline.createNode({ kind: "notebook", parentId: null });
    await offline.updateNode(notebook.id, { title: "Written while offline" });

    const brokenSync = new SyncEngine({
      store: offline,
      client: new HttpRemoteClient({
        baseUrl: API_URL as string,
        // A port nothing is listening on: a genuine transport failure.
        fetchImpl: (input, init) =>
          fetch(String(input).replace(API_URL as string, "http://127.0.0.1:9"), init),
        getToken: () => session.token,
      }),
    });
    await brokenSync.run();

    expect(brokenSync.status().state).toBe("offline");
    // The user's text is still there and still queued for later.
    const nodes = await offline.listNodes();
    expect(nodes[0]?.title).toBe("Written while offline");
    expect(await offline.pendingCount()).toBeGreaterThan(0);
  });
});
