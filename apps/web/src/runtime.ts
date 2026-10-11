/**
 * Builds the runtime the app actually runs on: a local store, an optional cloud
 * sync client, and the account that ties them together.
 *
 * Both shells (browser and Tauri) share this, so there is exactly one place that
 * decides which adapter and which transport are used. Everything here is
 * defensive about a missing configuration: a build with no API URL is a fully
 * functional offline app, never a broken one.
 */
import { Store } from "@localnotes/shared";
import { selectBackend } from "@localnotes/storage";
import { HttpRemoteClient, SyncEngine } from "@localnotes/sync";
import type { AuthClient, RemoteSyncClient } from "@localnotes/sync";
import { META_KEYS } from "@localnotes/shared";
import { isDesktop, loadDesktopToken, saveDesktopToken } from "./desktop";

export interface Runtime {
  store: Store;
  /** Null when no backend is configured; the app then runs local-only. */
  sync: SyncEngine | null;
  auth: AuthClient | null;
  /** True once the local database has been linked to an account. */
  linkedAccountId: string | null;
  markLinkedAccount(id: string | null): Promise<void>;
}

export interface RuntimeOptions {
  /** Overrides the API base URL. Falls back to `VITE_API_URL` at build time. */
  apiUrl?: string | null;
  /** Overrides the storage adapter (tests inject a fake here). */
  backend?: ReturnType<typeof selectBackend>;
  /** Overrides the transport (tests drive a mock remote here). */
  client?: RemoteSyncClient | null;
  auth?: AuthClient | null;
}

/**
 * Reads the API base URL from the build.
 *
 * `VITE_API_URL` is inlined by Vite at build time. It is deliberately absent by
 * default so a checkout with no configuration still runs; `docs/DEPLOYMENT.md`
 * explains how to set it per environment.
 */
function configuredApiUrl(explicit?: string | null): string | null {
  const value =
    explicit ?? (import.meta.env?.VITE_API_URL as string | undefined) ?? null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\/+$/, "");
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const store = new Store(options.backend ?? selectBackend());
  const baseUrl = configuredApiUrl(options.apiUrl);

  // The database is opened here, before any sync can run, so the engine never
  // reads a half-initialised store. `App` calls `init()` again, which is
  // idempotent by design (the backend short-circuits once opened).
  await store.init();

  // No backend configured: local-only. This is a supported mode, not an error.
  if (!baseUrl && !options.client) {
    return {
      store,
      sync: null,
      auth: null,
      linkedAccountId: null,
      async markLinkedAccount() {
        /* no account to link */
      },
    };
  }

  const linkedAccountId = await store.getMeta(META_KEYS.localOwnerId);

  // The desktop webview has no cookie jar, and the hosted browser app cannot rely
// on one either: the Pages site and the Worker are different sites, so the
// session cookie's `SameSite=Lax` makes browsers withhold it on cross-site
// XHR. Both therefore authenticate with a bearer token — the desktop in the Rust
// core, the browser in `localStorage`.
const client: RemoteSyncClient =
    options.client ??
    new HttpRemoteClient({
      baseUrl: baseUrl as string,
      getToken: isDesktop() ? loadDesktopToken : loadBrowserToken,
    });

  const auth: AuthClient | null =
    options.auth ?? (await createAuthClient(baseUrl as string));

  const sync = new SyncEngine({ store, client });

  return {
    store,
    sync,
    auth,
    linkedAccountId,
    async markLinkedAccount(id: string | null) {
      await store.setMeta(META_KEYS.localOwnerId, id);
    },
  };
}

/** Key for the browser's bearer token. Namespaced so it cannot collide. */
const BROWSER_TOKEN_KEY = "notedown.auth.token";

function loadBrowserToken(): Promise<string | null> {
  try {
    return Promise.resolve(globalThis.localStorage?.getItem(BROWSER_TOKEN_KEY) ?? null);
  } catch {
    // Private-mode browsers can throw on localStorage; an anonymous session is
    // still usable, it just cannot restore itself across reloads.
    return Promise.resolve(null);
  }
}

async function createAuthClient(baseUrl: string): Promise<AuthClient | null> {
  const { BearerAuthClient, createLocalStorageVault } = await import("@localnotes/sync");
  if (isDesktop()) {
    return new BearerAuthClient(baseUrl, {
      get: loadDesktopToken,
      set: saveDesktopToken,
    });
  }
  return new BearerAuthClient(baseUrl, createLocalStorageVault(BROWSER_TOKEN_KEY));
}

/**
 * Starts periodic sync and stops it when the app closes.
 *
 * The interval is short enough that a second device's edits arrive promptly and
 * long enough that an idle laptop is not waking up constantly. Sync only runs
 * when the app is visible, so a backgrounded tab costs nothing.
 */
export function startSyncLifecycle(sync: SyncEngine): () => void {
  if (typeof document === "undefined") return () => undefined;
  const stopTicking = sync.start({ intervalMs: 60_000 });

  const onVisibility = (): void => {
    if (document.visibilityState === "visible") void sync.run();
  };
  document.addEventListener("visibilitychange", onVisibility);
  // A device coming back online should sync immediately rather than wait out the
  // queue's exponential backoff.
  globalThis.addEventListener?.("online", onVisibility);

  return () => {
    stopTicking();
    document.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener?.("online", onVisibility);
  };
}
