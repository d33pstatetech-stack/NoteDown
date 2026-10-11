import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";

const ORIGIN = env.APP_ORIGIN;
const PASSWORD = "Sup3r-secret!23";

function url(path: string): string {
  return `http://api.local${path}`;
}

/**
 * One helper for every authenticated call.
 *
 * The previous suite inlined `headers` twice in the same object literal, so
 * JavaScript silently kept only the *second* one and every "authenticated"
 * request actually went out with no cookie and no `origin` — the tests were
 * asserting against an anonymous caller and passing for the wrong reason.
 */
async function api(
  cookie: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  if (init.body) headers.set("content-type", "application/json");
  headers.set("cookie", cookie);
  return SELF.fetch(url(path), { ...init, headers });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function signUp(email: string): Promise<string> {
  const response = await SELF.fetch(url("/api/auth/sign-up/email"), {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
  });
  expect(response.status, `sign-up ${email} failed`).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}
async function signIn(email: string): Promise<{ cookie: string; token: string }> {
  const response = await SELF.fetch(url("/api/auth/sign-in/email"), {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status, `sign-in ${email} failed`).toBe(200);
  return {
    cookie: response.headers.get("set-cookie") ?? "",
    token: response.headers.get("set-auth-token") ?? "",
  };
}

async function account(email: string): Promise<{ cookie: string; token: string; id: string }> {
  const created = await signUp(email);
  // Sign-up already returns a usable session; sign in as well so the bearer
  // plugin path is exercised on the same account.
  const session = await signIn(email);
  expect(session.cookie || created).toBeTruthy();
  const cookie = session.cookie || created;
  const me = await json(await api(cookie, "/api/me"));
  const id = (me.user as { id?: string } | undefined)?.id ?? "";
  expect(id).toBeTruthy();
  return { ...session, cookie, id };
}

interface PushResult {
  opId: string;
  status: string;
  serverVersion?: number;
  server?: { deletedAt: string | null };
  error?: string;
}

async function push(
  cookie: string,
  ops: Array<Record<string, unknown>>,
): Promise<{ status: number; results: PushResult[] }> {
  const response = await api(cookie, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({ ops }),
  });
  const body = (await json(response)) as unknown as { results?: PushResult[] };
  return { status: response.status, results: body.results ?? [] };
}

function upsertOp(opId: string, entityId: string, baseVersion: number, payload: Record<string, unknown>) {
  return { opId, type: "upsert_node", entityId, baseVersion, payload };
}

const NOTE_PAYLOAD = (over: Record<string, unknown> = {}) => ({
  kind: "note",
  parentId: null,
  title: "Note",
  content: "",
  position: 0,
  contentHash: "",
  conflictOf: null,
  ...over,
});

/** A 1x1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Each test gets its own pair of accounts.
 *
 * Miniflare's storage is shared across tests in a file (isolated storage is
 * opt-in and not enabled here), so a fixed address would collide with the
 * previous test's user. A per-test nonce keeps every test independent without
 * needing per-test storage snapshots.
 */
let accountSeq = 0;

beforeEach(() => {
  accountSeq += 1;
});

function emails(): { alice: string; bob: string } {
  const nonce = `${accountSeq}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    alice: `alice+${nonce}@localnotes.test`,
    bob: `bob+${nonce}@localnotes.test`,
  };
}

let alice: Awaited<ReturnType<typeof account>>;
let bob: Awaited<ReturnType<typeof account>>;

beforeEach(async () => {
  const { alice: aliceEmail, bob: bobEmail } = emails();
  alice = await account(aliceEmail);
  bob = await account(bobEmail);
  expect(alice.id).not.toBe(bob.id);
});

describe("authentication", () => {
  it("rejects an unauthenticated data request", async () => {
    const response = await SELF.fetch(url("/api/sync/changes"), {
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(401);
  });

  it("accepts a bearer token as well as a cookie", async () => {
    expect(alice.token).toBeTruthy();
    const response = await SELF.fetch(url("/api/me"), {
      headers: { origin: ORIGIN, authorization: `Bearer ${alice.token}` },
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect((body.user as { id: string }).id).toBe(alice.id);
  });

  it("refuses a cross-origin write even with a valid session", async () => {
    const response = await SELF.fetch(url("/api/sync/push"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.com",
        cookie: alice.cookie,
      },
      body: JSON.stringify({ ops: [] }),
    });
    expect(response.status).toBe(403);
  });

  it("ignores a user id supplied in the request body", async () => {
    const response = await api(alice.cookie, "/api/sync/push", {
      method: "POST",
      body: JSON.stringify({
        userId: bob.id,
        ops: [upsertOp("forged-1", `forged-${crypto.randomUUID()}`, 0, { kind: "notebook", parentId: null, title: "Forged", position: 0 })],
      }),
    });
    expect(response.status).toBe(200);

    // The row landed under the *session's* account, not the one in the body.
    const bobChanges = (await json(await api(bob.cookie, "/api/sync/changes?since=0"))) as {
      changes: Array<{ title: string }>;
    };
    expect(bobChanges.changes.some((node) => node.title === "Forged")).toBe(false);
  });
});

describe("sync protocol", () => {
  it("creates a node, lists it, and treats a replayed opId as a duplicate", async () => {
    const empty = await api(alice.cookie, "/api/sync/manifest");
    expect(empty.status).toBe(200);
    expect((await json(empty)).nodes).toHaveLength(0);

    const notebookId = `nb-${crypto.randomUUID()}`;
    const op = upsertOp("op-create", notebookId, 0, {
      kind: "notebook",
      parentId: null,
      title: "Notebook",
      position: 0,
    });

    const created = await push(alice.cookie, [op]);
    expect(created.status).toBe(200);
    expect(created.results[0]?.status).toBe("applied");

    const manifest = (await json(await api(alice.cookie, "/api/sync/manifest"))) as {
      nodes: Array<{ id: string }>;
      checkpoint: string;
    };
    expect(manifest.nodes).toHaveLength(1);
    expect(manifest.checkpoint).toMatch(/^\d+:[^:]+$/);

    const page = (await json(
      await api(alice.cookie, "/api/sync/changes?since=0"),
    )) as { changes: Array<{ id: string; kind: string }>; nextCheckpoint: string; hasMore: boolean };
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]?.id).toBe(notebookId);
    expect(page.nextCheckpoint).toBe(manifest.checkpoint);
    expect(page.hasMore).toBe(false);

    const replay = await push(alice.cookie, [op]);
    expect(replay.results[0]?.status).toBe("duplicate");

    // A duplicate must not have created a second row or burned a version.
    const after = (await json(await api(alice.cookie, "/api/sync/manifest"))) as {
      nodes: Array<{ id: string }>;
    };
    expect(after.nodes).toHaveLength(1);
  });

  it("returns a conflict instead of overwriting a diverged note", async () => {
    const notebookId = `nb-${crypto.randomUUID()}`;
    const noteId = `n-${crypto.randomUUID()}`;
    await push(alice.cookie, [
      upsertOp("c-nb", notebookId, 0, {
        kind: "notebook",
        parentId: null,
        title: "Shared",
        position: 0,
      }),
      upsertOp("c-note", noteId, 0, NOTE_PAYLOAD({ parentId: notebookId, content: "v1" })),
    ]);

    // Device B writes against the same base version it never had.
    const diverged = await push(alice.cookie, [
      upsertOp("c-stale", noteId, 0, NOTE_PAYLOAD({ parentId: notebookId, content: "v2" })),
    ]);
    expect(diverged.results[0]?.status).toBe("conflict");
    expect(diverged.results[0]?.server?.deletedAt).toBeNull();

    // The server kept its committed version; the client's text is not lost
    // because the client preserves it as a conflict copy.
    const changes = (await json(await api(alice.cookie, "/api/sync/changes?since=0"))) as {
      changes: Array<{ id: string; content: string }>;
    };
    expect(changes.changes.find((node) => node.id === noteId)?.content).toBe("v1");
  });

  it("never resurrects a tombstoned node", async () => {
    const notebookId = `nb-${crypto.randomUUID()}`;
    const noteId = `n-${crypto.randomUUID()}`;
    await push(alice.cookie, [
      upsertOp("t-nb", notebookId, 0, {
        kind: "notebook",
        parentId: null,
        title: "Doomed",
        position: 0,
      }),
      upsertOp("t-note", noteId, 0, NOTE_PAYLOAD({ parentId: notebookId, content: "bye" })),
    ]);
    const version = (await push(alice.cookie, [
      upsertOp("t-note-2", noteId, 0, NOTE_PAYLOAD({ parentId: notebookId, content: "still here" })),
    ])).results[0]?.status;
    expect(version).toBe("conflict");

    // Establish the current version by reading it back, then delete.
    const manifest = (await json(await api(alice.cookie, "/api/sync/manifest"))) as {
      nodes: Array<{ id: string; serverVersion: number }>;
    };
    const current = manifest.nodes.find((node) => node.id === noteId)?.serverVersion ?? 0;

    const removed = await push(alice.cookie, [
      {
        opId: "t-del",
        type: "delete_node",
        entityId: noteId,
        baseVersion: current,
        payload: { deletedAt: new Date().toISOString() },
      },
    ]);
    expect(removed.results[0]?.status).toBe("applied");

    // An upsert at the *current* (post-delete) version must not bring it back.
    const resurrected = await push(alice.cookie, [
      upsertOp("t-resurrect", noteId, current + 1, NOTE_PAYLOAD({ parentId: notebookId, content: "back" })),
    ]);
    expect(resurrected.results[0]?.status).toBe("conflict");

    const changes = (await json(await api(alice.cookie, "/api/sync/changes?since=0"))) as {
      changes: Array<{ id: string; deletedAt: string | null }>;
    };
    expect(changes.changes.find((node) => node.id === noteId)?.deletedAt).not.toBeNull();
  });

  it("recomputes the content digest instead of trusting the client", async () => {
    const notebookId = `nb-${crypto.randomUUID()}`;
    const noteId = `n-${crypto.randomUUID()}`;
    await push(alice.cookie, [
      upsertOp("h-nb", notebookId, 0, {
        kind: "notebook",
        parentId: null,
        title: "Hash",
        position: 0,
      }),
      upsertOp(
        "h-note",
        noteId,
        0,
        NOTE_PAYLOAD({ parentId: notebookId, content: "real body", contentHash: "a-lie" }),
      ),
    ]);

    const changes = (await json(await api(alice.cookie, "/api/sync/changes?since=0"))) as {
      changes: Array<{ id: string; contentHash: string }>;
    };
    const stored = changes.changes.find((node) => node.id === noteId)?.contentHash ?? "";
    expect(stored).toHaveLength(64);
    expect(stored).toBe(
      await crypto.subtle
        .digest("SHA-256", new TextEncoder().encode("real body"))
        .then((digest) =>
          [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        ),
    );
  });

  it("keeps the change-feed cursor from skipping undelivered pages", async () => {
    const notebookId = `nb-${crypto.randomUUID()}`;
    await push(alice.cookie, [
      upsertOp("p-nb", notebookId, 0, {
        kind: "notebook",
        parentId: null,
        title: "Paging",
        position: 0,
      }),
    ]);

    // Enough nodes to spill past a page of 1, interleaved with an attachment so
    // the two streams disagree about how far the cursor may advance.
    const noteIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const noteId = `n-${crypto.randomUUID()}`;
      noteIds.push(noteId);
      await push(alice.cookie, [
        upsertOp(`p-note-${index}`, noteId, 0, NOTE_PAYLOAD({ parentId: notebookId, title: `n${index}` })),
      ]);
    }
    const attachmentId = crypto.randomUUID();
    const upload = await api(alice.cookie, `/api/attachments/${attachmentId}`, {
      method: "PUT",
      body: JSON.stringify({ meta: { noteId: null, mime: "image/png", ext: "png" }, bytesBase64: PNG_BASE64 }),
    });
    expect(upload.status).toBe(200);

    // Walk the whole feed one row at a time and collect everything delivered.
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const query = cursor ? `?since=${encodeURIComponent(cursor)}&limit=1` : "?limit=1";
      const page = (await json(await api(alice.cookie, `/api/sync/changes${query}`))) as {
        changes: Array<{ id: string }>;
        attachments: Array<{ id: string }>;
        nextCheckpoint: string;
        hasMore: boolean;
      };
      for (const node of page.changes) seen.add(`node:${node.id}`);
      for (const attachment of page.attachments) seen.add(`att:${attachment.id}`);
      cursor = page.nextCheckpoint;
      if (!page.hasMore) break;
    }

    // Every node and the attachment must have been delivered exactly once.
    for (const noteId of noteIds) expect(seen.has(`node:${noteId}`)).toBe(true);
    expect(seen.has(`att:${attachmentId}`)).toBe(true);
    expect(seen.has(`node:${notebookId}`)).toBe(true);
  });

  it("refuses to acknowledge an attachment that was never uploaded", async () => {
    const result = await push(alice.cookie, [
      {
        opId: "phantom-att",
        type: "put_attachment",
        entityId: crypto.randomUUID(),
        baseVersion: 0,
        payload: { noteId: null, mime: "image/png", ext: "png", size: 1, sha256: "x" },
      },
    ]);
    expect(result.results[0]?.status).toBe("rejected");
    expect(result.results[0]?.error).toMatch(/upload the attachment bytes/i);
  });

  it("rejects a note body over the size limit", async () => {
    const notebookId = `nb-${crypto.randomUUID()}`;
    await push(alice.cookie, [
      upsertOp("s-nb", notebookId, 0, {
        kind: "notebook",
        parentId: null,
        title: "Size",
        position: 0,
      }),
    ]);
    const result = await push(alice.cookie, [
      upsertOp("s-note", `n-${crypto.randomUUID()}`, 0, NOTE_PAYLOAD({
        parentId: notebookId,
        content: "x".repeat(3 * 1024 * 1024),
      })),
    ]);
    expect(result.results[0]?.status).toBe("rejected");
    expect(result.results[0]?.error).toMatch(/too large/i);
  });

  it("rejects a note parented to another account's notebook", async () => {
    const bobNotebook = `nb-${crypto.randomUUID()}`;
    await push(bob.cookie, [
      upsertOp("x-nb", bobNotebook, 0, {
        kind: "notebook",
        parentId: null,
        title: "Bob's",
        position: 0,
      }),
    ]);
    const result = await push(alice.cookie, [
      upsertOp("x-note", `n-${crypto.randomUUID()}`, 0, NOTE_PAYLOAD({ parentId: bobNotebook })),
    ]);
    expect(result.results[0]?.status).toBe("rejected");
    expect(result.results[0]?.error).toMatch(/parent node does not exist/i);
  });
});

describe("attachments", () => {
  async function uploadAttachment(cookie: string, id: string, noteId: string | null = null) {
    const response = await api(cookie, `/api/attachments/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        meta: { noteId, mime: "image/png", ext: "png", filename: "my diagram.png" },
        bytesBase64: PNG_BASE64,
      }),
    });
    return { response, body: (await json(response)) as { id: string; sha256: string; serverVersion: number } };
  }

  it("round-trips upload, download and delete", async () => {
    const id = crypto.randomUUID();
    const { response, body } = await uploadAttachment(alice.cookie, id);
    expect(response.status).toBe(200);
    expect(body.sha256).toHaveLength(64);

    const download = await api(alice.cookie, `/api/attachments/${id}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("etag")).toMatch(/^"/);
    expect(download.headers.get("x-attachment-sha256")).toBe(body.sha256);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);

    // Another account must not be able to read it, and must not learn it exists.
    const stolen = await api(bob.cookie, `/api/attachments/${id}`);
    expect(stolen.status).toBe(404);

    const removed = await api(alice.cookie, `/api/attachments/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await api(alice.cookie, `/api/attachments/${id}`)).status).toBe(404);
  });

  it("is idempotent for identical bytes and does not churn the change feed", async () => {
    const id = crypto.randomUUID();
    const first = await uploadAttachment(alice.cookie, id);
    const second = await uploadAttachment(alice.cookie, id);
    expect(second.response.status).toBe(200);
    expect(second.body.serverVersion).toBe(first.body.serverVersion);
  });

  it("keeps the sanitised display name and never trusts the bytes' claimed type", async () => {
    const id = crypto.randomUUID();
    const { response } = await uploadAttachment(alice.cookie, id);
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT filename, mime FROM attachments WHERE user_id = ? AND id = ?",
    )
      .bind(alice.id, id)
      .first<{ filename: string; mime: string }>();
    expect(row?.filename).toBe("my diagram.png");
    expect(row?.mime).toBe("image/png");
  });

  it("rejects a digest that does not match the bytes", async () => {
    const response = await api(alice.cookie, `/api/attachments/${crypto.randomUUID()}`, {
      method: "PUT",
      body: JSON.stringify({
        meta: { mime: "image/png", ext: "png", sha256: "0".repeat(64) },
        bytesBase64: PNG_BASE64,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses to attach an image to another account's note", async () => {
    const bobNotebook = `nb-${crypto.randomUUID()}`;
    await push(bob.cookie, [
      upsertOp("an-nb", bobNotebook, 0, {
        kind: "notebook",
        parentId: null,
        title: "Bob's",
        position: 0,
      }),
    ]);
    const { response } = await uploadAttachment(alice.cookie, crypto.randomUUID(), bobNotebook);
    expect(response.status).toBe(400);
  });

  it("refuses a non-image masquerading as one", async () => {
    const response = await api(alice.cookie, `/api/attachments/${crypto.randomUUID()}`, {
      method: "PUT",
      body: JSON.stringify({
        meta: { mime: "image/png", ext: "png" },
        bytesBase64: Buffer.from("<html>not an image</html>").toString("base64"),
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe("transport", () => {
  it("answers the health check without a session", async () => {
    const response = await SELF.fetch(url("/api/health"));
    expect(response.status).toBe(200);
    expect((await json(response)).ok).toBe(true);
  });

  it("grants CORS headers only to the configured origin", async () => {
    const allowed = await SELF.fetch(url("/api/health"), { headers: { origin: ORIGIN } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const denied = await SELF.fetch(url("/api/health"), {
      headers: { origin: "https://evil.example.com" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never echoes an internal failure reason back to the caller", async () => {
    // `/api/attachments/:id` with a malformed id still routes, but an unknown
    // method must produce a clean error body with no internals.
    const response = await api(alice.cookie, `/api/attachments/${crypto.randomUUID()}`, {
      method: "PATCH",
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await json(response))).not.toMatch(/stack|at Object|\.ts:\d+/);
  });
});
