import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTree, errorMessage, nowIso, readFileBytes, searchNodes } from "@localnotes/shared";
import type { Node, SearchHit, StorageInfo, Store, TreeNode } from "@localnotes/shared";
import { exportArchive, importArchive } from "@localnotes/markdown";

/** Debounce before a keystroke becomes a durable local write. */
export const AUTOSAVE_DELAY_MS = 500;

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export interface Notice {
  id: string;
  kind: "info" | "error";
  message: string;
  action?: { label: string; run: () => void };
}

export interface Draft {
  id: string;
  kind: Node["kind"];
  title: string;
  content: string;
  /** The `localVersion` this draft was based on; guards against clobbering. */
  version: number;
}

export interface WorkspaceApi {
  status: "loading" | "ready" | "failed";
  fatalError: string | null;
  nodes: Node[];
  tree: TreeNode[];
  storage: StorageInfo | null;
  pendingOps: number;
  selectedId: string | null;
  draft: Draft | null;
  saveState: SaveState;
  lastSavedAt: string | null;
  dirty: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  results: SearchHit[] | null;
  notices: Notice[];
  dismissNotice: (id: string) => void;
  pushNotice: (notice: Omit<Notice, "id">) => void;
  open: (id: string | null) => Promise<void>;
  createNotebook: () => Promise<void>;
  createFolder: (parentId: string) => Promise<void>;
  createNote: (parentId: string | null) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  move: (id: string, parentId: string, position?: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Stores an image locally and returns the portable Markdown reference. */
  attachImage: (file: File) => Promise<{ reference: string; filename: string }>;
  setTitle: (title: string) => void;
  setContent: (content: string) => void;
  flush: () => Promise<void>;
  reload: () => Promise<void>;
  exportBytes: () => Promise<{ bytes: Uint8Array; files: string[]; warnings: string[] }>;
  importBytes: (bytes: Uint8Array) => Promise<void>;
}

let noticeCounter = 0;

/**
 * All application behaviour for the local-first workspace, independent of
 * rendering. Every mutation goes to the store immediately (offline by design);
 * the draft only exists so typing is debounced and a visible save indicator can
 * be shown. Switching notes flushes first, so an unsaved edit cannot be lost.
 */
export function useWorkspace(store: Store, options: { autosaveDelayMs?: number } = {}): WorkspaceApi {
  const delay = options.autosaveDelayMs ?? AUTOSAVE_DELAY_MS;
  const [status, setStatus] = useState<WorkspaceApi["status"]>("loading");
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [pendingOps, setPendingOps] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);

