import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { Env } from "./env";

/**
 * Better Auth on D1. The `database: env.DB` form is the documented Cloudflare
 * D1 integration (Kysely under the hood); there is no separate D1 adapter.
 *
 * The instance is memoised per isolate because constructing it reads the schema
 * metadata. The cache key includes the secret and origin so a changed
 * environment never reuses a stale instance.
 */
function buildAuth(env: Env) {
  const secure = env.APP_ORIGIN.startsWith("https://");
  return betterAuth({
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL ?? env.APP_ORIGIN,
    basePath: "/api/auth",
    ...(env.BETTER_AUTH_SECRET ? { secret: env.BETTER_AUTH_SECRET } : {}),
    // Email verification and password reset need an email transport, which is an
    // external service; see docs/DECISIONS.md. The single-user MVP runs without
    // it and the UI states so.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    // Native/desktop clients do not have a cookie jar: the bearer plugin returns
    // the session token in `set-auth-token` and accepts `Authorization: Bearer`.
    plugins: [bearer()],
    trustedOrigins: [env.APP_ORIGIN],
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure,
      },
    },
  });
}

// Inferred from the concrete options above. `ReturnType<typeof betterAuth>`
// would instantiate the library's generic with its *default* option type and
// lose every literal we passed, which then fails to accept the real instance.
type Auth = ReturnType<typeof buildAuth>;

let cached: { key: string; auth: Auth } | null = null;

export function getAuth(env: Env): Auth {
  const key = `${env.BETTER_AUTH_SECRET ?? "unset"}|${env.APP_ORIGIN}`;
  if (cached && cached.key === key) return cached.auth;
  const auth = buildAuth(env);
  cached = { key, auth };
  return auth;
}

export interface SessionUser {
  id: string;
  email: string;
}

/**
 * Resolves the caller from the verified session (cookie *or* bearer token).
 * Every data endpoint goes through this, and the resulting id is the only
 * source of ownership — a `user_id` in a request body is always ignored.
 */
export async function requireUser(env: Env, request: Request): Promise<SessionUser | null> {
  if (!env.BETTER_AUTH_SECRET) {
    // Unconfigured deployments must fail closed rather than serve anonymous data.
    return null;
  }
  try {
    const session = await getAuth(env).api.getSession({ headers: request.headers });
    const user = session?.user;
    if (!user || typeof user.id !== "string") return null;
    return { id: user.id, email: typeof user.email === "string" ? user.email : "" };
  } catch {
    return null;
  }
}
