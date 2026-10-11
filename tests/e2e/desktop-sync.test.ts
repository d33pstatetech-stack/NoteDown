/**
 * Drives the **real** desktop storage core — the Rust SQLite implementation the
 * Tauri app ships — through the real sync protocol against a real Worker.
 *
 * The TypeScript `TauriBackend` is instantiated with an `invoke` function that
 * forwards to a small Rust bridge binary, so the code under test is the actual
 * `crates/notes-store` (transactions, migrations, attachment files on disk), not
 * a JavaScript imitation of it.
 *
 * Requires `E2E_API_URL` and `E2E_SQLITE_BRIDGE` (see `scripts/e2e.sh`).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { Store } from "@localnotes/shared";
import { TauriBackend, type InvokeFn } from "@localnotes/storage";
import { HttpRemoteClient, SyncEngine } from "@localnotes/sync";

const API_URL = process.env["E2E_API_URL"];
const BRIDGE = process.env["E2E_SQLITE_BRIDGE"];
const ORIGIN = process.env["E2E_ORIGIN"] ?? "http://localhost:5173";
const PASSWORD = "Sup3r-secret!23";

const live = Boolean(API_URL && BRIDGE);
const describeLive = live ? describe : describe.skip;

let bridgeProcess: ChildProcessWithoutNullStreams | undefined;
let bridgeBuffer = "";
/** Replies awaiting their turn, in the order the requests were written. */
let bridgeQueue: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];

/**
 * Keeps one bridge process alive for the whole suite and serialises requests
 * through it. The bridge speaks line-delimited JSON, so this needs exactly one
 * reader for stdout and one FIFO of pending replies — a `data` listener per
 * request would race and mis-split lines.
 */
