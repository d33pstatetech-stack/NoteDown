# D1 migrations

`wrangler d1 migrations` applies these files in filename order and records them
in D1's own `d1_migrations` table, so they run exactly once.

```sh
# local (workerd + a local SQLite file under .wrangler/)
pnpm --filter @localnotes/worker exec wrangler d1 migrations apply localnotes --local

# production
pnpm --filter @localnotes/worker exec wrangler d1 migrations apply localnotes --remote
```

## Adding a migration

1. `wrangler d1 migrations create localnotes add_something`
2. Write forward-only SQL. Never edit an applied file — D1 has no rollback.
3. Keep the "no long-lived transaction" rule in mind: `db.batch()` is a
   sequential transaction; `BEGIN`/`COMMIT` across Worker code is not supported.
4. Foreign keys are **enforced by default** in D1 and cannot be turned off; use
   `PRAGMA defer_foreign_keys = ON` as the first statement of a batch when the
   row order inside that batch cannot guarantee parent-before-child.

## Better Auth tables

Better Auth owns `user`, `session`, `account` and `verification`. The CLI cannot
reach D1 directly, so the documented flow is a Worker route that calls
`getMigrations(auth.options)` and then `runMigrations()` (see
`worker/src/auth-admin.ts`). Run it once against a fresh database, then protect
or remove the route. Do **not** hand-write those tables: their shape is owned by
the library and changes between minor versions.
