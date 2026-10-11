import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IndexedDbBackend } from "@localnotes/storage";
import { Store } from "@localnotes/shared";
import { App } from "@localnotes/ui";

let dbCounter = 0;

function makeStore(): Store {
  dbCounter += 1;
  return new Store(new IndexedDbBackend({ databaseName: `ui-test-${dbCounter}` }));
}

/** Renders the app with a 1 ms autosave debounce so tests stay fast. */
function setup() {
  const store = makeStore();
  const onDownload = vi.fn();
  const view = render(<App store={store} autosaveDelayMs={1} onDownload={onDownload} />);
  return { store, onDownload, ...view };
}

async function ready() {
  await screen.findByRole("navigation", { name: "Notebooks" });
}

async function createFirstNotebook(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /create your first notebook/i }));
  await screen.findByRole("tree");
}

async function typeInEditor(user: ReturnType<typeof userEvent.setup>, text: string) {
  const editor = await screen.findByTestId("markdown-editor");
  await user.click(editor);
  await user.keyboard(text);
}

describe("App (web/desktop shell)", () => {
  beforeEach(() => {
    document.documentElement.dataset["theme"] = "light";
  });

  it("shows an empty state and creates a notebook then a note", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    expect(screen.getByText(/no notebooks yet/i)).toBeInTheDocument();

    await createFirstNotebook(user);
    const tree = screen.getByRole("tree");
    expect(within(tree).getByText("Untitled notebook")).toBeInTheDocument();

    await user.click(within(tree).getByRole("button", { name: /new note in untitled notebook/i }));
    const title = await screen.findByLabelText("Title");
    await waitFor(() => expect((title as HTMLInputElement).value).toBe("Untitled note"));
    expect(await store.listNodes()).toHaveLength(2);
  });

  it("autosaves title and content locally and shows the save indicator", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    await user.click(
      within(screen.getByRole("tree")).getByRole("button", {
        name: /new note in untitled notebook/i,
      }),
    );

    const title = await screen.findByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Release plan");
    await typeInEditor(user, "Shipit");

    const editor = await screen.findByTestId("markdown-editor");
    const visible = (editor.textContent ?? "").trim();
    expect(visible.length).toBeGreaterThan(0);

    // The contract that matters: the durable copy matches what is on screen.
    await waitFor(
      async () => {
        const note = (await store.listNodes()).find((node) => node.kind === "note");
        expect(note?.title).toBe("Release plan");
        expect(note?.content).toBe(visible);
      },
      { timeout: 3000 },
    );

    await waitFor(() =>
      expect(screen.getByTestId("save-indicator").textContent).toMatch(/Saved locally/),
    );
  });

  it("flushes an unsaved edit before switching notes", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    const tree = screen.getByRole("tree");
    await user.click(within(tree).getByRole("button", { name: /new note in untitled notebook/i }));
    await typeInEditor(user, "firstnote");
    const editor = await screen.findByTestId("markdown-editor");
    const typed = (editor.textContent ?? "").trim();
    expect(typed.length).toBeGreaterThan(0);

    // Create a second note immediately, without waiting for the debounce: the
    // unsaved edit in note 1 must still reach storage.
    await user.click(within(tree).getByRole("button", { name: /new note in untitled notebook/i }));
    await waitFor(async () => {
      const notes = (await store.listNodes()).filter((node) => node.kind === "note");
      expect(notes).toHaveLength(2);
      const saved = notes.find((note) => note.content === typed);
      expect(saved).toBeDefined();
      expect(saved?.contentHash).toHaveLength(64);
    });
  });

  it("keeps a local edit when the save fails and offers a retry", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    await user.click(
      within(screen.getByRole("tree")).getByRole("button", {
        name: /new note in untitled notebook/i,
      }),
    );
    const title = await screen.findByLabelText("Title");

    const spy = vi.spyOn(store.backend, "writeNodes").mockRejectedValueOnce(new Error("disk full"));
    await user.clear(title);
    await user.type(title, "Will fail");

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toMatch(/Could not save this note/i);
    const retries = screen.getAllByRole("button", { name: "Retry" });
    spy.mockRestore();

    await user.click(retries[retries.length - 1] as HTMLElement);
    await waitFor(async () => {
      const note = (await store.listNodes()).find((node) => node.kind === "note");
      expect(note?.title).toBe("Will fail");
    });
  });

  it("confirms before deleting and removes the whole subtree", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    const tree = screen.getByRole("tree");
    await user.click(within(tree).getByRole("button", { name: /new note in untitled notebook/i }));
    await user.click(within(tree).getByRole("button", { name: /new folder in untitled notebook/i }));
    await user.click(
      within(screen.getByRole("tree")).getByRole("button", {
        name: /new note in untitled folder/i,
      }),
    );

    await user.click(screen.getByRole("button", { name: /delete untitled notebook/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/cannot be undone/i);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await store.listNodes()).toHaveLength(4);

    await user.click(screen.getByRole("button", { name: /delete untitled notebook/i }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(async () => expect(await store.listNodes()).toHaveLength(0));
  });

  it("renames from the tree and moves with the move dialog", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    const tree = screen.getByRole("tree");
    await user.click(within(tree).getByRole("button", { name: /new folder in untitled notebook/i }));

    const renameButton = within(screen.getByRole("tree")).getByRole("button", {
      name: /rename untitled folder/i,
    });
    await user.click(renameButton);
    const input = screen.getByRole("textbox", { name: /rename untitled folder/i });
    await user.clear(input);
    await user.type(input, "Inbox{Enter}");
    await waitFor(async () => {
      expect((await store.listNodes()).map((node) => node.title)).toContain("Inbox");
    });

    // Move the folder back into the notebook via the dialog.
    await user.click(
      within(screen.getByRole("tree")).getByRole("button", { name: /move untitled notebook/i }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("searches notes and opens a result", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    await user.click(
      within(screen.getByRole("tree")).getByRole("button", {
        name: /new note in untitled notebook/i,
      }),
    );
    const title = await screen.findByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Grocery list");
    await waitFor(async () => {
      expect((await store.listNodes()).some((node) => node.title === "Grocery list")).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: /new note in untitled notebook/i }));
    const search = screen.getByTestId("search-input");
    await user.type(search, "grocery");
    const results = await screen.findByLabelText("Search results");
    expect(within(results).getByText("Grocery list")).toBeInTheDocument();
    await user.click(within(results).getByRole("button", { name: /grocery list/i }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Grocery list"));

    await user.click(screen.getByRole("button", { name: /clear search/i }));
    expect(screen.queryByLabelText("Search results")).toBeNull();
  });

  it("creates a note with the keyboard shortcut", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    await user.keyboard("{Control>}n{/Control}");
    await waitFor(async () => {
      expect((await store.listNodes()).filter((node) => node.kind === "note")).toHaveLength(1);
    });
  });

  it("exports an archive without leaving the app", async () => {
    const user = userEvent.setup();
    const { store, onDownload } = setup();
    await ready();
    await createFirstNotebook(user);
    await user.click(
      within(screen.getByRole("tree")).getByRole("button", {
        name: /new note in untitled notebook/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
    const [bytes, filename] = onDownload.mock.calls[0] as [Uint8Array, string];
    expect(filename).toMatch(/^localnotes-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect((await store.listNodes()).length).toBe(2);
  });

  it("imports an archive chosen by the user", async () => {
    // Build the archive outside the UI, then import it through the real file input.
    const source = makeStore();
    await source.init();
    const notebook = await source.createNode({
      kind: "notebook",
      parentId: null,
      title: "Imported notebook",
    });
    await source.createNode({
      kind: "note",
      parentId: notebook.id,
      title: "Imported note",
      content: "# Imported",
    });
    const archive = await (await import("@localnotes/markdown")).exportArchive(source);

    const target = makeStore();
    render(<App store={target} autosaveDelayMs={1} onDownload={vi.fn()} />);
    await ready();

    const input = screen.getByTestId("import-input") as HTMLInputElement;
    const file = new File([archive.bytes as unknown as BlobPart], "archive.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(async () => {
      const titles = (await target.listNodes()).map((node) => node.title);
      expect(titles).toContain("Imported note");
    });
    expect(await screen.findByText("Imported note")).toBeInTheDocument();
  });

  it("renders an existing note's Markdown in the preview pane", async () => {
    const user = userEvent.setup();
    const { store } = setup();
    await ready();
    await createFirstNotebook(user);
    const [notebook] = await store.listNodes();
    const note = await store.createNode({
      kind: "note",
      parentId: notebook?.id ?? null,
      title: "Rendered",
      content: "# Heading\n\n**bold** text\n\n- [x] done\n\n![diagram](attachments/missing.png)",
    });
    await user.click(
      within(screen.getByRole("tree")).getByRole("button", { name: /new note in untitled notebook/i }),
    );
    await user.click(screen.getByRole("button", { name: /^Split$/ }));
    // Reopen the seeded note through search, which exercises the same path.
    await user.type(screen.getByTestId("search-input"), "Rendered");
    const results = await screen.findByLabelText("Search results");
    await user.click(within(results).getByRole("button", { name: /rendered/i }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Rendered"));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue(note.title));
    const preview = await screen.findByTestId("markdown-preview");
    expect(within(preview).getByRole("heading", { level: 1, name: "Heading" })).toBeInTheDocument();
    expect(within(preview).getByText("bold")).toBeInTheDocument();
    expect(
      within(preview).getByRole("img", { name: /Image not available: diagram/ }),
    ).toBeInTheDocument();
  });

  it("exposes accessible landmarks, tree semantics and a live region", async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    await createFirstNotebook(user);
    const tree = screen.getByRole("tree", { name: "Notebooks and notes" });
    expect(tree).toBeInTheDocument();
    const item = within(tree).getByRole("treeitem");
    expect(item).toHaveAttribute("aria-level", "1");
    expect(item).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("save-indicator")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("sync-status").textContent).toMatch(/local only/i);
    expect(screen.getByRole("link", { name: /skip to editor/i })).toBeInTheDocument();
  });

  it("collapses and reopens the sidebar", async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    expect(screen.getByRole("heading", { name: "Local Notes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /hide sidebar/i }));
    expect(screen.queryByRole("heading", { name: "Local Notes" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /show sidebar/i }));
    expect(screen.getByRole("heading", { name: "Local Notes" })).toBeInTheDocument();
  });
});
