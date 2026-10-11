import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { NodeKind, TreeNode } from "@localnotes/shared";

export interface TreeViewProps {
  tree: TreeNode[];
  selectedId: string | null;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
  onCreate: (parentId: string, kind: "folder" | "note") => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, parentId: string) => void;
  /** Opens the move dialog for an item (keyboard/pointer alternative to drag). */
  onRequestMove: (id: string) => void;
  /** Returns false when the drop would be illegal (self or own descendant). */
  canDrop: (draggedId: string, targetId: string) => boolean;
}

const ICONS: Record<NodeKind, string> = { notebook: "📓", folder: "📁", note: "📄" };

/**
 * Hierarchical tree with the ARIA `tree`/`treeitem`/`group` pattern: roles,
 * `aria-level`, `aria-expanded`, `aria-selected`, roving focus with arrow keys,
 * and per-item action buttons that are reachable with Tab.
 */
export function TreeView(props: TreeViewProps): ReactNode {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLLIElement>, item: TreeNode) => {
      const items = Array.from(
        event.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLLIElement>('[role="treeitem"]') ??
          [],
      );
      const index = items.indexOf(event.currentTarget);
      const focusAt = (target: number): void => {
        const next = items[target];
        next?.focus();
      };
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusAt(index + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusAt(index - 1);
          break;
        case "ArrowRight":
          if (item.children.length > 0 && !props.expandedIds.has(item.id)) {
            event.preventDefault();
            props.onToggleExpand(item.id);
          }
          break;
        case "ArrowLeft":
          if (item.children.length > 0 && props.expandedIds.has(item.id)) {
            event.preventDefault();
            props.onToggleExpand(item.id);
          }
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          props.onSelect(item.id);
          break;
        default:
          break;
      }
    },
    [props],
  );

  return (
    <ul className="ln-tree" role="tree" aria-label="Notebooks and notes">
      {props.tree.map((item) => (
        <TreeItem
          key={item.id}
          item={item}
          {...props}
          renamingId={renamingId}
          setRenamingId={setRenamingId}
          draggingId={draggingId}
          setDraggingId={setDraggingId}
          dropTargetId={dropTargetId}
          setDropTargetId={setDropTargetId}
          onItemKeyDown={handleKeyDown}
        />
      ))}
    </ul>
  );
}

interface TreeItemProps extends TreeViewProps {
  item: TreeNode;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onItemKeyDown: (event: KeyboardEvent<HTMLLIElement>, item: TreeNode) => void;
}

function TreeItem(props: TreeItemProps): ReactNode {
  const {
    item,
    expandedIds,
    selectedId,
    renamingId,
    setRenamingId,
    draggingId,
    setDraggingId,
    dropTargetId,
    setDropTargetId,
  } = props;
  const expanded = expandedIds.has(item.id);
  const isRenaming = renamingId === item.id;
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isRenaming) inputRef.current?.select();
  }, [isRenaming]);

  const commitRename = (value: string): void => {
    const title = value.trim();
    setRenamingId(null);
    if (title.length > 0 && title !== item.title) props.onRename(item.id, title);
  };

  const canAccept = item.kind !== "note";

  return (
    <li
      role="treeitem"
      aria-level={item.depth + 1}
      aria-selected={selectedId === item.id}
      aria-expanded={canAccept ? expanded : undefined}
      tabIndex={selectedId === item.id ? 0 : -1}
      data-testid={`tree-item-${item.id}`}
      data-kind={item.kind}
      className={[
        "ln-tree-item",
        item.kind === "note" ? "ln-tree-note" : "ln-tree-container",
        selectedId === item.id ? "is-selected" : "",
        dropTargetId === item.id ? "is-drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onKeyDown={(event) => props.onItemKeyDown(event, item)}
      draggable={!isRenaming}
      onDragStart={(event) => {
        setDraggingId(item.id);
        event.dataTransfer.setData("text/plain", item.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        setDraggingId(null);
        setDropTargetId(null);
      }}
      onDragOver={(event) => {
        if (!canAccept || !draggingId || !props.canDrop(draggingId, item.id)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTargetId(item.id);
      }}
      onDragLeave={() => setDropTargetId(null)}
      onDrop={(event) => {
        event.preventDefault();
        const dragged = draggingId ?? event.dataTransfer.getData("text/plain");
        setDropTargetId(null);
        setDraggingId(null);
        if (dragged && dragged !== item.id && canAccept && props.canDrop(dragged, item.id)) {
          props.onMove(dragged, item.id);
        }
      }}
    >
      <div className="ln-tree-row">
        {canAccept ? (
          <button
            type="button"
            className="ln-twisty"
            aria-label={expanded ? `Collapse ${item.title}` : `Expand ${item.title}`}
            onClick={() => props.onToggleExpand(item.id)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="ln-twisty ln-twisty-placeholder" aria-hidden="true" />
        )}

        <span className="ln-tree-icon" aria-hidden="true">
          {ICONS[item.kind]}
        </span>

        {isRenaming ? (
          <input
            ref={inputRef}
            className="ln-rename-input"
            aria-label={`Rename ${item.title}`}
            defaultValue={item.title}
            onBlur={(event) => commitRename(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename(event.currentTarget.value);
              if (event.key === "Escape") setRenamingId(null);
              event.stopPropagation();
            }}
          />
        ) : (
          <button
            type="button"
            className="ln-tree-label"
            onClick={() => props.onSelect(item.id)}
            title={item.title}
          >
            {item.title}
            {item.syncState === "pending" || item.syncState === "local-only" ? (
              <span className="ln-dot" aria-label="Not yet synced" title="Saved locally, not synced" />
            ) : null}
          </button>
        )}

        <span className="ln-tree-actions">
          {item.kind !== "note" ? (
            <>
              <button
                type="button"
                className="ln-icon-button"
                aria-label={`New note in ${item.title}`}
                title="New note"
                onClick={() => props.onCreate(item.id, "note")}
              >
                ＋
              </button>
              <button
                type="button"
                className="ln-icon-button"
                aria-label={`New folder in ${item.title}`}
                title="New folder"
                onClick={() => props.onCreate(item.id, "folder")}
              >
                🗀
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="ln-icon-button"
            aria-label={`Move ${item.title}`}
            title="Move"
            onClick={() => props.onRequestMove(item.id)}
          >
            ⇄
          </button>
          <button
            type="button"
            className="ln-icon-button"
            aria-label={`Rename ${item.title}`}
            title="Rename"
            onClick={() => setRenamingId(item.id)}
          >
            ✎
          </button>
          <button
            type="button"
            className="ln-icon-button ln-danger"
            aria-label={`Delete ${item.title}`}
            title="Delete"
            onClick={() => props.onDelete(item.id)}
          >
            🗑
          </button>
        </span>
      </div>

      {canAccept && expanded && item.children.length > 0 ? (
        <ul className="ln-tree-group" role="group">
          {item.children.map((child) => (
            <TreeItem
              key={child.id}
              {...props}
              item={child}
              onItemKeyDown={props.onItemKeyDown}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
