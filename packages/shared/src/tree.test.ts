import { describe, expect, it } from "vitest";
import { CycleError, InvalidParentError } from "./errors";
import {
  assertValidParent,
  buildTree,
  childrenOf,
  descendantIds,
  flattenTree,
  nodePathLabel,
  normalizeSiblingPositions,
  subtreeIds,
} from "./tree";
import type { Node, NodeKind } from "./types";

let counter = 0;
function node(kind: NodeKind, parentId: string | null, overrides: Partial<Node> = {}): Node {
  counter += 1;
  const id = overrides.id ?? `${kind}-${counter}`;
  return {
    id,
    kind,
    parentId,
    title: overrides.title ?? id,
    content: kind === "note" ? (overrides.content ?? "body") : "",
    position: overrides.position ?? 0,
    contentHash: overrides.contentHash ?? "hash",
    localVersion: 1,
    baseVersion: 0,
    syncState: "local-only",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: overrides.deletedAt ?? null,
    conflictOf: null,
    conflictRecordedAt: null,
    ...overrides,
  };
}

describe("hierarchy", () => {
  const notebook = node("notebook", null, { id: "nb", position: 0 });
  const folder = node("folder", "nb", { id: "f1", position: 0 });
  const nested = node("folder", "f1", { id: "f2", position: 0 });
  const noteA = node("note", "f1", { id: "n1", position: 1 });
  const noteB = node("note", "f2", { id: "n2", position: 0 });
  const all = [notebook, folder, nested, noteA, noteB];

  it("builds a tree with depths and ordered children", () => {
    const tree = buildTree(all);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe("nb");
    expect(tree[0]?.children.map((c) => c.id)).toEqual(["f1"]);
    expect(tree[0]?.children[0]?.children.map((c) => c.id)).toEqual(["f2", "n1"]);
    const flat = flattenTree(tree);
    expect(flat.map((n) => [n.id, n.depth])).toEqual([
      ["nb", 0],
      ["f1", 1],
      ["f2", 2],
      ["n2", 3],
      ["n1", 2],
    ]);
  });

  it("collects descendants and subtrees", () => {
    expect(descendantIds(all, "f1").sort()).toEqual(["f2", "n1", "n2"]);
    expect(subtreeIds(all, "f1").sort()).toEqual(["f1", "f2", "n1", "n2"]);
    expect(descendantIds(all, "n1")).toEqual([]);
  });

  it("hides tombstones unless asked", () => {
    const deleted = { ...noteA, deletedAt: "2026-02-01T00:00:00.000Z" };
    const withDeleted = [notebook, folder, nested, deleted, noteB];
    expect(childrenOf(withDeleted, "f1").map((n) => n.id)).toEqual(["f2"]);
    expect(childrenOf(withDeleted, "f1", { includeDeleted: true }).map((n) => n.id)).toEqual([
      "f2",
      "n1",
    ]);
    expect(buildTree(withDeleted)[0]?.children[0]?.children.map((n) => n.id)).toEqual(["f2"]);
  });

  it("labels a path by ancestry, independent of the note title", () => {
    expect(nodePathLabel(all, "n2")).toBe("nb / f1 / f2 / n2");
  });

  it("rejects illegal parent/child combinations", () => {
    expect(() => assertValidParent(all, "folder", null)).toThrow(InvalidParentError);
    expect(() => assertValidParent(all, "notebook", "f1")).toThrow(/top-level/);
    expect(() => assertValidParent(all, "note", "n1")).toThrow(/cannot contain/);
    expect(() => assertValidParent(all, "note", "missing")).toThrow(/not found/i);
    expect(() => assertValidParent(all, "folder", "f1", "f1")).toThrow(CycleError);
    expect(() => assertValidParent(all, "folder", "f2", "f1")).toThrow(/subtree/);
    expect(() => assertValidParent(all, "note", "f1")).not.toThrow();
  });

  it("re-indexes siblings to a gap-free range", () => {
    const messy = [
      node("note", "f1", { id: "a", position: 5 }),
      node("note", "f1", { id: "b", position: 9 }),
      node("note", "f1", { id: "c", position: 7 }),
    ];
    const [x, y, z] = messy as [Node, Node, Node];
    const normalized = normalizeSiblingPositions([x, y, z], "f1");
    const byId = new Map(normalized.map((n) => [n.id, n.position]));
    // Display order is decisive: a(5), c(7), b(9).
    expect([byId.get("a"), byId.get("c"), byId.get("b")]).toEqual([0, 1, 2]);
  });
});
