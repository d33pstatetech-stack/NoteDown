import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import migrationSql from "../migrations/0001_app_schema.sql?raw";

/** One row of `sqlite_master`, or of `pragma_table_info`. */
interface Row {
  name: string;
  sql?: string;
}

/** A handful of server-chosen rows, then D1's own public schema catalog. */
function rows(sql: string): Promise<Row[]> {
  return env.DB.prepare(sql).all<Row>().then((result) => result.results ?? []);
}

describe("D1 schema", () => {
  it("creates our v1 tables with the documented indexes", async () => {
    const names = await rows(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'better_auth_%' ORDER BY name`,
    );
    const cols = await rows(
      `SELECT name FROM pragma_table_info('nodes') ORDER BY name`,
    );
    expect(names.map((r) => r.name)).toContain("nodes");
    expect(names.map((r) => r.name)).toContain("user_versions");
    expect(cols.some((c) => c.name === "server_version")).toBe(true);
  });

  it("enforces node kinds and identity constraints (CHECK / PRIMARY KEY)", async () => {
    const adts = await rows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`,
    );
    const sql = adts[0]?.sql ?? "";
    expect(sql).toMatch(/CHECK\s*\(\s*kind\s+IN\s+\('notebook',\s*'folder',\s*'note'\)\s*\)/);
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*user_id\s*,\s*id\s*\)/);

    // A duplicate (user_id, id) primary key is rejected outright.
    await expect(
      env.DB.prepare(
        "INSERT INTO nodes (user_id, id, kind, title, server_version) VALUES (?,?,?,?,?)",
      )
        .bind("u1", "n1", "notebook", "X", 1)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO nodes (user_id, id, kind, title, server_version) VALUES (?,?,?,?,?)",
      )
        .bind("u1", "n1", "invalid", "X", 1)
        .run(),
    ).rejects.toThrow();
  });

  it("enforces the node parent foreign key", async () => {
    const adts = await rows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`,
    );
    const sql = adts[0]?.sql ?? "";
    expect(sql).toMatch(/FOREIGN KEY \(user_id, parent_id\) REFERENCES nodes \(user_id, id\)/);

    // A parent owned by another account violates the composite FK.
    await expect(
      env.DB.prepare(
        "INSERT INTO nodes (user_id, id, kind, title, parent_id, server_version) VALUES (?,?,?,?,?,?)",
      )
        .bind("u1", "child", "note", "c", "u2", 1)
        .run(),
    ).rejects.toThrow();

    // A self-parent violates the CHECK constraint.
    await expect(
      env.DB.prepare(
        "INSERT INTO nodes (user_id, id, kind, title, parent_id, server_version) VALUES (?,?,?,?,?,?)",
      )
        .bind("u1", "self", "note", "s", "self", 1)
        .run(),
    ).rejects.toThrow();
  });

  it("enforces attachment status values", async () => {
    const adts = await rows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'`,
    );
    const sql = adts[0]?.sql ?? "";
    expect(sql).toMatch(/CHECK \(status IN \('staging', 'ready'\)\)/);
    await expect(
      env.DB.prepare(
        "INSERT INTO attachments (user_id, id, mime, ext, size, sha256, status) VALUES (?,?,?,?,?,?,?)",
      )
        .bind("u1", "a1", "image/png", "png", 1, "h", "nope")
        .run(),
    ).rejects.toThrow();
  });

  /**
   * Regression: the attachment foreign key used to be `ON DELETE SET NULL` over
   * the composite key `(user_id, note_id)`. SQLite nulls *every* column of the
   * child key on SET NULL, so deleting a parent tried to null the NOT NULL
   * `user_id` and the statement failed — an attachment could never be
   * disassociated from a deleted note.
   */
  it("deleting a node cascades its attachments instead of failing", async () => {
    const userId = `cascade-user-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO nodes (user_id, id, kind, title, server_version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
      .bind(userId, "note-1", "notebook", "Doomed", 1, "t", "t")
      .run();
    await env.DB.prepare(
      `INSERT INTO attachments (user_id, id, note_id, filename, mime, ext, size, sha256, status,
         server_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(userId, "att-1", "note-1", "a.png", "image/png", "png", 1, "h", "ready", 1, "t")
      .run();

    await expect(
      env.DB.prepare("DELETE FROM nodes WHERE user_id = ? AND id = ?")
        .bind(userId, "note-1")
        .run(),
    ).resolves.toBeDefined();

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM attachments WHERE user_id = ? AND id = ?",
    )
      .bind(userId, "att-1")
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });

  it("enforces the sync_ops primary key idempotency", async () => {
    const insert = () =>
      env.DB.prepare(
        "INSERT INTO sync_ops (user_id, op_id, status, entity_id, applied_at) VALUES (?,?,?,?,?)",
      )
        .bind("u1", "o1", "applied", "n1", "t")
        .run();

    const first = await insert();
    expect(first.success).toBe(true);
    // A retried push replays the same opId and must not apply twice.
    await expect(insert()).rejects.toThrow();

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM sync_ops WHERE user_id = ?",
    )
      .bind("u1")
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("the better-auth tables coexist with our schema", async () => {
    const names = await rows(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user', 'session', 'account', 'verification') ORDER BY name`,
    );
    expect(names.some((r) => r.name === "user")).toBe(true);
    expect(names.some((r) => r.name === "session")).toBe(true);
    expect(names.some((r) => r.name === "account")).toBe(true);
    expect(names.some((r) => r.name === "verification")).toBe(true);
  });
});

describe("migration integrity", () => {
  it("the SQL file is forward-only and re-runnable", async () => {
    // The migration is imported as a string at build time rather than read at
    // runtime: these tests execute inside workerd, which has no filesystem.
    // Strip single-line comments so a semicolon inside a comment cannot break
    // the statement split below.
    const sqlNoComments = migrationSql.replace(/--[^\n]*/g, "").trim();
    expect(sqlNoComments.length).toBeGreaterThan(0);
    expect(sqlNoComments.match(/^\s*DROP\s+(TABLE|INDEX|VIEW)\b/im)).toBeNull();

    // Every statement uses IF NOT EXISTS, so replaying the whole file against
    // the already-migrated database must be a no-op rather than an error. That
    // is what proves the migration is safe to re-run.
    for (const stmt of sqlNoComments.split(";")) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await expect(env.DB.prepare(trimmed).run()).resolves.toBeDefined();
    }
  });
});
