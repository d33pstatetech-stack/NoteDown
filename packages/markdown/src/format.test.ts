import { describe, expect, it } from "vitest";
import { frontMatter, isArchiveMetadata, parseFrontMatter, readmeText } from "./format";

describe("front matter", () => {
  it("round-trips fields, including colons, quotes and unicode", () => {
    const fields = {
      title: 'Plan: "Q1" / Q2 🎨',
      id: "6f1c1f9a-4a2b-4d31-9c8e-0a1b2c3d4e5f",
      created: "2026-01-01T00:00:00.000Z",
    };
    const parsed = parseFrontMatter(`${frontMatter(fields)}\n# Body\n\ntext`);
    expect(parsed.hadFrontMatter).toBe(true);
    expect(parsed.fields).toEqual(fields);
    expect(parsed.body).toBe("# Body\n\ntext");
  });

  it("leaves plain Markdown untouched", () => {
    const text = "# Just a note\n\nwith --- inside";
    const parsed = parseFrontMatter(text);
    expect(parsed.hadFrontMatter).toBe(false);
    expect(parsed.body).toBe(text);
    expect(parsed.fields).toEqual({});
  });

  it("ignores an unterminated front matter block", () => {
    const text = "---\ntitle: broken\n\nbody";
    expect(parseFrontMatter(text).hadFrontMatter).toBe(false);
  });

  it("strips a BOM before detecting front matter", () => {
    const parsed = parseFrontMatter(`\uFEFF${frontMatter({ title: "x" })}\nbody`);
    expect(parsed.fields["title"]).toBe("x");
  });

  it("validates archive metadata shape", () => {
    expect(isArchiveMetadata({})).toBe(false);
    expect(isArchiveMetadata(null)).toBe(false);
    expect(
      isArchiveMetadata({ format: "localnotes-archive", version: 1, nodes: [], attachments: [] }),
    ).toBe(true);
  });

  it("describes the archive in the README", () => {
    const text = readmeText({
      format: "localnotes-archive",
      version: 1,
      generator: "test",
      exportedAt: "2026-01-01T00:00:00.000Z",
      checkpoint: null,
      nodes: [
        { id: "1", kind: "notebook", parentId: null, title: "n", path: "notebooks/n", position: 0, createdAt: "", updatedAt: "", contentHash: "", syncState: "local-only" },
        { id: "2", kind: "note", parentId: "1", title: "x", path: "notebooks/n/x.md", position: 0, createdAt: "", updatedAt: "", contentHash: "", syncState: "local-only" },
      ],
      attachments: [],
    });
    expect(text).toContain("1 notebook(s), 0 folder(s), 1 note(s)");
    expect(text).toContain("does not need this application");
  });
});