  const draftRef = useRef<Draft | null>(null);
  const selectedRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushNotice = useCallback((notice: Omit<Notice, "id">) => {
    setNotices((current) => {
      // Repeating the same failure (a retry loop) must not stack identical toasts.
      if (current.some((existing) => existing.message === notice.message)) return current;
      noticeCounter += 1;
      return [...current, { ...notice, id: `notice-${noticeCounter}` }];
    });
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const refresh = useCallback(
    async (options2: { keepSelection?: boolean } = {}) => {
      const live = await store.listNodes();
      setNodes(live);
      setStorage(await store.stats());
      setPendingOps(await store.pendingCount());
      const current = selectedRef.current;
      if (current && !options2.keepSelection) {
        const stillThere = live.some((node) => node.id === current);
        if (!stillThere) {
          selectedRef.current = null;
          draftRef.current = null;
          setSelectedId(null);
          setDraft(null);
          setSaveState("idle");
        }
      }
      return live;
    },
    [store],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await store.init();
        if (cancelled) return;
        await refresh();
        if (cancelled) return;
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setFatalError(errorMessage(error));
        setStatus("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, refresh]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Single-flight save loop.
   *
   * Concurrent flushes are the normal case (debounce firing while the user
   * keeps typing, a flush before switching notes, Ctrl+S), and each one must
   * carry the version it wrote or the store would reject the next write as
   * stale. One loop at a time, re-reading the draft after every await, is what
   * makes that correct.
   */
  const runFlushLoop = useCallback(async () => {
    while (dirtyRef.current) {
      const draftBeforeSave = draftRef.current;
      const id = selectedRef.current;
      if (!draftBeforeSave || !id) break;

      // Consume the dirty flag: edits made during the await set it again, which
      // is what makes the loop pick them up instead of dropping them.
      dirtyRef.current = false;
      setSaveState("saving");
      try {
        // A blank title is a normal intermediate state while the user retypes
        // it: keep the previous title instead of rejecting the whole save.
        const titleIsBlank = draftBeforeSave.title.trim().length === 0;
        const updated = await store.updateNode(
          id,
          titleIsBlank
            ? { content: draftBeforeSave.content }
            : { title: draftBeforeSave.title, content: draftBeforeSave.content },
          draftBeforeSave.version,
        );
        const latest = draftRef.current;
        if (latest === draftBeforeSave) {
          const next: Draft = {
            ...draftBeforeSave,
            // The draft keeps the user's exact text (including a trailing space
            // or a title being retyped); only the version pointer comes from
            // the store, whose copy is normalised for storage.
            version: updated.localVersion,
          };
          draftRef.current = next;
          setDraft(next);
        } else if (latest) {
          // The user typed while the write was in flight: keep the newer text
          // and only advance the version pointer.
          const next: Draft = { ...latest, version: updated.localVersion };
          draftRef.current = next;
          setDraft(next);
          dirtyRef.current = true;
        }
        if (!dirtyRef.current) {
          setSaveState("saved");
          setLastSavedAt(nowIso());
          await refresh({ keepSelection: true });
        } else {
          setSaveState("dirty");
        }
      } catch (error) {
        dirtyRef.current = true;
        setSaveState("error");
        pushNotice({
          kind: "error",
          message: `Could not save this note: ${errorMessage(error)}`,
          action: {
            label: "Retry",
            run: () => {
              void flushRef.current();
            },
          },
        });
        return;
      }
    }
  }, [pushNotice, refresh, store]);

  const flushInFlight = useRef<Promise<void> | null>(null);

  const flush = useCallback(async () => {
    clearTimer();
    if (flushInFlight.current) {
      await flushInFlight.current;
      if (!dirtyRef.current) return;
    }
    const task = runFlushLoop();
    flushInFlight.current = task;
    try {
      await task;
    } finally {
      flushInFlight.current = null;
    }
  }, [clearTimer, runFlushLoop]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const schedule = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      void flush();
    }, delay);
  }, [clearTimer, delay, flush]);

  useEffect(() => clearTimer, [clearTimer]);

  const open = useCallback(
    async (id: string | null) => {
      await flush();
      if (id === null) {
        selectedRef.current = null;
        draftRef.current = null;
        setSelectedId(null);
        setDraft(null);
        setSaveState("idle");
        return;
      }
      const node = await store.getNode(id);
      if (!node) {
        pushNotice({ kind: "error", message: "That item no longer exists." });
        return;
      }
      const nextDraft: Draft = {
        id: node.id,
        kind: node.kind,
        title: node.title,
        content: node.kind === "note" ? node.content : "",
        version: node.localVersion,
      };
      selectedRef.current = node.id;
      draftRef.current = nextDraft;
      dirtyRef.current = false;
      setSelectedId(node.id);
      setDraft(nextDraft);
      setSaveState("idle");
    },
    [flush, pushNotice, store],
  );

  const createNotebook = useCallback(async () => {
    const node = await store.createNode({ kind: "notebook", parentId: null });
    await refresh({ keepSelection: true });
    await open(node.id);
  }, [open, refresh, store]);

  const createFolder = useCallback(
    async (parentId: string) => {
      const node = await store.createNode({ kind: "folder", parentId });
      await refresh({ keepSelection: true });
      await open(node.id);
    },
    [open, refresh, store],
  );

  const createNote = useCallback(
    async (parentId: string | null) => {
      let target = parentId;
      if (target === null) {
        const live = await store.listNodes();
        const notebook = live.find((node) => node.kind === "notebook");
        target = notebook
          ? notebook.id
          : (await store.createNode({ kind: "notebook", parentId: null, title: "Notes" })).id;
      }
      const node = await store.createNode({ kind: "note", parentId: target });
      await refresh({ keepSelection: true });
      await open(node.id);
    },
    [open, refresh, store],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      await store.renameNode(id, title);
      if (selectedRef.current === id) {
        const node = await store.getNode(id);
        if (node) {
          const nextDraft: Draft = {
            id: node.id,
            kind: node.kind,
            title: node.title,
            content: dirtyRef.current ? (draftRef.current?.content ?? "") : node.content,
            version: node.localVersion,
          };
          draftRef.current = nextDraft;
          setDraft(nextDraft);
        }
      }
      await refresh({ keepSelection: true });
    },
    [refresh, store],
  );

