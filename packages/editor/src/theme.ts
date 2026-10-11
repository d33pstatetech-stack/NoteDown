import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

export type ColorTheme = "light" | "dark";

const lightHighlight = HighlightStyle.define([
  { tag: t.heading, color: "#0b5cad", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#0b5cad", textDecoration: "underline" },
  { tag: t.url, color: "#0b5cad" },
  { tag: t.monospace, color: "#8b2f6d" },
  { tag: t.quote, color: "#4a5568" },
  { tag: t.list, color: "#1f7a4d" },
  { tag: t.contentSeparator, color: "#8a94a6" },
  { tag: t.processingInstruction, color: "#8a94a6" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: t.heading, color: "#7cb7ff", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "#7cb7ff", textDecoration: "underline" },
  { tag: t.monospace, color: "#ff9ecb" },
  { tag: t.quote, color: "#a9b4c4" },
  { tag: t.list, color: "#7bd88f" },
  { tag: t.contentSeparator, color: "#7d8798" },
  { tag: t.processingInstruction, color: "#7d8798" },
]);

/**
 * CodeMirror theme that follows the app's `data-theme` attribute. Colours are
 * paired with the CSS custom properties in the app stylesheet so the editor and
 * the preview stay visually consistent, and contrast targets are AA for body text.
 */
export function editorTheme(theme: ColorTheme): Extension {
  const light = theme === "light";
  return [
    EditorView.theme(
      {
        "&": {
          color: light ? "#1c2024" : "#e8eaed",
          backgroundColor: "transparent",
          height: "100%",
          fontSize: "0.95rem",
        },
        ".cm-content": {
          fontFamily:
            "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
          padding: "1rem 1.25rem",
          caretColor: light ? "#1c2024" : "#e8eaed",
          lineHeight: "1.7",
        },
        ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
        ".cm-line": { padding: "0" },
        "&.cm-focused": { outline: "none" },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
          backgroundColor: light ? "#cfe3ff" : "#2d4a75",
        },
        ".cm-cursor": { borderLeftColor: light ? "#1c2024" : "#e8eaed" },
        ".cm-placeholder": { color: light ? "#8a94a6" : "#8b95a5" },
      },
      { dark: !light },
    ),
    syntaxHighlighting(light ? lightHighlight : darkHighlight),
  ];
}
