import { useId, useMemo, type ChangeEvent, type ReactNode } from "react";
import { nodePathLabel } from "@localnotes/shared";
import type { WorkspaceApi } from "../app/workspace";
import { TreeView } from "./tree-view";

export interface SidebarProps {
  api: WorkspaceApi;
  collapsed: boolean;
  onToggleCollapse: () => void;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  onDelete: (id: string) => void;
  onRequestMove: (id: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function Sidebar(props: SidebarProps): ReactNode {
  const { api } = props;
  const searchId = useId();
  const results = api.results;

  const canDrop = useMemo(
    () => (draggedId: string, targetId: string) => {
      if (draggedId === targetId) return false;
      let cursor = api.nodes.find((node) => node.id === targetId);
      const seen = new Set<string>();
      while (cursor && cursor.parentId) {
        if (cursor.parentId === draggedId) return false;
        if (seen.has(cursor.parentId)) break;
        seen.add(cursor.parentId);
        cursor = api.nodes.find((node) => node.id === cursor?.parentId);
      }
      return cursor !== undefined;
    },
    [api.nodes],
  );

  return (
    <nav
      className={props.collapsed ? "ln-sidebar is-collapsed" : "ln-sidebar"}
      aria-label="Notebooks"
    >
      <div className="ln-sidebar-header">
        <button
          type="button"
          className="ln-icon-button"
          aria-expanded={!props.collapsed}
          aria-label={props.collapsed ? "Show sidebar" : "Hide sidebar"}
          onClick={props.onToggleCollapse}
        >
          ☰
        </button>
        {!props.collapsed ? <h1 className="ln-app-title">NoteDown</h1> : null}
      </div>

      {props.collapsed ? null : (
        <>
          <div className="ln-search">
            <label className="ln-visually-hidden" htmlFor={searchId}>
              Search notes
            </label>
            <input
              id={searchId}
              ref={props.searchInputRef}
              type="search"
              placeholder="Search notes…"
              value={api.searchQuery}
              data-testid="search-input"
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                api.setSearchQuery(event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") api.setSearchQuery("");
              }}
            />
            {api.searchQuery.length > 0 ? (
              <button
                type="button"
                className="ln-icon-button"
                aria-label="Clear search"
                onClick={() => api.setSearchQuery("")}
              >
                ✕
              </button>
            ) : null}
          </div>

          <div className="ln-sidebar-body">
            {results ? (
              <div className="ln-results" aria-label="Search results">
                {results.length === 0 ? (
                  <p className="ln-muted">No notes match “{api.searchQuery}”.</p>
                ) : (
                  <ul className="ln-result-list">
                    {results.map((hit) => (
                      <li key={hit.node.id}>
                        <button
                          type="button"
                          className="ln-result"
                          data-testid={`search-result-${hit.node.id}`}
                          onClick={() => void api.open(hit.node.id)}
                        >
                          <span className="ln-result-title">{hit.node.title}</span>
                          <span className="ln-result-path">
                            {nodePathLabel(api.nodes, hit.node.id)}
                          </span>
                          {hit.snippet ? (
                            <span className="ln-result-snippet">{hit.snippet}</span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : api.tree.length === 0 ? (
              <div className="ln-empty ln-small">
                <p>No notebooks yet.</p>
                <button
                  type="button"
                  className="ln-button ln-primary"
                  onClick={() => void api.createNotebook()}
                >
                  Create your first notebook
                </button>
              </div>
            ) : (
              <TreeView
                tree={api.tree}
                selectedId={api.selectedId}
                expandedIds={props.expandedIds}
                onToggleExpand={props.onToggleExpand}
                onSelect={(id) => void api.open(id)}
                onCreate={(parentId, kind) =>
                  kind === "note"
                    ? void api.createNote(parentId)
                    : void api.createFolder(parentId)
                }
                onRename={(id, title) => void api.rename(id, title)}
                onDelete={props.onDelete}
                onMove={(id, parentId) => void api.move(id, parentId)}
                onRequestMove={props.onRequestMove}
                canDrop={canDrop}
              />
            )}
          </div>

          <div className="ln-sidebar-footer">
            <button
              type="button"
              className="ln-button ln-small"
              onClick={() => void api.createNote(null)}
              title="New note (Ctrl/Cmd+N)"
            >
              New note
            </button>
            <button
              type="button"
              className="ln-button ln-small"
              onClick={() => void api.createNotebook()}
              title="New notebook (Ctrl/Cmd+Shift+N)"
            >
              New notebook
            </button>
          </div>
        </>
      )}
    </nav>
  );
}
