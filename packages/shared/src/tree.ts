import { CycleError, InvalidParentError, NotFoundError } from "./errors";
import type { Node, NodeKind, TreeNode } from "./types";

/** Which kinds may contain which kinds. */
export function canContain(parentKind: NodeKind, childKind: NodeKind): boolean {
  if (parentKind === "note") return false;
  if (childKind === "notebook") return false;
  return parentKind === "notebook" || parentKind === "folder";
}

export function isLive(node: Node): boolean {
  return node.deletedAt === null;
}

export function liveNodes(nodes: readonly Node[]): Node[] {
  return nodes.filter(isLive);
}

export function findNode(nodes: readonly Node[], id: string): Node | null {
  return nodes.find((node) => node.id === id) ?? null;
}

export function requireNode(nodes: readonly Node[], id: string, what = "Node"): Node {
  const node = findNode(nodes, id);
  if (!node || !isLive(node)) throw new NotFoundError(what, id);
  return node;
}

export function childrenOf(
  nodes: readonly Node[],
  parentId: string | null,
  options: { includeDeleted?: boolean } = {},
): Node[] {
  const includeDeleted = options.includeDeleted ?? false;
  return nodes
    .filter(
      (node) =>
        node.parentId === parentId && (includeDeleted || node.deletedAt === null),
    )
    .sort(compareSiblings);
}

export function compareSiblings(a: Node, b: Node): number {
  if (a.position !== b.position) return a.position - b.position;
  const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildTree(nodes: readonly Node[], options: { includeDeleted?: boolean } = {}): TreeNode[] {
  const includeDeleted = options.includeDeleted ?? false;
  const byId = new Map<string, TreeNode>();
  for (const node of nodes) {
    if (!includeDeleted && node.deletedAt !== null) continue;
    byId.set(node.id, { ...node, depth: 0, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const treeNode of byId.values()) {
    const parent = treeNode.parentId === null ? null : byId.get(treeNode.parentId);
    if (parent) parent.children.push(treeNode);
    else roots.push(treeNode);
  }
  const sortRecursive = (list: TreeNode[], depth: number): void => {
    list.sort(compareSiblings);
    for (const item of list) {
      item.depth = depth;
      item.children.sort(compareSiblings);
      sortRecursive(item.children, depth + 1);
    }
  };
  sortRecursive(roots, 0);
  return roots;
}

/** Flat, render-ready list of the tree in depth-first display order. */
export function flattenTree(roots: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

export function descendantIds(nodes: readonly Node[], id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const node of nodes) {
      if (node.parentId === current) {
        out.push(node.id);
        queue.push(node.id);
      }
    }
  }
  return out;
}

/** Collects a node and its whole subtree, deepest last. */
export function subtreeIds(nodes: readonly Node[], id: string): string[] {
  return [id, ...descendantIds(nodes, id)];
}

export function isDescendant(nodes: readonly Node[], ancestorId: string, candidateId: string): boolean {
  return descendantIds(nodes, ancestorId).includes(candidateId);
}

export function nodePath(nodes: readonly Node[], id: string): Node[] {
  const path: Node[] = [];
  let current = findNode(nodes, id);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId === null ? null : findNode(nodes, current.parentId);
  }
  return path;
}

/** Human-readable ancestry, e.g. `Work / Design / Architecture`. */
export function nodePathLabel(nodes: readonly Node[], id: string, separator = " / "): string {
  return nodePath(nodes, id)
    .map((node) => node.title)
    .join(separator);
}

export function nextPosition(nodes: readonly Node[], parentId: string | null): number {
  const siblings = childrenOf(nodes, parentId);
  const last = siblings[siblings.length - 1];
  return last ? last.position + 1 : 0;
}

export function assertValidParent(
  nodes: readonly Node[],
  kind: NodeKind,
  parentId: string | null,
  movingId?: string,
): void {
  if (kind === "notebook") {
    if (parentId !== null) {
      throw new InvalidParentError("A notebook must be a top-level item", { parentId });
    }
    return;
  }
  if (parentId === null) {
    throw new InvalidParentError(`${kind} requires a parent notebook or folder`, { kind });
  }
  const parent = findNode(nodes, parentId);
  if (!parent || parent.deletedAt !== null) throw new NotFoundError("Parent", parentId);
  if (!canContain(parent.kind, kind)) {
    throw new InvalidParentError(`A ${parent.kind} cannot contain a ${kind}`, {
      parentId,
      parentKind: parent.kind,
      kind,
    });
  }
  if (movingId !== undefined) {
    if (parentId === movingId) throw new CycleError("A node cannot be its own parent");
    if (isDescendant(nodes, movingId, parentId)) {
      throw new CycleError("A node cannot be moved inside its own subtree");
    }
  }
}

/**
 * Re-indexes siblings of `parentId` to `0..n-1` in their current display order,
 * keeping ordering stable and gap-free after moves and deletions.
 */
export function normalizeSiblingPositions(nodes: readonly Node[], parentId: string | null): Node[] {
  const siblings = childrenOf(nodes, parentId);
  const order = new Map(siblings.map((node, index) => [node.id, index]));
  return nodes.map((node) => {
    const next = order.get(node.id);
    if (next === undefined || next === node.position) return node;
    return { ...node, position: next };
  });
}
