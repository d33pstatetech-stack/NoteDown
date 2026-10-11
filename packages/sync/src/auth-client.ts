/**
 * Authentication client.
 *
 * Two very different clients need the same three operations, so they are
 * described once here and implemented twice:
 *
 * * **Browser** — Better Auth sets an `HttpOnly` cookie. JavaScript can never
 *   read it; every call is made with `credentials: "include"` and the cookie
 *   rides along automatically.
 * * **Desktop** — the Tauri webview has no cookie jar. The bearer plugin returns
 *   the session token in a `set-auth-token` response header, which is stored
 *   outside the webview (see `set_sync_token` in the Rust core) and replayed as
 *   `Authorization: Bearer`.
 *
 * Both talk to the same Worker routes, so there is exactly one server contract.
 */

export interface Account {
  id: string;
  email: string;
}

export interface AuthClient {
  /** Restores an existing session, or returns null when signed out. */
  currentUser(): Promise<Account | null>;
  signUp(email: string, password: string, name: string): Promise<Account>;
  signIn(email: string, password: string): Promise<Account>;
  signOut(): Promise<void>;
  /** True when this client keeps a bearer token rather than a cookie. */
  readonly usesBearerToken: boolean;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_credentials" | "email_taken" | "unavailable" | "unknown",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Pulls a readable error out of Better Auth's JSON error envelope. */
async function describeFailure(response: Response, fallback: string): Promise<AuthError> {
  let code = "unknown";
  let message = fallback;
  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      error?: { code?: string; message?: string };
    };
    // Better Auth puts the code at the top level; older shapes nest it.
    code = body.code ?? body.error?.code ?? code;
    message = body.message ?? body.error?.message ?? message;
  } catch {
    // A non-JSON body is not worth reporting verbatim.
  }
  switch (code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
      return new AuthError(message, "invalid_credentials");
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return new AuthError(message, "email_taken");
    case "EMAIL_NOT_VERIFIED":
      return new AuthError("This account has not been verified yet.", "invalid_credentials");
    default:
      return new AuthError(message, response.status >= 500 ? "unavailable" : "unknown");
  }
}

/**
 * Shared request plumbing for both clients. Only the credential mechanism and
 * the origin differ.
 */
abstract class HttpAuthClient implements AuthClient {
  abstract readonly usesBearerToken: boolean;
  protected abstract credentialHeaders(): Promise<Headers>;

  constructor(protected readonly baseUrl: string) {}

  protected async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    for (const [key, value] of await this.credentialHeaders()) headers.set(key, value);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        // A bearer token is an explicit header; a cookie must ride along
        // automatically. Sending the cookie *and* the token would be rejected by
        // the session check as an ambiguous credential.
        credentials: this.usesBearerToken ? "omit" : "include",
      });
    } catch (error) {
      throw new AuthError(
        `Could not reach ${this.baseUrl}: ${error instanceof Error ? error.message : "network error"}`,
        "unavailable",
      );
    }
    return response;
  }

  async currentUser(): Promise<Account | null> {
    const response = await this.request("/api/me");
    // 401 is the normal "signed out" answer, not a failure.
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw await describeFailure(response, "Could not check the session");
    const body = (await response.json()) as { user: Account };
    return body.user;
  }

  async signUp(email: string, password: string, name: string): Promise<Account> {
    const response = await this.request("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    });
    if (!response.ok) throw await describeFailure(response, "Could not create the account");
    await this.captureToken(response);
    const account = await this.currentUser();
    if (!account) throw new AuthError("The account was created but no session was returned", "unknown");
    return account;
  }

  async signIn(email: string, password: string): Promise<Account> {
    const response = await this.request("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw await describeFailure(response, "Could not sign in");
    await this.captureToken(response);
    const account = await this.currentUser();
    if (!account) throw new AuthError("Signed in, but the session could not be read back", "unknown");
    return account;
  }

  async signOut(): Promise<void> {
    try {
      await this.request("/api/auth/sign-out", { method: "POST" });
    } finally {
      // The local token is cleared even if the network call failed: keeping a
      // credential we could not revoke is strictly worse than losing one.
      await this.clearToken();
    }
  }

  /** No-op for the cookie client; overridden by the bearer client. */
  protected async captureToken(_response: Response): Promise<void> {}
  protected async clearToken(): Promise<void> {}
}

/**
 * Browser client. The session lives entirely in an `HttpOnly` cookie, so there
 * is no token for JavaScript to read, hold or leak through XSS.
 */
export class CookieAuthClient extends HttpAuthClient {
  readonly usesBearerToken = false;

  protected override async credentialHeaders(): Promise<Headers> {
    // The browser attaches the cookie itself.
    return new Headers();
  }
}

/** Reads/writes the bearer token a native shell stores outside the webview. */
export interface TokenVault {
  get(): Promise<string | null>;
  set(token: string | null): Promise<void>;
}

/**
 * Desktop client. The token is exchanged through the Rust core so it never
 * touches `localStorage`, is not part of the SQLite database, and cannot end up
 * inside a ZIP export.
 */
export class BearerAuthClient extends HttpAuthClient {
  readonly usesBearerToken = true;

  constructor(
    baseUrl: string,
    private readonly vault: TokenVault,
  ) {
    super(baseUrl);
  }

  protected override async credentialHeaders(): Promise<Headers> {
    const token = await this.vault.get();
    const headers = new Headers();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  protected override async captureToken(response: Response): Promise<void> {
    const token = response.headers.get("set-auth-token");
    // A missing header means the deployment has no bearer plugin; fall back to
    // cookies rather than storing an empty credential that would always 401.
    if (token) await this.vault.set(token);
  }

  protected override async clearToken(): Promise<void> {
    await this.vault.set(null);
  }
}

/**
 * A vault backed by `localStorage`, for a browser build that must use bearer
 * tokens (for example a static host with no cookie support). Not the default:
 * `HttpOnly` cookies are strictly safer in a browser.
 */
export function createLocalStorageVault(key: string): TokenVault {
  return {
    async get() {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    async set(token) {
      try {
        if (token === null) globalThis.localStorage?.removeItem(key);
        else globalThis.localStorage?.setItem(key, token);
      } catch {
        // Private browsing: the session simply will not persist across reloads.
      }
    },
  };
}
