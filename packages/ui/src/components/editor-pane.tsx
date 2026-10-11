import { useCallback, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import {
  MarkdownEditor,
  MarkdownPreview,
  type ColorTheme,
  type EditorView,
} from "@localnotes/editor";
import { errorMessage, nodePathLabel } from "@localnotes/shared";
import { useAttachmentUrls } from "../app/attachments";
import type { WorkspaceApi } from "../app/workspace";
import type { Store } from "@localnotes/shared";

export type ViewMode = "write" | "split" | "preview";

export interface EditorPaneProps {
  api: WorkspaceApi;
  store: Store;
  theme: ColorTheme;
  onDelete: (id: string) => void;
  onNewNote: () => void;
  onNewNotebook: () => void;
}

const MODE_LABELS: Record<ViewMode, string> = {
  write: "Write",
  split: "Split",
  preview: "Preview",
};

export function EditorPane(props: EditorPaneProps): ReactNode {
  const { api, store } = props;
  const [mode, setMode] = useState<ViewMode>("split");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const editorView = useRef<EditorView | null>(null);
  const draft = api.draft;

  const path = useMemo(
    () => (api.selectedId ? nodePathLabel(api.nodes, api.selectedId) : ""),
    [api.nodes, api.selectedId],
  );

  const { imageUrls, resolve, missing } = useAttachmentUrls(
    draft && draft.kind === "note" ? store : null,
    draft?.content ?? "",
  );

  const insertAtCaret = useCallback(
    (text: string) => {
      const view = editorView.current;
      if (!view) {
        api.setContent(`${api.draft?.content ?? ""}\n\n${text}\n`);
        return;
      }
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    [api],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!draft || draft.kind !== "note") return;
      for (const file of files) {
        try {
          const { reference, filename } = await api.attachImage(file);
          insertAtCaret(`![${filename.replace(/\.[^.]+$/, "")}](${reference})`);
        } catch (error) {
          api.pushNotice({
            kind: "error",
            message: `Could not attach ${file.name || "that file"}: ${errorMessage(error)}`,
          });
        }
      }
    },
    [api, draft, insertAtCaret],
  );

  const onPick = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void handleFiles(files);
    },
    [handleFiles],
  );

  if (!draft) {
    return (
      <section className="ln-pane ln-empty" aria-label="Editor">
        <h2>No note selected</h2>
        <p>
          Everything is stored on this device first, so you can keep working without a network
          connection.
        </p>
        <div className="ln-empty-actions">
          <button type="button" className="ln-button ln-primary" onClick={props.onNewNote}>
            New note
          </button>
          <button type="button" className="ln-button" onClick={props.onNewNotebook}>
            New notebook
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ln-pane" aria-label="Editor">
      <header className="ln-pane-header">
        <div className="ln-breadcrumb" title={path}>
          {path || draft.title}
        </div>
        <div className="ln-pane-actions">
          <div className="ln-segmented" role="group" aria-label="View mode">
            {(Object.keys(MODE_LABELS) as ViewMode[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={candidate === mode ? "is-active" : ""}
                aria-pressed={candidate === mode}
                onClick={() => setMode(candidate)}
              >
                {MODE_LABELS[candidate]}
              </button>
            ))}
          </div>
          {draft.kind === "note" ? (
            <>
              <button
                type="button"
                className="ln-button"
                onClick={() => fileInput.current?.click()}
                title="Insert an image from this device"
              >
                Insert image
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                data-testid="image-input"
                onChange={onPick}
              />
            </>
          ) : null}
          <button
            type="button"
            className="ln-button ln-danger"
            onClick={() => props.onDelete(draft.id)}
          >
            Delete
          </button>
        </div>
      </header>

      <div className="ln-title-row">
        <label className="ln-visually-hidden" htmlFor="ln-note-title">
          Title
        </label>
        <input
          id="ln-note-title"
          className="ln-title-input"
          value={draft.title}
          placeholder="Untitled"
          onChange={(event) => api.setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void api.flush();
            }
          }}
        />
      </div>

      {draft.kind !== "note" ? (
        <div className="ln-container-note">
          <p>
            This {draft.kind} is a container. Add notes or folders inside it from the sidebar.
          </p>
        </div>
      ) : (
        <div className={`ln-editor-area mode-${mode}`}>
          {mode !== "preview" ? (
            <MarkdownEditor
              value={draft.content}
              onChange={api.setContent}
              onSave={() => void api.flush()}
              onAttachFiles={(files) => void handleFiles(files)}
              onViewReady={(view) => {
                editorView.current = view;
              }}
              theme={props.theme}
              ariaLabel={`Note content: ${draft.title}`}
              placeholder="Write in Markdown. Paste or drop an image to attach it."
              className="ln-editor"
            />
          ) : null}
          {mode !== "write" ? (
            <div className="ln-preview-wrap">
              {missing.length > 0 ? (
                <p className="ln-warning" role="status">
                  {missing.length} image{missing.length === 1 ? "" : "s"} referenced by this note
                  {missing.length === 1 ? " is" : " are"} not stored on this device yet.
                </p>
              ) : null}
              <MarkdownPreview
                markdown={draft.content}
                imageUrls={imageUrls}
                resolver={resolve}
                className="ln-preview"
              />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
