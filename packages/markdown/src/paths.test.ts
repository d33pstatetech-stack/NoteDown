import { describe, expect, it } from "vitest";
import { ImportError } from "@localnotes/shared";
import {
  basename,
  dirname,
  joinPath,
  normalizeArchivePath,
  relativeFromDirectory,
  resolveReference,
  uniquePath,
} from "./paths";

describe("archive path validation", () => {
  it("accepts ordinary nested paths", () => {
    expect(normalizeArchivePath("notebooks/Work/Design/note.md")).toBe(
      "notebooks/Work/Design/note.md",
    );
    expect(normalizeArchivePath("attachments/abc.png")).toBe("attachments/abc.png");
  });

  it("rejects traversal, absolute paths, drive letters and backslashes", () => {
    const bad = [
      "../evil.md",
      "notes/../../evil.md",
      "/etc/passwd",
      "//server/share/x.md",
      "C:/windows/x.md",
      "C:\\windows\\x.md",
      "notes\\x.md",
      "notes//x.md",
      "./x.md",
      "notes/./x.md",
      "",
    ];
    for (const path of bad) {
      expect(() => normalizeArchivePath(path), path).toThrow(ImportError);
    }
  });

  it("rejects NUL bytes, control characters and over-long paths", () => {
    expect(() => normalizeArchivePath("a\u0000b.md")).toThrow(/NUL/);
    expect(() => normalizeArchivePath("a\u0001b.md")).toThrow(/control/);
    expect(() => normalizeArchivePath(`${"x/".repeat(600)}a.md`)).toThrow(/too long/);
  });
});

describe("path helpers", () => {
  it("splits dirname and basename", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
    expect(dirname("c.md")).toBe("");
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(joinPath("a", "b/c", "d")).toBe("a/b/c/d");
  });

  it("computes relative paths from a note directory", () => {
    // `notebooks/Work` is two levels deep, so it needs two `..` to reach the root.
    expect(relativeFromDirectory("notebooks/Work", "attachments/a.png")).toBe(
      "../../attachments/a.png",
    );
    expect(relativeFromDirectory("notebooks/Work/Design", "attachments/a.png")).toBe(
      "../../../attachments/a.png",
    );
    expect(relativeFromDirectory("", "attachments/a.png")).toBe("attachments/a.png");
  });

  it("resolves references against a note directory and refuses escapes", () => {
    expect(resolveReference("notebooks/Work/Design", "../../../attachments/a.png")).toBe(
      "attachments/a.png",
    );
    expect(resolveReference("notebooks", "sub/b.md")).toBe("notebooks/sub/b.md");
    expect(resolveReference("notebooks/Work/Design", "../sibling.md")).toBe(
      "notebooks/Work/sibling.md",
    );
    expect(resolveReference("notebooks", "https://example.com/x.png")).toBeNull();
    expect(resolveReference("notebooks", "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveReference("notebooks", "blob:http://localhost/abc")).toBeNull();
    expect(resolveReference("notebooks", "/absolute.png")).toBeNull();
    // Escaping the archive root must never resolve.
    expect(resolveReference("notebooks", "../../../../etc/passwd")).toBeNull();
    expect(resolveReference("notebooks", "%2e%2e/%2e%2e/secret")).toBeNull();
    expect(resolveReference("notebooks/Work", "diagram%20one.png")).toBe(
      "notebooks/Work/diagram one.png",
    );
  });

  it("produces unique export paths for colliding titles", () => {
    const taken = new Set(["notebooks/Work/Note.md"]);
    expect(uniquePath("notebooks/Work/Note.md", taken)).toBe("notebooks/Work/Note-2.md");
    taken.add("notebooks/Work/Note-2.md");
    expect(uniquePath("notebooks/Work/Note.md", taken)).toBe("notebooks/Work/Note-3.md");
    expect(uniquePath("notebooks/Work/Other.md", taken)).toBe("notebooks/Work/Other.md");
  });
});
