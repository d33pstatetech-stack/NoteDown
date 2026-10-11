/**
 * Guards the auth strategy the hosted web build must use.
 *
 * The Pages site and the Worker are different sites, so the session cookie's
 * `SameSite=Lax` makes a browser withhold it on cross-site XHR. If the app ever
 * falls back to cookie auth, sign-in appears to succeed but every subsequent
 * request is anonymous — and the sync queue silently never drains. This test
 * fails loudly instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AuthHeaders {
  authorization?: string;
  cookie?: string;
}

/**
 * The Worker, reduced to the two behaviours that matter here: it issues a
 * bearer token and sets a `SameSite=Lax` cookie, exactly as Better Auth does.
 */
function makeWorker(): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: AuthHeaders[];
} {
  const requests: AuthHeaders[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        authorization: headers.get("authorization") ?? undefined,
        cookie: headers.get("cookie") ?? undefined,
      });

      // Sign-in and sign-up are unauthenticated by definition — the client has
      // no credential yet. They are the requests that must *receive* one.
      const isAuthEntry = url.includes("/api/auth/sign-in") || url.includes("/api/auth/sign-up");
      const isAnonymous = isAuthEntry || url.endsWith("/api/auth/sign-out");

      if (!isAnonymous && !headers.get("authorization") && !headers.get("cookie")) {
        return new Response(JSON.stringify({ user: null }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }

      // The server issues both a bearer token and a cross-site cookie. Only the
      // token may become the credential, because the cookie is `SameSite=Lax`
      // and the Pages site is a different site from the Worker.
      return new Response(JSON.stringify({ user: { id: "u1", email: "a@b.c" } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-auth-token": "bearer-token-value",
          "set-cookie": "__Secure-better-auth.session_token=x; HttpOnly; Secure; SameSite=Lax",
        },
      });
    },
  };
}

/**
 * A minimal, spec-shaped `Storage`. The project's jsdom environment exposes a
 * bare `localStorage` object without methods, so the vault's `try/catch` would
 * silently swallow every read and write — which is precisely the failure mode
 * that leaves a browser signed out with no error. Using a real implementation
 * keeps the test honest.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(String(key)) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(String(key)),
    setItem: (key: string, value: string) => void map.set(String(key), String(value)),
  } as Storage;
}

describe("hosted web auth strategy", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a bearer token, not the cross-site cookie", async () => {
    const worker = makeWorker();
    vi.stubGlobal("fetch", worker.fetch);

    // Imported dynamically so the module picks up the stubbed globals.
    const { BearerAuthClient, createLocalStorageVault } = await import(
      "@localnotes/sync"
    );
    const client = new BearerAuthClient(
      "https://notedown-api.d33pstatetech.workers.dev",
      createLocalStorageVault("notedown.auth.token"),
    );

    const account = await client.signUp(
      "browser@notedown.test",
      "Sup3r-secret!23",
      "Browser",
    );
    expect(account.email).toBe("a@b.c");
    // The cookie the server set must NOT be the credential in use, or the
    // browser would drop it and every later request would 401.
    const last = worker.requests.at(-1);
    expect(last?.authorization).toMatch(/^Bearer /);
    expect(last?.cookie).toBeUndefined();
  });

  it("re-attaches the stored token after a reload, with no cookie", async () => {
    const worker = makeWorker();
    vi.stubGlobal("fetch", worker.fetch);
    const { BearerAuthClient, createLocalStorageVault } = await import(
      "@localnotes/sync"
    );

    const first = new BearerAuthClient(
      "https://notedown-api.d33pstatetech.workers.dev",
      createLocalStorageVault("notedown.auth.token"),
    );
    await first.signUp("b@notedown.test", "Sup3r-secret!23", "B");

    // A fresh client is what a page reload produces: no in-memory state, only
    // whatever the vault persisted.
    const afterReload = new BearerAuthClient(
      "https://notedown-api.d33pstatetech.workers.dev",
      createLocalStorageVault("notedown.auth.token"),
    );
    const me = await afterReload.currentUser();
    expect(me?.email).toBe("a@b.c");

    const last = worker.requests.at(-1);
    expect(last?.authorization).toBe("Bearer bearer-token-value");
    expect(last?.cookie).toBeUndefined();
  });
});