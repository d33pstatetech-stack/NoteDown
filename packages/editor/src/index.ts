export * from "./attachment";
export * from "./theme";
export * from "./markdown-editor";
export * from "./markdown-preview";

/**
 * Re-exported so consumers (the app UI) can hold a reference to the live editor
 * without depending on CodeMirror directly.
 */
export type { EditorView } from "@codemirror/view";
