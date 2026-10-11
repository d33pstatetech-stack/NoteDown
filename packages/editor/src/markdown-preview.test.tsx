import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MarkdownPreview } from "./markdown-preview";
import { resolveImageSource, AttachmentProvider } from "./attachment";

const ID = "6f1c1f9a-4a2b-4d31-9c8e-0a1b2c3d4e5f";

describe("MarkdownPreview", () => {
  it("renders the GitHub-Flavored Markdown subset the app supports", () => {
    const markdown = [
      "# Heading",
      "",
      "Paragraph with **bold**, *italic* and `code`.",
      "",
      "> quoted",
      "",
      "- [ ] todo",
      "- [x] done",
      "",
      "1. first",
      "2. second",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "[example](https://example.com)",
    ].join("\n");

    render(<MarkdownPreview markdown={markdown} />);
    expect(screen.getByRole("heading", { level: 1, name: "Heading" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("italic")).toBeInTheDocument();
    expect(screen.getByText("quoted")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "example" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("does not execute raw HTML from a note", () => {
    render(<MarkdownPreview markdown={'<script>globalThis.pwned = true</script>\n\nplain'} />);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>/)).toBeInTheDocument();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("resolves attachment references through the provided map", () => {
    const imageUrls = new Map([[`attachments/${ID}.png`, "blob:local/1"]]);
    render(
      <MarkdownPreview
        markdown={`![diagram](attachments/${ID}.png)`}
        imageUrls={imageUrls}
      />,
    );
    const image = screen.getByRole("img");
    expect(image).toHaveAttribute("src", "blob:local/1");
    expect(image).toHaveAttribute("alt", "diagram");
  });

  it("shows a readable placeholder instead of a broken image", () => {
    render(<MarkdownPreview markdown={`![architecture](attachments/${ID}.png)`} />);
    const placeholder = screen.getByRole("img", { name: /Image not available: architecture/ });
    expect(placeholder).toBeInTheDocument();
    expect(within(placeholder).getByText(/image not available/)).toBeInTheDocument();
  });

  it("renders http(s) images as-is and refuses local-filesystem or script URLs", () => {
    render(
      <MarkdownPreview
        markdown={[
          "![a](https://example.com/a.png)",
          "![b](file:///home/me/secret.png)",
          "![c](javascript:alert(1))",
          "![d](blob:http://localhost/deadbeef)",
        ].join("\n\n")}
      />,
    );
    expect(screen.getByAltText("a")).toHaveAttribute("src", "https://example.com/a.png");
    // The unsafe ones render the placeholder rather than an <img>.
    expect(screen.queryByAltText("b")).toBeNull();
    expect(screen.queryByAltText("c")).toBeNull();
    expect(screen.queryByAltText("d")).toBeNull();
    expect(screen.getAllByRole("img", { name: /Image not available/ })).toHaveLength(3);
  });

  it("falls back to a resolver from context", () => {
    render(
      <AttachmentProvider resolver={(ref) => (ref.endsWith(".png") ? "blob:from-context" : null)}>
        <MarkdownPreview markdown={`![d](attachments/${ID}.png)`} />
      </AttachmentProvider>,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", "blob:from-context");
  });
});

describe("resolveImageSource", () => {
  it("prefers the app-provided map, then the resolver, and never guesses", () => {
    expect(
      resolveImageSource(`attachments/${ID}.png`, {
        imageUrls: new Map([[`attachments/${ID}.png`, "blob:map"]]),
        resolver: () => "blob:resolver",
      }),
    ).toBe("blob:map");
    expect(resolveImageSource(`attachments/${ID}.png`, { resolver: () => "blob:resolver" })).toBe(
      "blob:resolver",
    );
    expect(resolveImageSource(`attachments/${ID}.png`, {})).toBeNull();
    expect(resolveImageSource("   ", {})).toBeNull();
  });

  it("passes through external schemes but not absolute host paths", () => {
    expect(resolveImageSource("https://example.com/a.png", {})).toBe("https://example.com/a.png");
    expect(resolveImageSource("data:image/png;base64,AA", {})).toBe("data:image/png;base64,AA");
    expect(resolveImageSource("/home/me/Pictures/a.png", {})).toBeNull();
    expect(resolveImageSource("file:///home/me/a.png", {})).toBeNull();
    expect(resolveImageSource("javascript:alert(1)", {})).toBeNull();
    expect(resolveImageSource("blob:http://localhost/deadbeef", {})).toBeNull();
    expect(resolveImageSource("data:image/png;base64,AA", {})).toBe("data:image/png;base64,AA");
    expect(resolveImageSource("data:text/html,<b>x</b>", {})).toBeNull();
  });

  it("resolves legacy relative references against the note path", () => {
    const imageUrls = new Map([["attachments/abc.png", "blob:resolved"]]);
    // `notebooks/Work/Design/somewhere` needs three `..` to reach the root.
    expect(
      resolveImageSource("../../../attachments/abc.png", {
        imageUrls,
        notePath: "notebooks/Work/Design/note.md",
      }),
    ).toBe("blob:resolved");
  });
});
