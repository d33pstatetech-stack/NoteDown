import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { MemoryBackend, Store } from "./helpers";
import { ImportError, LIMITS } from "@localnotes/shared";
import { importArchive } from "@localnotes/markdown";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function zip(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 1 });
}

async function freshStore(): Promise<Store> {
  const store = new Store(new MemoryBackend());
  await store.init();
  return store;
}

describe("archive import — hostile input", () => {
  const hostilePaths = [
    "../evil.md",
    "../../etc/passwd",
    "/etc/passwd",
    "//server/share/evil.md",
    "C:/windows/evil.md",
    "notes\\evil.md",
    "notes/../../evil.md",
    "attachments/../../evil.png",
  ];

  for (const path of hostilePaths) {
    it(`refuses the entry ${JSON.stringify(path)} and imports nothing`, async () => {
      const store = await freshStore();
      const archive = zip({ [path]: strToU8("# pwned"), "notebooks/ok.md": strToU8("# fine") });
      await expect(importArchive(archive, store)).rejects.toBeInstanceOf(ImportError);
      expect(await store.listNodes()).toHaveLength(0);
      expect(await store.listAttachments()).toHaveLength(0);
    });
  }

  it("refuses NUL bytes and control characters in entry names", async () => {
    const store = await freshStore();
    await expect(
      importArchive(zip({ "bad\u0000name.md": strToU8("x") }), store),
    ).rejects.toThrow(/NUL/);
    await expect(
      importArchive(zip({ "bad\u0007name.md": strToU8("x") }), store),
    ).rejects.toThrow(/control/);
  });

  it("refuses an over-long entry path", async () => {
    const store = await freshStore();
    const long = `${"deep/".repeat(300)}note.md`;
    await expect(importArchive(zip({ [long]: strToU8("x") }), store)).rejects.toThrow(/too long/);
  });

  it("refuses archives with too many entries", async () => {
    const store = await freshStore();
    const archive = zip({ "notebooks/a.md": strToU8("a"), "notebooks/b.md": strToU8("b") });
    await expect(importArchive(archive, store, { maxEntries: 1 })).rejects.toThrow(/limit 1/);
  });

  it("refuses archives larger than the configured limit", async () => {
    const store = await freshStore();
    const archive = zip({ "notebooks/a.md": strToU8("a") });
    await expect(importArchive(archive, store, { maxBytes: 8 })).rejects.toThrow(/larger than/);
  });

  it("refuses an empty or non-ZIP payload", async () => {
    const store = await freshStore();
    await expect(importArchive(new Uint8Array(0), store)).rejects.toThrow(/empty/i);
    await expect(importArchive(strToU8("not a zip at all"), store)).rejects.toThrow(/not a readable ZIP/);
  });

  it("does not trust a client-supplied image extension", async () => {
    const store = await freshStore();
    const archive = zip({
      "notebooks/note.md": strToU8("![x](../attachments/evil.png)"),
      // A file that claims to be a PNG but is a path-traversal payload.
      "attachments/evil.png": strToU8("../../../../etc/shadow"),
    });
    const result = await importArchive(archive, store);
    expect(result.warnings.join(" ")).toMatch(/Skipped attachments\/evil\.png/);
    expect(await store.listAttachments()).toHaveLength(0);
    // The reference is left as written rather than pointing at a missing object.
    const note = (await store.listNodes()).find((n) => n.kind === "note");
    expect(note?.content).toContain("../attachments/evil.png");
  });

  it("ignores macOS junk and duplicate-directory entries without failing", async () => {
    const store = await freshStore();
    const archive = zip({
      "__MACOSX/._note.md": strToU8("junk"),
      "notebooks/.DS_Store": strToU8("junk"),
      "notebooks/Thumbs.db": strToU8("junk"),
      "notebooks/Keep/": new Uint8Array(0),
      "notebooks/Keep/real.md": strToU8("# Kept"),
    });
    const result = await importArchive(archive, store);
    expect(result.noteFiles).toBe(1);
    const titles = (await store.listNodes()).map((n) => n.title);
    expect(titles).toEqual(["Keep", "real"]);
  });

  it("skips an attachment over the size limit but still imports the note", async () => {
    const store = await freshStore();
    const huge = new Uint8Array(LIMITS.attachmentBytes + 1);
    huge.set(PNG);
    const archive = zip({
      "notebooks/note.md": strToU8("text"),
      "attachments/big.png": huge,
    });
    const result = await importArchive(archive, store, { maxBytes: 64 * 1024 * 1024 });
    expect(result.warnings.join(" ")).toMatch(/exceeds/i);
    expect(result.report.attachments).toBe(0);
    expect(await store.listAttachments()).toHaveLength(0);
    expect((await store.listNodes()).length).toBeGreaterThan(0);
  });

  it("rejects a malformed metadata sidecar but still imports the files", async () => {
    const store = await freshStore();
    const archive = zip({
      ".localnotes/metadata.json": strToU8("{ not json"),
      "notebooks/Note.md": strToU8("# Fine"),
    });
    const result = await importArchive(archive, store);
    expect(result.usedMetadata).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/not valid JSON/);
    expect((await store.listNodes()).length).toBe(2);
  });
});
