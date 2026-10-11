# Technical decisions, compatibility verification, and open questions

## A. Compatibility verification (checked against official docs)

| Component | Version used | Verified | Notes |
|---|---|---|---|
| Node.js | 24.21 (sandbox) / `>=20.19` declared | Vite 7 requires Node 20.19+ or 22.12+; Vite 6 requires 18+ | Node 24 satisfies both |
| React | 19.x | react.dev/versions shows 19.1+ | `react-dom/client` API unchanged |
| Vite | 6.x (pin chosen deliberately) | vite.dev/guide | Vite 6 is stable and avoids Vite 7's stricter Node/rolldown churn |
| TypeScript | 5.7 strict | tsconfig `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | no `any` in source |
| CodeMirror 6 | `@codemirror/*` 6.x | codemirror.net/docs/changelog | `language-data` not used; `lang-markdown` + `lang-html` cover the GFM set |
| react-markdown | 9/10 + `remark-gfm` 4 | github.com/remarkjs/react-markdown | GFM tables, task lists, autolinks |
| ZIP | `fflate` | 0-dependency, browser + Node + Workers safe | no Node `zlib` dependency, so the same export code runs in the browser and in a Worker |
| SQLite (desktop) | `rusqlite` + bundled SQLite | rusqlite docs | Bundled build avoids requiring a system `libsqlite3` |
| Tauri | 2.x | v2.tauri.app | Linux build needs `webkit2gtk-4.1`/`gtk3` — **not available in this sandbox** (see §C) |
| Cloudflare Workers | Wrangler 4.x | developers.cloudflare.com/workers/wrangler | `wrangler.jsonc` recommended for new projects; `wrangler.toml` also supported |
| D1 | — | developers.cloudflare.com/d1 | foreign keys **enforced by default**; no long-lived `BEGIN/COMMIT` across Worker code — use `db.batch()`. Migrations: `wrangler d1 migrations create/apply` with versioned SQL |
| R2 | — | developers.cloudflare.com/r2 | private buckets, free egress |
| Better Auth | 1.x | better-auth.com/docs/concepts/database | D1 is supported via the built-in Kysely path: `betterAuth({ database: env.DB })`. CLI `migrate` cannot reach D1 directly → run `getMigrations(auth.options)` + `runMigrations()` from a protected Worker endpoint. Bearer plugin documented for non-cookie clients (desktop) |

Free-tier allowances assumed (must be re-checked against official pricing pages
before relying on them): Workers 100k requests/day and 10 ms CPU/invocation;
D1 5 GB total / 500 MB per free DB, 5M rows read and 100k rows written per day;
R2 10 GB-month storage, 1M Class A + 10M Class B operations per month, free
egress. Recorded in `docs/DEPLOYMENT.md`.

## B. Decisions made

1. **Unified `Node` table** rather than separate `notebooks`/`folders`/`notes`
   tables. A note is a tree node with `kind = 'note'`; moves are a `parentId`
   update; descendant queries are one recursive/iterative walk. Fewer tables,
   fewer invariants to break, and the same shape in SQLite, IndexedDB, D1.
2. **Attachments: metadata in the DB, bytes on disk (desktop) / in IndexedDB as
   `Blob` (web).** Keeps SQLite small and fast, lets large binaries stream, and
   matches the R2 model. The `AttachmentRepository` interface hides this, so
   moving bytes into SQLite is a local change to one adapter.
3. **SHA-256 of the Markdown source** as `contentHash`, implemented with Web
   Crypto (browser/Node/Workers) and `sha2` (Rust) so hashes agree across
   platforms. Used for change detection and conflict detection.
4. **Optimistic concurrency via `localVersion`.** Every local mutation bumps it;
   callers pass the version they read. Stale writes throw `VersionConflictError`
   instead of silently overwriting, which is the mechanism that protects an open
   editor buffer.
5. **Deletion = tombstone**, retained until every device has acknowledged it
   (server-side retention window documented in the sync protocol). A node absent
   from local cache is *never* treated as deleted.
6. **Conflicts preserve both sides.** When a remote change arrives for a note
   with unsynced local edits, the remote text is stored as a sibling node named
   `<title> (conflict copy YYYY-MM-DD HH:mm)` and the local text is kept; both
   get full metadata so either can be recovered. No silent last-writer-wins.
7. **`fflate` for ZIP** instead of a Node-only archiver, so export/import is
   identical in the browser, in the desktop webview, and (later) in a Worker.
8. **`packages/ui` is the single frontend**; `apps/web` is a thin Vite entry and
   `apps/desktop` bundles that same build. One UI to test, not two.
9. **Derived, not stored, paths.** The export path of a note is computed from its
   parent chain at export time; renames never touch persisted path data.
10. **`Store` is async everywhere**, including the in-memory and Tauri-backed
    implementations, so callers are identical on web and desktop.

## C. Environment constraints hit in this sandbox (not code defects)

* **No Rust toolchain preinstalled and no `sudo`.** `rustup` installs to
  `$HOME` (done as part of setup) so `cargo test` for `crates/notes-store` works.
* **No `webkit2gtk-4.1` / `gtk3`, and `apt-get` requires root.** The Tauri
  *window* cannot be linked in this sandbox, so `apps/desktop` cannot produce a
  Linux bundle here. Everything below the Tauri boundary *is* tested directly:
  the SQLite core has its own `cargo test` suite, and the TypeScript
  `TauriStore` adapter is tested against the same `Store` contract as the other
  adapters with a fake `invoke` bridge. Producing installers requires
  `bun install && pnpm dev:desktop` (or `tauri build`) on a machine with the
  Tauri prerequisites — `docs/DEPLOYMENT.md` lists the exact packages.

## D. Open questions (need a product decision before Phase 2/3)

1. **Email verification / password reset provider.** Better Auth needs an email
   transport for verification and reset. Truemail/Resend/SES are external paid or
   freemium services. Default plan: ship Phase 2 with email verification
   *disabled* for the single-user case, and add a provider only on request.
2. **R2 upload path.** Direct-to-R2 presigned `PUT` (fewer Worker bytes, needs
   signed URLs) vs Worker-mediated streaming upload. Default plan: Worker-mediated
   with a 5 MiB per-object limit for correctness first, presigned later.
3. **Tombstone retention** length (30 days proposed) and whether the server
   garbage-collects R2 objects for tombstoned notes immediately or after the
   window.
4. **Desktop session storage.** Tauri plugin-store vs OS keychain for the bearer
   token. Default plan: OS keychain via `tauri-plugin-stronghold`/keyring, with
   plugin-store only as a documented fallback; needs a decision on Linux
   (libsecret dependency).
5. **Per-user storage quota** enforcement (reject uploads beyond N MiB) to stay
   inside the D1/R2 free tier.
