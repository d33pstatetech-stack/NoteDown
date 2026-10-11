# Security assumptions and controls

## 1. Trust boundaries

| Boundary | Assumption | Control |
|---|---|---|
| Browser ↔ Worker | Network is hostile | HTTPS only, secure `HttpOnly` session cookies (`SameSite=Lax`), CSRF-protected state-changing routes, restrictive CORS (`Access-Control-Allow-Origin` = the app origin, credentials allowed, no wildcard) |
| Desktop ↔ Worker | Same, plus no cookie jar | Better Auth **bearer** plugin: session token from `set-auth-token` stored in OS-protected storage, sent as `Authorization: Bearer` |
| Worker ↔ D1/R2 | Trusted | Bindings only; no Cloudflare API token in any client, no credentials in the repo |
| Client → client | Never trusted | Ownership is enforced in SQL (`WHERE user_id = ?`) from the **verified session**; ids in bodies are ignored |

## 2. Authentication

* Better Auth with the D1 binding (`database: env.DB`); no hand-rolled password
  hashing, session tokens, or crypto (explicitly out of scope to implement).
* Passwords are hashed by the library (scrypt/argon2 per its own defaults). Never
  logged, never stored by us.
* Email verification and password reset need an email transport, which is an
  external service — see `docs/DECISIONS.md` §D1. Until one is configured the
  app runs without email verification for the single-user case, and the UI says so.
* Sessions are server-side rows in D1; sign-out deletes the row. Session
  restoration on startup is a `GET /api/me` with the cookie (browser) or bearer
  token (desktop) — a `401` only downgrades the app to offline mode.

## 3. Authorization

* Every `/api/*` route resolves the user from the session before touching data.
* Cross-user access is prevented by scoping every read/write by `user_id` and by
  returning `404` (not `403`) for another user's id, so ids are not enumerable.
* **Tested**: cross-user notes, attachments and tombstones return 404; an
  unauthenticated request returns 401; a forged `user_id` field in the body is
  ignored.
* Attachment downloads are authorized the same way; R2 buckets are private with
  no public bucket URL and no `r2.dev` public access enabled.

## 4. Attaching local data to an account

An existing local database is **never** silently bound to whichever account signs
in. The app stores a `localOwnerId` once linked; if a different account signs in,
it refuses to sync and offers **Link account**, **Export**, or **Import**.
Unlinking is explicit and requires typing the account email to confirm.

## 5. Input validation

* Attachment uploads: MIME sniffed from bytes (not the client's `Content-Type`),
  extension derived from the sniffed type, allow-list of image types, per-file
  size limit (default 5 MiB) and per-user total quota, `sha256` verified on
  commit.
* Filenames from a client are used only for display, never to build a path.
* Import: every archive entry is normalized and rejected if it is absolute, has a
  drive letter, contains `..`, backslashes, NUL, or a symlink, or exceeds limits
  — see `packages/markdown/src/import.ts` and its tests.

## 6. Secrets

* No real credentials in the repo. `.env.example` holds placeholders only.
* Cloudflare: `wrangler secret put <NAME>` (or the dashboard) for
  `BETTER_AUTH_SECRET`; account ids and database ids live in `wrangler.jsonc`
  and are not secrets, but `.env` is git-ignored regardless.
* Better Auth's secret must be ≥32 random bytes; rotating it invalidates existing
  sessions, which is the documented recovery path if it leaks.

## 7. What is explicitly *not* protected yet

* No end-to-end encryption: the server can read note content (needed for
  server-side export/validation and for the free-tier design). Encryption at rest
  is R2/D1's, not ours.
* No per-note sharing, no public links, no audit log.
* Local data at rest on the desktop and in the browser is **not encrypted**; an
  attacker with filesystem access can read notes. OS full-disk encryption is the
  mitigation.
