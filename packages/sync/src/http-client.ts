import {
  NetworkError,
  StaleCheckpointError,
  UnauthorizedError,
  sha256Hex,
  toBase64,
} from "@localnotes/shared";
import type { AttachmentMeta } from "@localnotes/shared";
import type {
  ChangesPage,
  PushOp,
  PushResponse,
  RemoteAttachment,
  RemoteSyncClient,
} from "./client";

export interface HttpRemoteClientOptions {
  baseUrl: string;
  /**
   * Supplies the session credential. The browser uses a secure `HttpOnly`
   * cookie (so this returns nothing and `credentials: "include"` is used); the
   * desktop client returns a bearer session token from OS storage.
   */
  getToken?: () => Promise<string | null> | string | null;
  fetchImpl?: typeof fetch;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

/** Phase 2/3 transport: the only place in the codebase that speaks HTTP. */
export class HttpRemoteClient implements RemoteSyncClient {
  constructor(private readonly options: HttpRemoteClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    if (!doFetch) throw new NetworkError("No fetch implementation is available");
    const token = await this.options.getToken?.();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: token ? "omit" : "include",
        cache: "no-store",
      });
    } catch (error) {
      throw new NetworkError("Could not reach the sync server", { cause: error });
    }

    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedError("The session is no longer valid; sign in again to sync");
    }
    if (!response.ok) {
      let body: ErrorBody = {};
      try {
        body = (await response.json()) as ErrorBody;
      } catch {
        // ignore malformed error bodies
      }
      const message = body.error?.message ?? `Sync request failed (${response.status})`;
      // `stale_checkpoint` is a protocol signal, not a transport failure: the
      // engine has to clear its cursor and pull from zero instead of retrying.
      if (body.error?.code === "stale_checkpoint") throw new StaleCheckpointError(message);
      throw new NetworkError(message, {
        details: { status: response.status, code: body.error?.code },
      });
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  push(ops: readonly PushOp[]): Promise<PushResponse> {
    return this.request<PushResponse>("/api/sync/push", {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
  }

  fetchChanges(since: string | null, limit = 200): Promise<ChangesPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (since) params.set("since", since);
    return this.request<ChangesPage>(`/api/sync/changes?${params.toString()}`);
  }

  uploadAttachment(meta: AttachmentMeta, bytes: Uint8Array): Promise<{ serverVersion: number }> {
    return this.request<{ serverVersion: number }>(`/api/attachments/${meta.id}`, {
      method: "PUT",
      body: JSON.stringify({
        meta: { noteId: meta.noteId, mime: meta.mime, ext: meta.ext, size: meta.size, sha256: meta.sha256 },
        bytesBase64: toBase64(bytes),
      }),
    });
  }

  /**
   * Downloads attachment bytes.
   *
   * The server answers with the raw object (so the URL also works as an
   * `<img src>`), and sends the metadata the client must store in
   * `x-attachment-*` headers — hence the dedicated binary path rather than the
   * JSON helper above. `null` means the server genuinely does not have it;
   * every other failure throws.
   */
  async downloadAttachment(
    id: string,
  ): Promise<{ meta: RemoteAttachment; bytes: Uint8Array } | null> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    if (!doFetch) throw new NetworkError("No fetch implementation is available");
    const token = await this.options.getToken?.();
    const headers = new Headers({ accept: "*/*" });
    if (token) headers.set("authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl}/api/attachments/${id}`, {
        headers,
        credentials: token ? "omit" : "include",
        cache: "no-store",
      });
    } catch (error) {
      throw new NetworkError("Could not reach the sync server", { cause: error });
    }

    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedError("The session is no longer valid; sign in again to sync");
    }
    if (!response.ok) {
      throw new NetworkError(`Sync request failed (${response.status})`, {
        details: { status: response.status },
      });
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const mime = response.headers.get("x-attachment-mime") ?? "application/octet-stream";
    return {
      meta: {
        id,
        noteId: response.headers.get("x-attachment-note-id") || null,
        mime,
        ext: response.headers.get("x-attachment-ext") ?? extensionFor(mime),
        size: Number(response.headers.get("x-attachment-size") ?? bytes.length),
        sha256: response.headers.get("x-attachment-sha256") ?? (await sha256Hex(bytes)),
        serverVersion: Number(response.headers.get("x-attachment-version") ?? 0),
      },
      bytes,
    };
  }

  async deleteAttachment(id: string): Promise<void> {
    await this.request<void>(`/api/attachments/${id}`, { method: "DELETE" });
  }
}

function extensionFor(mime: string): string {
  const ext = mime.split("/")[1] ?? "bin";
  return ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
}
