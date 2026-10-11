import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "@localnotes/shared";
import { MemoryBackend } from "@localnotes/storage";
import { HttpRemoteClient, SyncEngine, MemoryRemoteServer, type PushOp } from "@localnotes/sync";
import type { PushResponse } from "@localnotes/sync";

/**
 * Contract tests between the real `HttpRemoteClient`/`SyncEngine` and a
 * transport that mimics the Worker.
 *
 * These are the pieces that are easy to get subtly wrong — URL shapes, header
 * names, pagination and the checkpoint protocol — and that nothing else in the
 * suite exercises end to end. The fake here is deliberately strict: it rejects
 * an unknown path or method, so a typo in the client fails loudly instead of
 * silently never syncing.
 */

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function makeStore(label: string): Store {
  return new Store(new MemoryBackend({ location: label }));
}

class FakeWorker {
  readonly requests: RecordedRequest[] = [];
  readonly server = new MemoryRemoteServer();
  token: string | null = "test-token";

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const record: RecordedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    this.requests.push(record);

    // Enforces the credential rule the real Worker enforces: a bearer token, or
    // a session cookie. Anything else is a 401.
    if (!headers["authorization"] && !headers["cookie"]) {
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/api/sync/push" && record.method === "POST") {
      const body = JSON.parse(record.body || "{}") as { ops: PushOp[] };
      const result: PushResponse = await this.server.push(body.ops ?? []);
      return Response.json(result);
    }

    if (url.pathname === "/api/sync/changes" && record.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const since = url.searchParams.get("since");
      return Response.json(await this.server.fetchChanges(since, limit));
    }

    if (url.pathname.startsWith("/api/attachments/") && record.method === "GET") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const remote = await this.server.downloadAttachment(id);
      if (!remote) return Response.json({ error: { code: "not_found" } }, { status: 404 });
      return new Response(remote.bytes, {
        headers: {
          "content-type": remote.meta.mime,
          "x-attachment-note-id": remote.meta.noteId ?? "",
          "x-attachment-mime": remote.meta.mime,
          "x-attachment-ext": remote.meta.ext,
          "x-attachment-size": String(remote.bytes.length),
          "x-attachment-sha256": remote.meta.sha256,
          "x-attachment-version": String(remote.meta.serverVersion),
        },
      });
    }

    if (url.pathname.startsWith("/api/attachments/") && record.method === "PUT") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const body = JSON.parse(record.body || "{}") as {
        meta: { noteId: string | null; mime: string; ext: string; size: number; sha256: string };
        bytesBase64: string;
      };
      const binary = atob(body.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const uploaded = await this.server.uploadAttachment(
        {
          id,
          noteId: body.meta.noteId,
          filename: `${id}.${body.meta.ext}`,
          mime: body.meta.mime,
          ext: body.meta.ext,
          size: bytes.length,
          sha256: body.meta.sha256,
          createdAt: new Date().toISOString(),
          syncState: "local-only",
          baseVersion: 0,
        },
        bytes,
      );
      return Response.json({ id, ...uploaded });
    }

    if (url.pathname.startsWith("/api/attachments/") && record.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      await this.server.deleteAttachment(id);
      return Response.json({ id, deleted: true });
    }

    return Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 });
  };
}

