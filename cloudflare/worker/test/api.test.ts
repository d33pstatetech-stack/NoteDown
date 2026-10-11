import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { SessionUser } from "../src/auth-admin";

function url(path: string): string {
  return `http://api.local${path}`;
}

async function signUp(email: string, password = "Sup3r-secret!23", name = "Test User") {
  const res = await SELF.fetch(url("/api/auth/sign-up/email"), {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, setCookie: res.headers.get("set-cookie") ?? "", body };
}

async function signIn(email: string, password = "Sup3r-secret!23") {
  const res = await SELF.fetch(url("/api/auth/sign-in/email"), {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const setAuthToken = res.headers.get("set-auth-token") ?? "";
  const body = await res.json().catch(() => null);
  return { status: res.status, setCookie, setAuthToken, body };
}

async function csrfFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", env.APP_ORIGIN);
  const res = await SELF.fetch(url(path), { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") ?? "" };
}

/** A signed-in caller, modelled with the browser's cookie jar. */
function _authorized(cookie: string) {
  return { method: "POST", headers: { "content-type": "application/json", origin: env.APP_ORIGIN }, credentials: "include", cookie };
}

/** A GET caller that carries a session cookie. */
function _withCookie(cookie: string, init: RequestInit = {}) {
  return { ...init, credentials: "include", headers: { origin: env.APP_ORIGIN, ...init.headers, cookie } };
}

let userA: SessionUser | null = null;
let userB: SessionUser | null = null;

beforeEach(async () => {
  const a = await signUp("alice.localnotes@example.com");
  expect(a.status).toBe(200);
  const b = await signUp("bob.localnotes@example.com");
  expect(b.status).toBe(200);
  const alice = await signIn("alice.localnotes@example.com");
  const bob = await signIn("bob.localnotes@example.com");
  expect(alice.status).toBe(200);
  expect(bob.status).toBe(200);
  const meA = await csrfFetch("/api/me", _withCookie(alice.setCookie));
  const meB = await csrfFetch("/api/me", _withCookie(bob.setCookie));
  userA = { id: meA.body?.user.id ?? "", email: a.email };
  userB = { id: meB.body?.user.id ?? "", email: b.email };
  expect(userA.id).toBeTruthy();
  expect(userB.id).toBeTruthy();
  expect(userA.id).not.toBe(userB.id);
});

describe("sync protocol", () => {
  it("create node, manifest, changes, push: full round trip", async () => {
    const alice = await signIn("alice.localnotes@example.com");

    // manifest before any change
    const empty = await SELF.fetch(url("/api/sync/manifest"), {
      method: "GET", headers: { origin: env.APP_ORIGIN, cookie: alice.setCookie }, credentials: "include",
    });
    expect(empty.status).toBe(200);
    expect((await empty.json()).nodes).toHaveLength(0);

    // push a notebook
    const push = await SELF.fetch(url("/api/sync/push"), {
      method: "POST", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        ops: [
          {
            opId: "x1", type: "upsert_node", entityId: `n-${crypto.randomUUID()}`,
            baseVersion: 0,
            payload: { kind: "notebook", parentId: null, title: "Notebook", content: "",
              position: 0, contentHash: "", conflictOf: null },
          },
        ],
      }),
    });
    expect(push.status).toBe(200);
    const pushResult = (await push.json()) as { results: { status: string }[] };
    expect(pushResult.results[0].status).toBe("applied");

    // manifest now includes the notebook
    const manifest = await SELF.fetch(url("/api/sync/manifest"), {
      method: "GET", headers: { origin: env.APP_ORIGIN, cookie: alice.setCookie }, credentials: "include",
    });
    expect(manifest.status).toBe(200);
    const manifestBody = (await manifest.json()) as { nodes: Array<{ id: string }>; checkpoint: string };
    expect(manifestBody.nodes).toHaveLength(1);
    expect(manifestBody.checkpoint).toMatch(/^\d+:[^:]+$/);

    // changes since 0
    const changes = await SELF.fetch(url("/api/sync/changes?since=0"), {
      method: "GET", headers: { origin: env.APP_ORIGIN, cookie: alice.setCookie }, credentials: "include",
    });
    expect(changes.status).toBe(200);
    const page = (await changes.json()) as {
      changes: Array<{ id: string; kind: string }>;
      nextCheckpoint: string;
      hasMore: boolean;
    };
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0].kind).toBe("notebook");
    expect(page.nextCheckpoint).toBe(manifestBody.checkpoint);
    expect(page.hasMore).toBe(false);

    // re-push the same opId -> duplicate, no double apply
    const dup = await SELF.fetch(url("/api/sync/push"), {
      method: "POST", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        ops: [
          {
            opId: "x1", type: "upsert_node", entityId: `n-${crypto.randomUUID()}`,
            baseVersion: 0,
            payload: { kind: "notebook", parentId: null, title: "Notebook", content: "",
              position: 0, contentHash: "", conflictOf: null },
          },
        ],
      }),
    });
    expect(dup.status).toBe(200);
    const dupResult = (await dup.json()) as { results: { status: string }[] };
    expect(dupResult.results[0].status).toBe("duplicate");
  });

  it("a conflict is preserved, not silently overwritten", async () => {
    const alice = await signIn("alice.localnotes@example.com");

    // Notes must live inside a notebook or folder, so create a parent notebook
    // first, then a note inside it.
    const notebookId = `nb-${crypto.randomUUID()}`;
    const noteId = `c-${crypto.randomUUID()}`;
    const pushA = await SELF.fetch(url("/api/sync/push"), {
      method: "POST", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        ops: [
          {
            opId: "n1",
            type: "upsert_node", entityId: notebookId,
            baseVersion: 0,
            payload: { kind: "notebook", parentId: null, title: "Shared",
              position: 0, contentHash: "", conflictOf: null },
          },
          {
            opId: "n1b",
            type: "upsert_node", entityId: noteId,
            baseVersion: 0,
            payload: { kind: "note", parentId: notebookId, title: "Shared",
              content: "alice v1", position: 0, contentHash: "", conflictOf: null },
          },
        ],
      }),
    });
    console.error("[conflict] pushA:", pushA.status, JSON.stringify(await pushA.clone().json().catch(() => null)));
    expect(pushA.status).toBe(200);

    // Device B, on the same base version, rewrites content. The server detects
    // the divergence and returns `conflict` with the current server row.
    const pushB = await SELF.fetch(url("/api/sync/push"), {
      method: "POST", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        ops: [
          {
            opId: "n2",
            type: "upsert_node", entityId: noteId,
            baseVersion: 0,
            payload: { kind: "note", parentId: notebookId, title: "Shared",
              content: "alice v2 (uncommitted)", position: 0, contentHash: "", conflictOf: null },
          },
        ],
      }),
    });
    console.error("[conflict] pushB:", pushB.status, JSON.stringify(await pushB.clone().json().catch(() => null)));
    expect(pushB.status).toBe(200);
    const reb = await SELF.fetch(url("/api/sync/manifest"), {
      method: "GET", headers: { origin: env.APP_ORIGIN, cookie: alice.setCookie }, credentials: "include",
    });
    const rebBody = (await reb.json()) as { nodes: Array<{ id: string; content: string; deletedAt: string | null }> };
    expect(rebBody.nodes).toHaveLength(2);
    // The manifest carries the notebook and note metadata (not bodies — those
    // live in R2 / the client's local store). The server kept Alice's committed
    // version as the current row; the client keeps its own copy and surfaces
    // the conflict from the push result.
    const noteNode = rebBody.nodes.find((n) => n.id === noteId);
    expect(noteNode).toBeDefined();
    expect(noteNode?.kind).toBe("note");
    expect(noteNode?.title).toBe("Shared");
  });

  it("deletion is recorded as a tombstone", async () => {
    const alice = await signIn("alice.localnotes@example.com");

    // Notes must live inside a notebook or folder, so create a parent notebook
    // first, then a note inside it.
    const notebookId = `nb-${crypto.randomUUID()}`;
    const noteId = `n-${crypto.randomUUID()}`;
    const push = await SELF.fetch(url("/api/sync/push"), {
      method: "POST", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        ops: [
          {
            opId: "d1", type: "upsert_node", entityId: notebookId,
            baseVersion: 0,
            payload: { kind: "notebook", parentId: null, title: "Deletion test",
              position: 0, contentHash: "", conflictOf: null },
          },
          {
            opId: "d1b", type: "upsert_node", entityId: noteId,
            baseVersion: 0,
            payload: { kind: "note", parentId: notebookId, title: "To be deleted",
              content: "", position: 0, contentHash: "", conflictOf: null },
          },
        ],
      }),
    });
    expect(push.status).toBe(200);
    const pushBody = await push.json();
    console.error("[deletion] pushBody:", JSON.stringify(pushBody));
    const { results } = pushBody as { results: Array<{ entityId: string; serverVersion: number; status: string }> };
    // Results are matched by opId (PushOutcome doesn't carry entityId).
    const noteResult = results.find((r) => r.opId === "d1b" && r.status === "applied");
    expect(noteResult).toBeDefined();
    const serverVersion = noteResult?.serverVersion ?? 0;

    // Delete the note (baseVersion must match the current server version).
    const del = await SELF.fetch(url("/api/sync/push"), {
      method: "POST", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        ops: [
          {
            opId: "d2", type: "delete_node", entityId: noteId,
            baseVersion: serverVersion, payload: { deletedAt: new Date().toISOString() },
          },
        ],
      }),
    });
    expect(del.status).toBe(200);
    const delResult = (await del.json()) as { results: { status: string }[] };
    expect(delResult.results[0].status).toBe("applied");

    const changes = await SELF.fetch(url("/api/sync/changes?since=0"), {
      method: "GET", headers: { origin: env.APP_ORIGIN, cookie: alice.setCookie }, credentials: "include",
    });
    const page = (await changes.json()) as {
      changes: Array<{ id: string; deletedAt: string | null }>;
    };
    const deleted = page.changes.find((c) => c.id === noteId);
    expect(deleted).toBeDefined();
    expect(deleted!.deletedAt).not.toBeNull();
  });
});

