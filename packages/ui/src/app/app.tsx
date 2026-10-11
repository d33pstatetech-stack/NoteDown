import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { readFileBytes, subtreeIds } from "@localnotes/shared";
import type { Store } from "@localnotes/shared";
import { useWorkspace } from "./workspace";
import { useTheme } from "./theme";
import { useSyncController } from "./sync-controller";
import { Sidebar } from "../components/sidebar";
import { EditorPane } from "../components/editor-pane";
import { StatusBar } from "../components/status-bar";
import { AuthDialog } from "../components/auth-dialog";
import { ConfirmDialog, MoveDialog, NoticeStack } from "../components/dialogs";

export interface AppProps {
  store: Store;
  autosaveDelayMs?: number;
  /** Overridable for tests; defaults to a browser download. */
  onDownload?: (bytes: Uint8Array, filename: string) => void;
  appName?: string;
}

/** Event the status bar dispatches to open the sign-in dialog. */
export const OPEN_SIGN_IN_EVENT = "localnotes:sign-in";

export function App(props: AppProps): ReactNode {
  const { store } = props;
  const theme = useTheme();
  const sync = useSyncController();
  const api = useWorkspace(store, {
    ...(props.autosaveDelayMs === undefined ? {} : { autosaveDelayMs: props.autosaveDelayMs }),
  });
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInMode, setSignInMode] = useState<"sign-in" | "sign-up">("sign-in");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  // The status bar asks to open the dialog through an event rather than a prop,
  // which keeps the status bar free of layout state it does not own.
  useEffect(() => {
    const open = (): void => {
      setSignInMode("sign-in");
      setSigningIn(true);
    };
    document.addEventListener(OPEN_SIGN_IN_EVENT, open);
    return () => document.removeEventListener(OPEN_SIGN_IN_EVENT, open);
  }, []);

  // A sync cycle can create conflict copies and pull remote edits, so the tree
  // has to be re-read once a run finishes — otherwise the sidebar would keep
  // showing the state from before the last sync.
  const lastSyncedAt = sync.status.lastSyncedAt;
  const reload = api.reload;
  useEffect(() => {
    if (!lastSyncedAt) return;
    void reload();
  }, [lastSyncedAt, reload]);

  // Expand every notebook once the first tree arrives, so notes are reachable.
  useEffect(() => {
    if (api.status !== "ready") return;
    setExpanded((current) => {
      if (current.size > 0) return current;
      return new Set(api.nodes.filter((node) => node.kind === "notebook").map((node) => node.id));
    });
  }, [api.nodes, api.status]);

  // Reveal the selected item by expanding its ancestors.
  useEffect(() => {
    const id = api.selectedId;
    if (!id) return;
    const ancestors = new Set<string>();
    let cursor = api.nodes.find((node) => node.id === id);
    while (cursor?.parentId) {
      ancestors.add(cursor.parentId);
      cursor = api.nodes.find((node) => node.id === cursor?.parentId);
    }
    if (ancestors.size === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const ancestor of ancestors) {
        if (!next.has(ancestor)) {
          next.add(ancestor);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [api.nodes, api.selectedId]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const download = useCallback(
    (bytes: Uint8Array, filename: string) => {
      if (props.onDownload) {
        props.onDownload(bytes, filename);
        return;
      }
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
    [props],
  );

  const exportNow = useCallback(async () => {
    try {
      const { bytes } = await api.exportBytes();
      const stamp = new Date().toISOString().slice(0, 10);
      download(bytes, `localnotes-${stamp}.zip`);
      api.pushNotice({ kind: "info", message: "Archive exported." });
    } catch (error) {
      api.pushNotice({
        kind: "error",
        message: `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [api, download]);

  const onImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      // Read the FileList *before* clearing the input: assigning `value`
      // empties `files`, so clearing first silently drops the selection.
      const [file] = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (!file) return;
      try {
        await api.importBytes(await readFileBytes(file));
      } catch (error) {
        api.pushNotice({
          kind: "error",
          message: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [api],
  );

  // Keyboard shortcuts. Mod is Ctrl on Linux/Windows and Cmd on macOS.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        void api.createNote(null);
      } else if (key === "n" && event.shiftKey) {
        event.preventDefault();
        void api.createNotebook();
      } else if (key === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (key === "s") {
        event.preventDefault();
        void api.flush();
      } else if (key === "e" && !event.shiftKey) {
        event.preventDefault();
        void exportNow();
      } else if (key === "i" && event.shiftKey) {
        event.preventDefault();
        importRef.current?.click();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [api, exportNow]);

  // Never lose a pending edit when the tab/window closes.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!api.dirty) return;
      void api.flush();
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener?.("beforeunload", onBeforeUnload);
    return () => globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
  }, [api]);

  const deleting = useMemo(
    () => api.nodes.find((node) => node.id === pendingDelete) ?? null,
    [api.nodes, pendingDelete],
  );

  const invalidMoveTargets = useMemo(() => {
    if (!moving) return new Set<string>();
    return new Set(subtreeIds(api.nodes, moving));
  }, [api.nodes, moving]);

  const movingNode = useMemo(
    () => api.nodes.find((node) => node.id === moving) ?? null,
    [api.nodes, moving],
  );

  if (api.status === "loading") {
    return (
      <div className="ln-app ln-loading" role="status" aria-live="polite">
        Opening your local notes…
      </div>
    );
  }

  if (api.status === "failed") {
    return (
      <div className="ln-app ln-fatal" role="alert">
        <h1>Local storage is unavailable</h1>
        <p>{api.fatalError}</p>
        <p>
          Your notes could not be opened. Nothing was deleted — fix storage access and reload, or
          export a backup from another device.
        </p>
      </div>
    );
  }

  return (
    <div className="ln-app">
      <a className="ln-skip-link" href="#ln-main">
        Skip to editor
      </a>
      <Sidebar
        api={api}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
        expandedIds={expanded}
        onToggleExpand={toggleExpand}
        onDelete={setPendingDelete}
        onRequestMove={setMoving}
        searchInputRef={searchRef}
      />

      <main id="ln-main" className="ln-main">
        <EditorPane
          api={api}
          store={store}
          theme={theme.resolved}
          onDelete={setPendingDelete}
          onNewNote={() => void api.createNote(null)}
          onNewNotebook={() => void api.createNotebook()}
        />
      </main>

      <StatusBar
        saveState={api.saveState}
        lastSavedAt={api.lastSavedAt}
        pendingOps={api.pendingOps}
        storage={api.storage}
        sync={sync}
        themeMode={theme.mode}
        onCycleTheme={() => theme.setMode(theme.mode === "light" ? "dark" : theme.mode === "dark" ? "system" : "light")}
        onExport={() => void exportNow()}
        onImport={() => importRef.current?.click()}
        onFlush={() => void api.flush()}
      />

      <input
        ref={importRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        data-testid="import-input"
        onChange={(event) => void onImportFile(event)}
      />

      <NoticeStack notices={api.notices} onDismiss={api.dismissNotice} />

      <AuthDialog
        open={signingIn}
        initialMode={signInMode}
        onSignIn={async (email, password) => {
          await sync.signIn(email, password);
          await api.reload();
        }}
        onSignUp={async (email, password, name) => {
          await sync.signUp(email, password, name);
          await api.reload();
        }}
        onClose={() => setSigningIn(false)}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this item?"
        message={
          deleting
            ? `“${deleting.title}” and everything inside it will be removed from this device. The deletion is recorded so it can be replicated, and it cannot be undone here.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id) void api.remove(id);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {movingNode ? (
        <MoveDialog
          open
          tree={api.tree}
          movingId={movingNode.id}
          invalidIds={invalidMoveTargets}
          onMove={(parentId) => {
            setMoving(null);
            void api.move(movingNode.id, parentId);
          }}
          onCancel={() => setMoving(null)}
        />
      ) : null}
    </div>
  );
}
