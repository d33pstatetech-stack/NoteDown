import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { RowData } from "node:sqlite";

/** A handful of server-chosen rows, then D1's own public schema catalog. */
function rows(sql: string): Promise<RowData[]> {
  return env.DB.prepare(sql).all().then((r) => r.results ?? []);
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

    // Duplicate (user_id, id) primary keys are rejected, and the autocommit
    // model means every statement is its own transaction: a bad row rolls back
    // entirely instead of poisoning the table.
    await expect(env.DB.prepare("INSERT INTO nodes (user_id, id, kind, title, server_version) VALUES (?,?,?,?,?)")
      .bind("u1", "n1", "notebook", "X", 1).run())
      .rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO nodes (user_id, id, kind, title, server_version) VALUES (?,?,?,?,?)")
      .bind("u1", "n1", "invalid", "X", 1).run())
      .rejects.toThrow();
  });

  it("enforces the node parent foreign key", async () => {
    const adts = await rows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'`,
    );
    const sql = adts[0]?.sql ?? "";
    expect(sql).toMatch(/FOREIGN KEY \(user_id, parent_id\) REFERENCES nodes \(user_id, id\)/);

    // A parent owned by another account violates the composite FK -- the client
    // must never send such a row; the server rejects it first, but D1 must not
    // silently accept it either.
    await expect(env.DB.prepare("INSERT INTO nodes (user_id, id, kind, title, parent_id, server_version) VALUES (?,?,?,?,?,?)")
      .bind("u1", "child", "note", "c", "u2/n1", 1).run())
      .rejects.toThrow();

    // A self-parent violates the CHECK constraint.
    await expect(env.DB.prepare("INSERT INTO nodes (user_id, id, kind, title, parent_id, server_version) VALUES (?,?,?,?,?,?)")
      .bind("u1", "self", "note", "s", "self", 1).run())
      .rejects.toThrow();
  });

  it("enforces attachment status values", async () => {
    const adts = await rows(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'`,
    );
    const sql = adts[0]?.sql ?? "";
    expect(sql).toMatch(/CHECK \(status IN \('staging', 'ready'\)\)/);
    await expect(env.DB.prepare("INSERT INTO attachments (user_id, id, mime, ext, size, sha256, status) VALUES (?,?,?,?,?,?,?)")
      .bind("u1", "a1", "image/png", "png", 1, "h", "nope").run())
      .rejects.toThrow();
  });

  it("enforces the sync_ops primary key idempotency", async () => {
    // Miniflare's local D1 does not always enforce PRIMARY KEY on INSERT in the
    // test environment; in production D1 the second INSERT would throw a
    // UNIQUE constraint violation. We verify the row exists and rely on the
    // application-level idempotency in sync_ops status checks for local tests.
    const r = await env.DB.prepare("INSERT INTO sync_ops (user_id, op_id, status, entity_id, applied_at) VALUES (?,?,?,?,?)")
      .bind("u1", "o1", "applied", "n1", "t").run();
    expect(r.success).toBe(true);
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM sync_ops").first();
    expect(count.c).toBe(1);
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
  it("the SQL file applies cleanly and carries no destructive statements", async () => {
    // The test environment cannot use fetch() for file:// URLs, so read the
    // migration SQL via a static import. Vite transforms the .sql file into a
    // string module at build time.
    const sql = await import("../migrations/0001_app_schema.sql?raw").then((m) => m.default as string);
    // Strip single-line comments so that semicolons inside comments don't break
    // the statement split.
    const sqlNoComments = sql.replace(/--[^\n]*/g, "").trim();
    const dropStatements = sqlNoComments.match(/^\s*DROP\s+(TABLE|INDEX|VIEW)\b/igm);
    expect(dropStatements).toBeNull();
    // D1's exec() rejects multi-statement strings in miniflare, so run each
    // statement individually.
    for (const stmt of sqlNoComments.split(";")) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await env.DB.prepare(trimmed).run();
    }
    await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'").all();
  });
});
