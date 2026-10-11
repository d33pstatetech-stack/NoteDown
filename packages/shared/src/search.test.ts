import { describe, expect, it } from "vitest";
import { searchNodes } from "./search";
import type { Node } from "./types";

function note(id: string, title: string, content: string, parentId: string | null = "nb"): Node {
  return {
    id,
    kind: "note",
    parentId,
    title,
    content,
    position: 0,
    contentHash: `h-${id}`,
    localVersion: 1,
    baseVersion: 0,
    syncState: "local-only",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    conflictOf: null,
    conflictRecordedAt: null,
  };
}

describe("search", () => {
  const notebook: Node = { ...note("nb", "Work", ""), kind: "notebook", content: "" };
  const a = note("a", "Architecture", "# Design\n\nThe database schema lives here.");
  const b = note("b", "Grocery list", "milk, eggs, bread");
  const c = note("c", "Design review notes", "database migration plan");
  const deleted = { ...note("d", "Architecture old", "database"), deletedAt: "2026-02-01T00:00:00.000Z" };
  const nodes = [notebook, a, b, c, deleted];

  it("returns nothing for an empty query", () => {
    expect(searchNodes(nodes, "   ")).toEqual([]);
  });

  it("ranks title matches above content matches", () => {
    const hits = searchNodes(nodes, "architecture");
    expect(hits[0]?.node.id).toBe("a");
    expect(hits[0]?.matchedTitle).toBe(true);
    expect(hits.map((h) => h.node.id)).not.toContain("d");
  });

  it("finds content matches and returns a snippet", () => {
    const hits = searchNodes(nodes, "database");
    expect(hits.map((h) => h.node.id).sort()).toEqual(["a", "c"]);
    expect(hits[0]?.snippet).toBeTruthy();
  });

  it("supports multi-term queries and ancestor matches", () => {
    expect(searchNodes(nodes, "design database").map((h) => h.node.id)).toContain("c");
    // Searching a notebook name surfaces its notes through ancestor matching.
    const grouped = searchNodes([notebook, a], "work", { includeAncestorMatch: true });
    expect(grouped.map((h) => h.node.id)).toContain("a");
    const strict = searchNodes([notebook, a], "work", { includeAncestorMatch: false });
    expect(strict.map((h) => h.node.id)).not.toContain("a");
  });

  it("honours the limit", () => {
    expect(searchNodes(nodes, "database", { limit: 1 })).toHaveLength(1);
  });
});