  const move = useCallback(
    async (id: string, parentId: string, position?: number) => {
      await store.moveNode(id, parentId, position);
      await refresh({ keepSelection: true });
    },
    [refresh, store],
  );

  const remove = useCallback(
    async (id: string) => {
      const { deletedIds } = await store.deleteNode(id);
      if (selectedRef.current && deletedIds.includes(selectedRef.current)) {
        selectedRef.current = null;
        draftRef.current = null;
        dirtyRef.current = false;
        setSelectedId(null);
        setDraft(null);
        setSaveState("idle");
      }
      await refresh({ keepSelection: true });
    },
    [refresh, store],
  );

  const applyDraftChange = useCallback(
    (patch: Partial<Pick<Draft, "title" | "content">>) => {
      const current = draftRef.current;
      if (!current) return;
      const next: Draft = { ...current, ...patch };
      draftRef.current = next;
      dirtyRef.current = true;
      setDraft(next);
      setSaveState("dirty");
      schedule();
    },
    [schedule],
  );

  const setTitle = useCallback((title: string) => applyDraftChange({ title }), [applyDraftChange]);
  const setContent = useCallback(
    (content: string) => applyDraftChange({ content }),
    [applyDraftChange],
  );

  const attachImage = useCallback(
    async (file: File) => {
      const bytes = await readFileBytes(file);
      const meta = await store.putAttachment({
        noteId: selectedRef.current,
        filename: file.name.length > 0 ? file.name : "image",
        bytes,
      });
      await refresh({ keepSelection: true });
      return { reference: `attachments/${meta.id}.${meta.ext}`, filename: meta.filename };
    },
    [refresh, store],
  );

  const exportBytes = useCallback(async () => {
    const result = await exportArchive(store);
    for (const warning of result.warnings) {
      pushNotice({ kind: "error", message: warning });
    }
    return { bytes: result.bytes, files: result.files, warnings: result.warnings };
  }, [pushNotice, store]);

  const importBytes = useCallback(
    async (bytes: Uint8Array) => {
      const result = await importArchive(bytes, store);
      await refresh({ keepSelection: true });
      for (const warning of result.warnings) {
        pushNotice({ kind: "error", message: warning });
      }
      pushNotice({
        kind: "info",
        message: `Imported ${result.report.createdNodes} item(s) and ${result.report.attachments} attachment(s).`,
      });
    },
    [pushNotice, refresh, store],
  );

  const reload = useCallback(async () => {
    await store.reload();
    await refresh();
  }, [refresh, store]);

  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const results = useMemo(
    () => (searchQuery.trim().length === 0 ? null : searchNodes(nodes, searchQuery, { limit: 50 })),
    [nodes, searchQuery],
  );

  return {
    status,
    fatalError,
    nodes,
    tree,
    storage,
    pendingOps,
    selectedId,
    draft,
    saveState,
    lastSavedAt,
    dirty: saveState === "dirty" || saveState === "saving" || saveState === "error",
    searchQuery,
    setSearchQuery,
    results,
    notices,
    dismissNotice,
    pushNotice,
    open,
    createNotebook,
    createFolder,
    createNote,
    rename,
    move,
    remove,
    attachImage,
    setTitle,
    setContent,
    flush,
    reload,
    exportBytes,
    importBytes,
  };
}
