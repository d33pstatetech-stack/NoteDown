import { useEffect, useRef, type ReactNode } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { editorTheme, type ColorTheme } from "./theme";

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter (also available as a global shortcut in the app). */
  onSave?: () => void;
  /** Images pasted or dropped onto the editor. */
  onAttachFiles?: (files: File[]) => void;
  /**
   * The live `EditorView`, so callers can insert text at the caret (used by
   * "insert image"). Receives `null` on unmount.
   */
  onViewReady?: (view: EditorView | null) => void;
  theme?: ColorTheme;
  readOnly?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

const readOnlyCompartment = new Compartment();
const themeCompartment = new Compartment();

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/**
 * CodeMirror 6 Markdown editor.
 *
 * Controlled-but-fast: the document is owned by CodeMirror and `onChange` is
 * called on every transaction that changes the document. External `value`
 * changes (switching notes, sync, conflict copies) are applied as a single
 * replace transaction, so an unsaved keystroke is never silently dropped.
 * The view is created once per mount; theme and read-only mode are reconfigured
 * through compartments so toggling them does not reset undo history.
 */
export function MarkdownEditor(props: MarkdownEditorProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            latest.current.onSave?.();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) latest.current.onChange(update.state.doc.toString());
      }),
      EditorView.contentAttributes.of({
        "aria-label": latest.current.ariaLabel ?? "Markdown note content",
        role: "textbox",
        "aria-multiline": "true",
        "data-testid": "markdown-editor",
      }),
      EditorView.domEventHandlers({
        paste: (event) => {
          const files = filesFromDataTransfer(event.clipboardData);
          if (files.length === 0) return false;
          event.preventDefault();
          latest.current.onAttachFiles?.(files);
          return true;
        },
        drop: (event) => {
          const files = filesFromDataTransfer(event.dataTransfer);
          if (files.length === 0) return false;
          event.preventDefault();
          latest.current.onAttachFiles?.(files);
          return true;
        },
      }),
      readOnlyCompartment.of(readOnlyExtension(props.readOnly ?? false)),
      themeCompartment.of(editorTheme(props.theme ?? "light")),
    ];
    if (props.placeholder) extensions.push(placeholderExtension(props.placeholder));

    const state = EditorState.create({ doc: props.value, extensions });
    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    latest.current.onViewReady?.(instance);
    return () => {
      instance.destroy();
      view.current = null;
      latest.current.onViewReady?.(null);
    };
    // Intentionally created once: value/theme/readOnly changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    instance.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(props.readOnly ?? false)),
    });
  }, [props.readOnly]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    instance.dispatch({
      effects: themeCompartment.reconfigure(editorTheme(props.theme ?? "light")),
    });
  }, [props.theme]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === props.value) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: props.value },
      // Keep the caret where it can still be, so switching notes is not a jump.
      selection: { anchor: Math.min(instance.state.selection.main.anchor, props.value.length) },
    });
  }, [props.value]);

  return <div className={props.className ?? "ln-editor"} ref={host} />;
}

function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.files ?? [])) files.push(item);
  return files.filter((file) => file.type.startsWith("image/") || file.size > 0);
}
