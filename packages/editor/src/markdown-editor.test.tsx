import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownEditor } from "./markdown-editor";

describe("MarkdownEditor", () => {
  it("mounts a CodeMirror view with the initial document and an accessible label", async () => {
    render(<MarkdownEditor value={"# Hello\n\nbody"} onChange={() => {}} ariaLabel="Note content" />);
    const editor = await screen.findByTestId("markdown-editor");
    expect(editor).toHaveAttribute("aria-label", "Note content");
    expect(editor.getAttribute("aria-multiline")).toBe("true");
    expect(editor.textContent).toContain("Hello");
  });

  it("reports edits through onChange", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"a"} onChange={onChange} />);
    const editor = await screen.findByTestId("markdown-editor");
    await userEvent.click(editor);
    await userEvent.keyboard("bc");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toContain("bc");
  });

  it("applies an external value change without losing it", async () => {
    const { rerender } = render(<MarkdownEditor value={"first"} onChange={() => {}} />);
    const editor = await screen.findByTestId("markdown-editor");
    expect(editor.textContent).toContain("first");
    rerender(<MarkdownEditor value={"second version"} onChange={() => {}} />);
    expect(editor.textContent).toContain("second version");
  });

  it("runs onSave for Ctrl+Enter", async () => {
    const onSave = vi.fn();
    render(<MarkdownEditor value={"x"} onChange={() => {}} onSave={onSave} />);
    const editor = await screen.findByTestId("markdown-editor");
    await userEvent.click(editor);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("hands pasted images to onAttachFiles", async () => {
    const onAttachFiles = vi.fn();
    render(<MarkdownEditor value={""} onChange={() => {}} onAttachFiles={onAttachFiles} />);
    const editor = await screen.findByTestId("markdown-editor");
    const file = new File([new Uint8Array([0x89, 0x50])], "a.png", { type: "image/png" });
    editor.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true }), {
        clipboardData: { files: [file] },
      }),
    );
    expect(onAttachFiles).toHaveBeenCalledWith([file]);
  });
});
