import { describe, expect, it } from "vitest";
import { strToU8, unzipSync } from "fflate";
import { MemoryBackend, Store } from "./helpers";
import { exportArchive, importArchive, parseFrontMatter } from "@localnotes/markdown";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function makeStore() {
  return new Store(new MemoryBackend());
}

async function buildSource() {
  const store = makeStore();
  await store.init();

  const work = await store.createNode({ kind: "notebook", parentId: null, title: "Work" });
  const personal = await store.createNode({ kind: "notebook", parentId: null, title: "Personal" });
  const design = await store.createNode({
    kind: "folder",
    parentId: work.id,
    title: "Design & Architecture",
  });
  const unicode = await store.createNode({
    kind: "folder",
    parentId: design.id,
    title: "Ünïcödé 🎨 / weird: name?",
  });
  const trips = await store.createNode({ kind: "folder", parentId: personal.id, title: "Trips" });

  const note = await store.createNode({
    kind: "note",
    parentId: unicode.id,
    title: "Architecture: overview / v2",
    content: "# Architecture\n\nBody with *emphasis* and a [link](https://example.com).\n",
  });
  const second = await store.createNode({
    kind: "note",
    parentId: design.id,
    title: "Architecture: overview / v2", // duplicate title in a different folder
    content: "Duplicate title, different folder.",
  });
  await store.createNode({
    kind: "note",
    parentId: trips.id,
    title: "Packing list",
    content: "- [ ] passport\n- [x] tickets\n",
  });
  // A note in a notebook root, not inside a folder.
  await store.createNode({
    kind: "note",
    parentId: work.id,
    title: "Inbox",
    content: "Loose thoughts",
  });

  const png = await store.putAttachment({ noteId: note.id, filename: "diagram one.png", bytes: PNG });
  const jpg = await store.putAttachment({ noteId: note.id, filename: "photo.jpg", bytes: JPEG });
  await store.updateNode(
    note.id,
    {
      content:
        "# Architecture\n\n![diagram](attachments/" +
        png.id +
        ".png)\n\nAlso <img src=\"attachments/" +
        jpg.id +
        '.jpg" alt="photo">\n\n[external](https://example.com)\n',
    },
    note.localVersion,
  );
  return { store, work, personal, design, unicode, trips, note, second, png, jpg };
}

