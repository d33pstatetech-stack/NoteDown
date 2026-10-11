import { useEffect, useId, useRef, type ReactNode } from "react";
import type { TreeNode } from "@localnotes/shared";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal confirmation for destructive actions. Uses an ARIA dialog (not the
 * native `<dialog>`, which is inconsistently supported) with focus moved to the
 * safe action, Escape to cancel, and a focus trap on Tab.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props]);

  if (!props.open) return null;

  return (
    <div className="ln-backdrop">
      <div
        ref={containerRef}
        className="ln-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <h2 id={titleId}>{props.title}</h2>
        <p id={descriptionId}>{props.message}</p>
        <div className="ln-dialog-actions">
          <button ref={cancelRef} type="button" className="ln-button" onClick={props.onCancel}>
            {props.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={props.destructive ? "ln-button ln-danger-solid" : "ln-button ln-primary"}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface MoveDialogProps {
  open: boolean;
  tree: TreeNode[];
  movingId: string;
  /** Ids that cannot be a destination (the item itself and its descendants). */
  invalidIds: ReadonlySet<string>;
  onMove: (parentId: string) => void;
  onCancel: () => void;
}

export function MoveDialog(props: MoveDialogProps): ReactNode {
  const selectId = useId();
  const options: Array<{ id: string; label: string }> = [];
  const walk = (items: readonly TreeNode[], prefix: string): void => {
    for (const item of items) {
      if (item.kind !== "note" && !props.invalidIds.has(item.id)) {
        options.push({ id: item.id, label: `${prefix}${item.title}` });
        walk(item.children, `${prefix}— `);
      }
    }
  };
  walk(props.tree, "");

  if (!props.open) return null;

  return (
    <div className="ln-backdrop">
      <div className="ln-dialog" role="dialog" aria-modal="true" aria-labelledby={`${selectId}-title`}>
        <h2 id={`${selectId}-title`}>Move item</h2>
        <label htmlFor={selectId}>Destination</label>
        <select
          id={selectId}
          defaultValue={options[0]?.id ?? ""}
          onChange={(event) => props.onMove(event.target.value)}
        >
          {options.length === 0 ? <option value="">No destination available</option> : null}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="ln-dialog-actions">
          <button type="button" className="ln-button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function NoticeStack(props: {
  notices: ReadonlyArray<{
    id: string;
    kind: "info" | "error";
    message: string;
    action?: { label: string; run: () => void };
  }>;
  onDismiss: (id: string) => void;
}): ReactNode {
  if (props.notices.length === 0) return null;
  return (
    <div className="ln-notices" role="status" aria-live="polite">
      {props.notices.map((notice) => (
        <div
          key={notice.id}
          className={notice.kind === "error" ? "ln-notice is-error" : "ln-notice"}
          role={notice.kind === "error" ? "alert" : undefined}
        >
          <span>{notice.message}</span>
          {notice.action ? (
            <button type="button" className="ln-button ln-small" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="ln-icon-button"
            aria-label="Dismiss message"
            onClick={() => props.onDismiss(notice.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
