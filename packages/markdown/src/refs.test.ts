import { describe, expect, it } from "vitest";
import {
  canonicalRef,
  canonicalRefFromMime,
  extractReferences,
  parseCanonicalRef,
  referencedAttachmentIds,
  rewriteForExport,
  rewriteForImport,
  rewriteReferences,
} from "./refs";

const ID = "6f1c1f9a-4a2b-4d31-9c8e-0a1b2c3d4e5f";

describe("portable attachment references", () => {
  it("builds and parses the canonical form", () => {
    expect(canonicalRef({ id: ID, ext: "png" })).toBe(`attachments/${ID}.png`);
    expect(canonicalRefFromMime(ID, "image/jpeg")).toBe(`attachments/${ID}.jpg`);
    expect(parseCanonicalRef(`attachments/${ID}.png`)).toEqual({ id: ID, ext: "png" });
  });

  it("only accepts the canonical shape", () => {
    expect(parseCanonicalRef(`${ID}.png`)).toBeNull();
    expect(parseCanonicalRef(`attachments/nested/${ID}.png`)).toBeNull();
    expect(parseCanonicalRef("attachments/no-extension")).toBeNull();
    expect(parseCanonicalRef("/home/me/Pictures/diagram.png")).toBeNull();
    expect(parseCanonicalRef("blob:http://localhost:5173/1234")).toBeNull();
  });

  it("extracts references from Markdown, HTML and links, without duplicates", () => {
    const markdown = [
      `![diagram](attachments/${ID}.png)`,
      `![second](attachments/${ID}.png "same one")`,
      "[a link](../notebooks/Work/other.md)",
      '<img src="attachments/other.png" alt="x">',
      "![remote](https://example.com/x.png)",
    ].join("\n\n");
    const refs = extractReferences(markdown);
    expect(refs).toContain(`attachments/${ID}.png`);
    expect(refs).toContain("attachments/other.png");
    expect(refs).toContain("../notebooks/Work/other.md");
    expect(refs).toContain("https://example.com/x.png");
    // Both `attachments/...` targets are canonical-shaped; the HTML one has a
    // placeholder id, which is exactly why imports re-resolve by content.
    expect(referencedAttachmentIds(markdown)).toEqual([ID, "other"]);
  });

  it("leaves non-matching targets untouched and keeps surrounding syntax", () => {
    const markdown = `![a](https://x/y.png "title") and [b](other.md)`;
    expect(rewriteReferences(markdown, () => null)).toBe(markdown);
    expect(rewriteReferences(markdown, (t) => (t === "other.md" ? "z.md" : null))).toContain(
      "[b](z.md)",
    );
  });

  it("rewrites canonical refs to note-relative paths on export", () => {
    const note = "notebooks/Work/Design/architecture.md";
    const { markdown, missing } = rewriteForExport(
      `![d](attachments/${ID}.png)`,
      note,
      new Map([[ID, `attachments/${ID}.png`]]),
    );
    expect(markdown).toBe(`![d](../../../attachments/${ID}.png)`);
    expect(missing).toEqual([]);
  });

  it("reports refs whose bytes are unavailable instead of inventing a path", () => {
    const { markdown, missing } = rewriteForExport(
      "![d](attachments/missing.png)",
      "notebooks/a.md",
      new Map(),
    );
    expect(markdown).toBe("![d](attachments/missing.png)");
    expect(missing).toEqual(["attachments/missing.png"]);
  });

  it("round-trips export then import back to the canonical form", () => {
    const note = "notebooks/Work/Design/architecture.md";
    const original = `# Title\n\n![d](attachments/${ID}.png)\n\n[link](https://example.com)`;
    const exported = rewriteForExport(original, note, new Map([[ID, `attachments/${ID}.png`]]));
    const imported = rewriteForImport(exported.markdown, note, {
      attachmentRef: (resolved) => resolved,
    });
    expect(imported.markdown).toBe(original);
    expect(imported.referenced).toEqual([`attachments/${ID}.png`]);
  });

  it("rewrites references to regenerated ids when an archive uses plain filenames", () => {
    const note = "notebooks/Work/note.md";
    const result = rewriteForImport("![p](diagram.png)", note, {
      attachmentRef: (_resolved, filename) =>
        filename === "diagram.png" ? "attachments/11111111-1111-4111-8111-111111111111.png" : undefined,
    });
    expect(result.markdown).toBe("![p](attachments/11111111-1111-4111-8111-111111111111.png)");
  });

  it("never rewrites external URLs on import", () => {
    const result = rewriteForImport("![r](https://example.com/x.png)", "notebooks/a.md", {
      attachmentRef: () => "attachments/should-not-happen.png",
    });
    expect(result.markdown).toBe("![r](https://example.com/x.png)");
  });
});
