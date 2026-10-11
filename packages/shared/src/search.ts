import type { Node } from "./types";
import { isLive } from "./tree";

export interface SearchHit {
  node: Node;
  score: number;
  /** Line excerpt around the first content match, when the match is in content. */
  snippet: string | null;
  matchedTitle: boolean;
}

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function snippetFor(content: string, term: string): string | null {
  const lower = content.toLowerCase();
  const index = lower.indexOf(term);
  if (index === -1) return null;
  const lines = content.slice(0, index).split("\n");
  const lineNumber = lines.length - 1;
  const allLines = content.split("\n");
  const from = Math.max(0, lineNumber - 1);
  const to = Math.min(allLines.length, lineNumber + 2);
  return allLines
    .slice(from, to)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/**
 * Deterministic, dependency-free ranker. Title matches dominate; content
 * matches accumulate. Notes with no textual match but matching ancestors are
 * included so searching a notebook name surfaces its notes (`includeAncestorMatch`).
 */
export function searchNodes(
  nodes: readonly Node[],
  query: string,
  options: { limit?: number; includeAncestorMatch?: boolean } = {},
): SearchHit[] {
  const limit = options.limit ?? 50;
  const includeAncestor = options.includeAncestorMatch ?? true;
  const parsed = terms(query);
  if (parsed.length === 0) return [];

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestorText = (node: Node): string => {
    const parts: string[] = [];
    let current = node.parentId ? byId.get(node.parentId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.push(current.title.toLowerCase());
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return parts.join(" / ");
  };

  const hits: SearchHit[] = [];
  for (const node of nodes) {
    if (!isLive(node)) continue;
    const title = node.title.toLowerCase();
    const content = node.content.toLowerCase();
    const ancestors = includeAncestor ? ancestorText(node) : "";
    let score = 0;
    let matchedTitle = false;
    let snippet: string | null = null;

    for (const term of parsed) {
      if (title === term) {
        score += 100;
        matchedTitle = true;
      } else if (title.startsWith(term)) {
        score += 60;
        matchedTitle = true;
      } else if (title.includes(term)) {
        score += 30;
        matchedTitle = true;
      }
      const contentHits = countOccurrences(content, term);
      if (contentHits > 0) {
        score += Math.min(contentHits, 10) * 5;
        if (!snippet) snippet = snippetFor(node.content, term);
      }
      if (ancestors.includes(term)) score += 8;
    }

    if (score === 0) continue;
    if (node.kind === "note") score += 2;
    hits.push({ node, score, snippet, matchedTitle });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byUpdated = b.node.updatedAt.localeCompare(a.node.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return a.node.title.localeCompare(b.node.title);
  });
  return hits.slice(0, limit);
}