function bridgeInvoke(databaseDir: string): InvokeFn {
  return <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const child = bridgeProcess;
    if (!child) throw new Error("the SQLite bridge is not running");
    return new Promise<T>((resolve, reject) => {
      bridgeQueue.push({ resolve: resolve as (value: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ command, params: args ?? {}, dir: databaseDir })}\n`);
    });
  };
}

/**
 * Starts the bridge and wires its stdout to the FIFO above. Splitting on
 * newlines here (once) is what keeps concurrent callers correct.
 */
function startBridge(executable: string): ChildProcessWithoutNullStreams {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bridgeBuffer += chunk;
    let newline = bridgeBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = bridgeBuffer.slice(0, newline).trim();
      bridgeBuffer = bridgeBuffer.slice(newline + 1);
      const waiter = bridgeQueue.shift();
      if (waiter && line.length > 0) {
        try {
          const reply = JSON.parse(line) as { ok: boolean; value?: unknown; error?: string };
          if (reply.ok) waiter.resolve(reply.value);
          else waiter.reject(new Error(reply.error ?? "bridge command failed"));
        } catch (error) {
          waiter.reject(error as Error);
        }
      }
      newline = bridgeBuffer.indexOf("\n");
    }
  });
  // A bridge crash must fail every outstanding call rather than hang forever.
  child.on("exit", (code) => {
    const pending = bridgeQueue.splice(0, bridgeQueue.length);
    for (const waiter of pending) waiter.reject(new Error(`SQLite bridge exited with code ${code}`));
  });
  return child;
}

/**
 * Closes the bridge's stdin (its natural shutdown signal) and waits for the
 * process to finish releasing its SQLite handles.
 */
function waitForExit(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.stdin.end();
  });
}

async function signUp(email: string): Promise<string> {
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD, name: "Desktop E2E" }),
  });
  if (!response.ok) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  return (response.headers.get("set-auth-token") ?? "").trim();
}

describeLive("desktop SQLite core syncing through the real Worker", () => {
  let dataDir: string;
  let token: string;
  let desktop: Store;
  let desktopSync: SyncEngine;
  let remote: Store;
  let remoteSync: SyncEngine;

  beforeAll(async () => {
    bridgeProcess = startBridge(BRIDGE as string);

    dataDir = mkdtempSync(join(tmpdir(), "notedown-e2e-"));
    token = await signUp(`desktop.e2e.${Date.now()}@notedown.test`);

    desktop = new Store(new TauriBackend(bridgeInvoke(dataDir)));
    await desktop.init();
    desktopSync = new SyncEngine({
      store: desktop,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => token }),
    });

    remote = new Store(new TauriBackend(bridgeInvoke(`${dataDir}-second`)));
    await remote.init();
    remoteSync = new SyncEngine({
      store: remote,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => token }),
    });
  }, 60_000);

afterAll(async () => {
    // The bridge holds the SQLite files open, so the directories can only be
    // removed once the process has actually exited. `waitForExit` (not `kill`)
    // matters here: a bare kill returns immediately and Windows still reports
    // EPERM on the open database.
    await waitForExit(bridgeProcess);
    for (const dir of [dataDir, `${dataDir}-second`, `${dataDir}-third`]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

  it("writes real rows into SQLite and pushes them to the cloud", async () => {
    const notebook = await desktop.createNode({ kind: "notebook", parentId: null, title: "Desktop" });
    const note = await desktop.createNode({
      kind: "note",
      parentId: notebook.id,
      title: "Written on the desktop",
      content: "# Real SQLite\n\nthis text went through the Rust storage core",
    });

    const report = await desktopSync.run();
    expect(report.pushed).toBeGreaterThan(0);
    expect(await desktop.pendingCount()).toBe(0);

    // The second device — also a real SQLite database — receives it.
    const pulled = await remoteSync.run();
    expect(pulled.applied).toBeGreaterThan(0);
    const nodes = await remote.listNodes();
    const received = nodes.find((node) => node.id === note.id);
    expect(received?.content).toContain("the Rust storage core");
    expect(received?.syncState).toBe("synced");
  }, 60_000);

  it("survives a restart: the SQLite file is the source of truth", async () => {
    const before = await desktop.listNodes();
    const note = before.find((node) => node.kind === "note");
    expect(note).toBeDefined();

    // Re-open the same database through a brand-new backend instance, exactly
    // as relaunching the desktop app would.
    const reopened = new Store(new TauriBackend(bridgeInvoke(dataDir)));
    await reopened.init();
    const after = await reopened.listNodes();
    expect(after).toHaveLength(before.length);
    expect(after.find((node) => node.id === note?.id)?.content).toBe(note?.content);
  });

  it("round-trips an edit from the second device back to the desktop", async () => {
    const target = (await remote.listNodes()).find((node) => node.kind === "note");
    expect(target).toBeDefined();
    await remote.updateNode((target as { id: string }).id, {
      content: "edited on the second device, pulled by the desktop app",
    });
    expect((await remoteSync.run()).pushed).toBeGreaterThan(0);

    await desktopSync.run();
    const updated = (await desktop.listNodes()).find((node) => node.id === target?.id);
    expect(updated?.content).toContain("pulled by the desktop app");
  }, 60_000);

  it("stores attachment bytes on disk in the desktop store and syncs them", async () => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      ),
      (char) => char.charCodeAt(0),
    );
    const meta = await desktop.putAttachment({ noteId: null, filename: "desktop.png", bytes: png });
    const report = await desktopSync.run();
    expect(report.pushedAttachments).toBeGreaterThan(0);

    // The Rust core wrote the bytes to the attachments directory and the Worker
    // stored them in R2; the other device must receive identical bytes.
    await remoteSync.run();
    const received = await remote.getAttachment(meta.id);
    expect(received).not.toBeNull();
    expect(Array.from(received?.bytes ?? [])).toEqual(Array.from(png));
    expect(received?.meta.sha256).toBe(meta.sha256);
  }, 60_000);

  it("deletes through to the cloud and refuses resurrection", async () => {
    const target = (await remote.listNodes()).find((node) => node.kind === "note");
    expect(target).toBeDefined();
    await remote.deleteNode((target as { id: string }).id);
    await remoteSync.run();

    await desktopSync.run();
    expect(await desktop.getNode((target as { id: string }).id)).toBeNull();

    // A third device that pulls from scratch must also see the deletion.
    const third = new Store(new TauriBackend(bridgeInvoke(`${dataDir}-third`)));
    await third.init();
    const thirdSync = new SyncEngine({
      store: third,
      client: new HttpRemoteClient({ baseUrl: API_URL as string, getToken: () => token }),
    });
    await thirdSync.run();
    expect(await third.getNode((target as { id: string }).id)).toBeNull();
  }, 60_000);
});