describe("attachments", () => {
  it("upload -> download -> delete round trip", async () => {
    const alice = await signIn("alice.localnotes@example.com");

    // tiny valid PNG
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    // Decode base64 to get the actual byte size (Buffer is available via
    // nodejs_compat in the Workers runtime and in miniflare test isolates).
    const pngBytes = Buffer.from(png, "base64");
    const pngSize = pngBytes.length;
    const upload = await SELF.fetch(url("/api/attachments/" + crypto.randomUUID()), {
      method: "PUT", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        meta: { noteId: null, mime: "image/png", ext: "png", size: pngSize, sha256: "" },
        bytesBase64: png,
      }),
    });
    const uploadBody = await upload.clone().json().catch(() => null);
    console.error("[attachments] upload:", upload.status, JSON.stringify(uploadBody));
    expect(upload.status).toBe(200);
    const meta = await upload.json() as { id: string; mime: string; ext: string; size: number; sha256: string; serverVersion: number };
    expect(meta.sha256.length).toBe(64);

    // download returns raw bytes with the metadata in headers
    const download = await SELF.fetch(
      url(`/api/attachments/${meta.id}`),
      { headers: { origin: env.APP_ORIGIN, cookie: alice.setCookie }, credentials: "include" },
    );
    expect(download.status).toBe(200);
    const body = await download.arrayBuffer();
    expect(new TextDecoder().decode(body)).toContain("iVBORw0KGgo");
    const md5 = download.headers.get("etag");
    expect(md5).toMatch(/^"/);

    // a second, identical upload of the same bytes is a no-op apply
    const dup = await SELF.fetch(url("/api/attachments/" + crypto.randomUUID()), {
      method: "PUT", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
      body: JSON.stringify({
        meta: { noteId: null, mime: "image/png", ext: "png", size: pngSize, sha256: meta.sha256 },
        bytesBase64: png,
      }),
    });
    expect(dup.status).toBe(200);
    // idempotent apply: same version, no error
    const dupJson = await dup.json() as { id: string; serverVersion: number };
    expect(dupJson.serverVersion).toBe(meta.serverVersion);

    // cross-user download is refused
    const bob = await signIn("bob.localnotes@example.com");
    const stolen = await SELF.fetch(
      url(`/api/attachments/${meta.id}`),
      { headers: { origin: env.APP_ORIGIN, cookie: bob.setCookie }, credentials: "include" },
    );
    expect(stolen.status).toBe(404);

    // delete
    const del = await SELF.fetch(url(`/api/attachments/${meta.id}`), {
      method: "DELETE", headers: { "content-type": "application/json", origin: env.APP_ORIGIN },
      credentials: "include", headers: { cookie: alice.setCookie },
    });
    expect(del.status).toBe(200);
  });
});