describe("archive export", () => {
  it("writes one .md per note, attachments, a README and the metadata sidecar", async () => {
    const { store, png, jpg } = await buildSource();
    const result = await exportArchive(store);
    const files = unzipSync(result.bytes);

    expect(result.warnings).toEqual([]);
    expect(Object.keys(files)).toEqual(result.files);
    expect(result.files).toContain("README.txt");
    expect(result.files).toContain(".localnotes/metadata.json");

    const notes = result.files.filter((f) => f.endsWith(".md"));
    expect(notes).toHaveLength(4);
    for (const path of notes) expect(path.startsWith("notebooks/")).toBe(true);

    // Titles are sanitized for the filesystem but stay recognizable.
    expect(notes.some((p) => p.includes("Design & Architecture"))).toBe(true);
    expect(notes.some((p) => p.includes("Ünïcödé 🎨 - weird- name-"))).toBe(true);
    // Duplicate titles get distinct files instead of overwriting each other.
    expect(notes.filter((p) => p.includes("Architecture- overview - v2")).length).toBe(2);

    expect(result.files).toContain(`attachments/${png.id}.png`);
    expect(result.files).toContain(`attachments/${jpg.id}.jpg`);
    expect(Array.from(files[`attachments/${png.id}.png`] ?? [])).toEqual(Array.from(PNG));
  });

  it("writes portable relative image references and strips host-specific paths", async () => {
    const { store, note, png, jpg } = await buildSource();
    const result = await exportArchive(store);
    const files = unzipSync(result.bytes);
    const notePath = result.nodePathById[note.id];
    expect(notePath).toBeTruthy();
    const notePathStr = notePath!;

    const text = new TextDecoder().decode(files[notePathStr] ?? new Uint8Array());
    const { fields, body } = parseFrontMatter(text);
    expect(fields["id"]).toBe(note.id);
    expect(fields["title"]).toBe("Architecture: overview / v2");

    // References are relative to the note file, and they resolve inside the archive.
    const depth = notePathStr.split("/").length - 1;
    const rel = (target: string) => "../".repeat(depth) + target;
    expect(body).toContain(`![diagram](${rel(`attachments/${png.id}.png`)})`);
    expect(body).toContain(`<img src="${rel(`attachments/${jpg.id}.jpg`)}" alt="photo">`);
    expect(body).not.toContain(`](attachments/${png.id}.png)`);
    // No absolute host path or object URL leaked into the Markdown.
    expect(body).not.toMatch(/file:\/\/|blob:|\/home\/|C:\\/);
    expect(body).toContain("[external](https://example.com)");
  });

  it("is deterministic in the set of files it writes for the same store", async () => {
    const { store } = await buildSource();
    const first = await exportArchive(store, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    const second = await exportArchive(store, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(first.files).toEqual(second.files);
  });
});

describe("archive round trip", () => {
  it("restores ids, hierarchy, content and attachments byte-for-byte", async () => {
    const source = await buildSource();
    const exported = await exportArchive(source.store);

    const target = makeStore();
    await target.init();
    const result = await importArchive(exported.bytes, target);

    expect(result.usedMetadata).toBe(true);
    expect(result.report.createdNodes).toBe(9);
    expect(result.report.attachments).toBe(2);
    expect(result.warnings).toEqual([]);

    const restored = await target.getTree();
    const titles = (await target.listNodes()).map((n) => n.title).sort();
    expect(titles).toEqual(
      [
        "Work",
        "Personal",
        "Design & Architecture",
        "Ünïcödé 🎨 / weird: name?",
        "Trips",
        "Architecture: overview / v2",
        "Architecture: overview / v2",
        "Packing list",
        "Inbox",
      ].sort(),
    );
    expect(restored).toHaveLength(2);

    const note = await target.getNode(source.note.id);
    expect(note?.title).toBe("Architecture: overview / v2");
    expect(note?.parentId).toBe(source.unicode.id);
    expect(note?.content).toContain(`![diagram](attachments/${source.png.id}.png)`);
    expect(note?.content).toContain(`<img src="attachments/${source.jpg.id}.jpg" alt="photo">`);
    expect(await target.getPathLabel(source.note.id)).toBe(
      "Work / Design & Architecture / Ünïcödé 🎨 / weird: name? / Architecture: overview / v2",
    );

    const attachment = await target.getAttachment(source.png.id);
    expect(attachment?.meta.mime).toBe("image/png");
    expect(Array.from(attachment?.bytes ?? [])).toEqual(Array.from(PNG));
    expect((await target.getAttachment(source.jpg.id))?.meta.mime).toBe("image/jpeg");

    // The task list survives as plain GitHub-Flavored Markdown.
    const packing = (await target.listNodes()).find((n) => n.title === "Packing list");
    expect(packing?.content).toBe("- [ ] passport\n- [x] tickets\n");
  });

  it("rebuilds the hierarchy from directories when the sidecar is absent", async () => {
    const source = await buildSource();
    const exported = await exportArchive(source.store);
    const files = unzipSync(exported.bytes);
    delete files[".localnotes/metadata.json"];

    const { zipSync } = await import("fflate");
    const stripped = zipSync(files, { level: 1 });

    const target = makeStore();
    await target.init();
    const result = await importArchive(stripped, target);

    expect(result.usedMetadata).toBe(false);
    expect(result.report.createdNodes).toBeGreaterThanOrEqual(4);
    // Notebooks and folders are recreated from the directory names.
    const titles = (await target.listNodes()).map((n) => n.title);
    expect(titles).toContain("Work");
    expect(titles).toContain("Design & Architecture");
    // The front matter still carries each note's title and id.
    const note = await target.getNode(source.note.id);
    expect(note?.content).toContain(`attachments/${source.png.id}.png`);
  });

  it("re-importing an unchanged archive does not duplicate anything", async () => {
    const source = await buildSource();
    const exported = await exportArchive(source.store);
    const target = makeStore();
    await target.init();

    const first = await importArchive(exported.bytes, target);
    const second = await importArchive(exported.bytes, target);
    expect(first.report.createdNodes).toBe(9);
    expect(second.report.createdNodes).toBe(0);
    expect(second.report.skippedNodes).toBe(9);
    expect(second.report.attachments).toBe(0);
    expect(await target.listNodes()).toHaveLength(9);
  });

  it("imports a hand-made folder of Markdown files that has no front matter", async () => {
    const { zipSync } = await import("fflate");
    const plain = zipSync(
      {
        "notebooks/Recipes/Soups/tomato.md": strToU8("# Tomato soup\n\nSimmer."),
        "notes.md": strToU8("Top-level note"),
      },
      { level: 1 },
    );

    const target = makeStore();
    await target.init();
    const result = await importArchive(plain, target);
    // Recipes, Soups, tomato + the "Imported" notebook holding the root-level note.
    expect(result.report.createdNodes).toBe(5);
    const titles = (await target.listNodes()).map((n) => n.title).sort();
    expect(titles).toEqual(["Imported", "Recipes", "Soups", "notes", "tomato"].sort());
    const tomato = (await target.listNodes()).find((n) => n.title === "tomato");
    expect(await target.getPathLabel(tomato?.id ?? "")).toBe("Recipes / Soups / tomato");
  });
});