/** A 1x1 PNG, the smallest valid image the MIME sniffer accepts. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

function client(worker: FakeWorker): HttpRemoteClient {
  return new HttpRemoteClient({
    baseUrl: "https://api.example.test",
    getToken: () => worker.token,
    fetchImpl: worker.fetchImpl,
  });
}

describe("HttpRemoteClient against a Worker-shaped transport", () => {
  let worker: FakeWorker;

  beforeEach(() => {
    worker = new FakeWorker();
  });

  it("authenticates with the bearer token on every request", async () => {
    await client(worker).fetchChanges(null);
    expect(worker.requests[0]?.headers["authorization"]).toBe("Bearer test-token");

    // Omitting the token must be a 401 from the server, surfaced as an auth error.
    worker.token = null;
    const anonymous = new HttpRemoteClient({
      baseUrl: "https://api.example.test",
      fetchImpl: worker.fetchImpl,
    });
    await expect(anonymous.fetchChanges(null)).rejects.toThrow(/sign in again/i);
  });

  it("uses the documented URL shapes", async () => {
    const remote = client(worker);
    await remote.push([]);
    await remote.fetchChanges("12:user", 25);
    expect(worker.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/sync/push",
      "GET /api/sync/changes?limit=25&since=12%3Auser",
    ]);
  });

  it("round-trips a full sync cycle between two independent stores", async () => {
    const desktop = makeStore("desktop");
    const web = makeStore("web");
    await desktop.init();
    await web.init();

    // Device A authors a notebook and a note.
    const notebook = await desktop.createNode({ kind: "notebook", parentId: null });
    const note = await desktop.createNode({
      kind: "note",
      parentId: notebook.id,
      title: "Shared",
      content: "from desktop",
    });

    const desktopSync = new SyncEngine({ store: desktop, client: client(worker) });
    await desktopSync.run();
    expect(worker.server.peekNode(note.id)?.content).toBe("from desktop");

    // Device B pulls and sees exactly the same tree.
    const webSync = new SyncEngine({ store: web, client: client(worker) });
    await webSync.run();
    const seen = await web.getNode(note.id);
    expect(seen?.content).toBe("from desktop");
    expect(seen?.title).toBe("Shared");
    expect(seen?.syncState).toBe("synced");

    // Device B edits and pushes back.
    await web.updateNode(note.id, { content: "edited on web" });
    await webSync.run();
    expect(worker.server.peekNode(note.id)?.content).toBe("edited on web");

    // Device A pulls the edit.
    await desktopSync.run();
    expect((await desktop.getNode(note.id))?.content).toBe("edited on web");
  });

  it("leaves the queue empty after a successful sync", async () => {
    const store = makeStore("queue");
    await store.init();
    const notebook = await store.createNode({ kind: "notebook", parentId: null });
    await store.updateNode(notebook.id, { title: "Renamed" });

    const sync = new SyncEngine({ store, client: client(worker) });
    const report = await sync.run();

    expect(report.pushed).toBeGreaterThan(0);
    expect(await store.pendingCount()).toBe(0);
    expect(sync.status().state).toBe("idle");
  });

  it("surfaces a delete to the other device as a tombstone", async () => {
    const desktop = makeStore("d");
    const web = makeStore("w");
    await desktop.init();
    await web.init();
    const notebook = await desktop.createNode({ kind: "notebook", parentId: null });
    const note = await desktop.createNode({ kind: "note", parentId: notebook.id, content: "bye" });

    const desktopSync = new SyncEngine({ store: desktop, client: client(worker) });
    await desktopSync.run();

    const webSync = new SyncEngine({ store: web, client: client(worker) });
    await webSync.run();
    expect(await web.getNode(note.id)).not.toBeNull();

    await desktop.deleteNode(note.id);
    await desktopSync.run();
    await webSync.run();

    // A tombstone removes the note from the other device's tree.
    expect(await web.getNode(note.id)).toBeNull();
  });

  it("uploads attachment bytes and hands them to the other device", async () => {
    const desktop = makeStore("d");
    const web = makeStore("w");
    await desktop.init();
    await web.init();
    const desktopSync = new SyncEngine({ store: desktop, client: client(worker) });
    const webSync = new SyncEngine({ store: web, client: client(worker) });

    const meta = await desktop.putAttachment({
      noteId: null,
      filename: "diagram.png",
      bytes: PNG,
    });
    await desktopSync.run();

    await webSync.run();
    const downloaded = await web.getAttachment(meta.id);
    expect(downloaded).not.toBeNull();
    expect(Array.from(downloaded?.bytes ?? [])).toEqual(Array.from(PNG));
    // The digest is recomputed from what actually arrived, so it always matches.
    expect(downloaded?.meta.sha256).toBe(meta.sha256);
  });

  it("keeps every queued change when the server is unreachable", async () => {
    const store = makeStore("offline");
    await store.init();
    const notebook = await store.createNode({ kind: "notebook", parentId: null });
    await store.updateNode(notebook.id, { title: "Offline edit" });
    const before = await store.pendingCount();

    const offline = new SyncEngine({
      store,
      client: new HttpRemoteClient({
        baseUrl: "https://api.example.test",
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    });
    const report = await offline.run();

    expect(report.pushed).toBe(0);
    // Nothing is lost, and a backoff is scheduled so the next run waits.
    expect(await store.pendingCount()).toBe(before);
    expect(offline.status().state).toBe("offline");
    const queue = await store.listQueue();
    expect(queue.every((op) => op.nextAttemptAt !== null)).toBe(true);
  });

  it("reports an auth failure without discarding the queue", async () => {
    const store = makeStore("unauth");
    await store.init();
    await store.createNode({ kind: "notebook", parentId: null });

    const unauthorized = new HttpRemoteClient({
      baseUrl: "https://api.example.test",
      getToken: () => null,
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    const sync = new SyncEngine({ store, client: unauthorized });
    await sync.run();

    expect(sync.status().state).toBe("error");
    expect(await store.pendingCount()).toBeGreaterThan(0);
  });

  it("resyncs from zero when the server rejects the cursor as stale", async () => {
    const store = makeStore("stale");
    await store.init();
    const remote = new MemoryRemoteServer();
    const sync = new SyncEngine({ store, client: client(worker) });

    const notebook = await store.createNode({ kind: "notebook", parentId: null });
    await sync.run();
    expect(await store.getCheckpoint()).not.toBeNull();

    // The server can no longer serve this cursor.
    let stale = true;
    const staleOnce = new HttpRemoteClient({
      baseUrl: "https://api.example.test",
      getToken: () => worker.token,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (stale && url.pathname === "/api/sync/changes") {
          stale = false;
          return Response.json(
            { error: { code: "stale_checkpoint", message: "too old" } },
            { status: 409 },
          );
        }
        return worker.fetchImpl(input, init);
      },
    });

    const recovery = new SyncEngine({ store, client: staleOnce });
    const report = await recovery.run();

    // It recovered rather than looping on the error.
    expect(recovery.status().state).toBe("idle");
    expect(report.applied).toBeGreaterThan(0);
    expect(await store.getNode(notebook.id)).not.toBeNull();
    expect(remote).toBeDefined();
  });
});
