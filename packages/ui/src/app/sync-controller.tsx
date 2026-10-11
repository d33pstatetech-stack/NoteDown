import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AuthClient, Account } from "@localnotes/sync";
import type { SyncStatusSnapshot } from "@localnotes/sync";
import type { SyncEngine } from "@localnotes/sync";

export type { Account };

/**
 * Everything the shell needs to expose about cloud sync, behind one object so
 * the UI never has to know whether sync is configured at all.
 */
export interface SyncController {
  status: SyncStatusSnapshot;
  subscribe(listener: (status: SyncStatusSnapshot) => void): () => void;
  /** Runs a cycle now, bypassing any backoff. */
  syncNow(): Promise<void>;
  account: Account | null;
  authState: "unknown" | "signed-out" | "signed-in" | "checking";
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, name: string): Promise<void>;
  signOut(): Promise<void>;
  /** True when no sync client is configured at all (fully local install). */
  readonly unavailable: boolean;
}

/**
 * A controller for an installation with no backend (an air-gapped desktop build,
 * or a deployment without an API URL). It keeps the whole UI working and simply
 * reports that sync is not available, instead of making every component
 * null-check a client it may never receive.
 */
export const DISABLED_SYNC_CONTROLLER: SyncController = {
  status: { state: "disabled", pending: 0, lastSyncedAt: null, error: null, conflicts: 0 },
  subscribe: () => () => undefined,
  syncNow: async () => undefined,
  account: null,
  authState: "signed-out",
  signIn: async () => undefined,
  signUp: async () => undefined,
  signOut: async () => undefined,
  unavailable: true,
};

const SyncControllerContext = createContext<SyncController>(DISABLED_SYNC_CONTROLLER);

export interface SyncControllerProviderProps {
  engine: SyncEngine | null;
  auth: AuthClient | null;
  children: ReactNode;
  /** Called after any state change so the shell can persist the account id. */
  onAccountChange?: (account: Account | null) => void;
}

/**
 * Bridges the imperative `SyncEngine` to React.
 *
 * The engine has its own listener set and no knowledge of React; this subscribes
 * once, mirrors the snapshot into state, and restores the session on mount. It
 * is deliberately the *only* place that knows a sync engine exists, so the rest
 * of the UI just reads a controller.
 */
export function SyncControllerProvider(props: SyncControllerProviderProps): ReactNode {
  const { engine, auth, children, onAccountChange } = props;
  const [status, setStatus] = useState<SyncStatusSnapshot>(
    engine ? engine.status() : DISABLED_SYNC_CONTROLLER.status,
  );
  const [account, setAccount] = useState<Account | null>(null);
  const [authState, setAuthState] = useState<SyncController["authState"]>(
    auth ? "checking" : "signed-out",
  );

  // Mirror engine status into React state. Subscribing in an effect (rather than
  // during render) is what guarantees the listener is registered exactly once
  // and torn down on unmount, instead of leaking on every re-render.
  useEffect(() => {
    if (!engine) return undefined;
    setStatus(engine.status());
    return engine.subscribe(setStatus);
  }, [engine]);

  // Restore the session once, on mount (and whenever the auth client changes).
  const [restoredFor, setRestoredFor] = useState<AuthClient | null>(null);
  if (auth && restoredFor !== auth) {
    setRestoredFor(auth);
    setAuthState("checking");
    void (async () => {
      try {
        const existing = await auth.currentUser();
        setAccount(existing);
        setAuthState(existing ? "signed-in" : "signed-out");
      } catch {
        // A failed restore is indistinguishable from being signed out as far as
        // the user is concerned, and the app stays fully usable offline.
        setAccount(null);
        setAuthState("signed-out");
      }
    })();
  }

  const adopt = useCallback(
    (next: Account | null) => {
      setAccount(next);
      setAuthState(next ? "signed-in" : "signed-out");
      onAccountChange?.(next);
    },
    [onAccountChange],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!auth) return;
      const next = await auth.signIn(email, password);
      adopt(next);
      // Signing in is the moment a device should pull everything it is missing.
      await engine?.run();
    },
    [adopt, auth, engine],
  );

  const signUp = useCallback(
    async (email: string, password: string, name: string) => {
      if (!auth) return;
      const next = await auth.signUp(email, password, name);
      adopt(next);
      await engine?.run();
    },
    [adopt, auth, engine],
  );

  const signOut = useCallback(async () => {
    if (!auth) return;
    await auth.signOut();
    adopt(null);
  }, [adopt, auth]);

  const syncNow = useCallback(async () => {
    await engine?.run();
  }, [engine]);

  const unavailable = !engine || !auth;
  const controller = useMemo<SyncController>(
    () => ({
      status: engine ? status : DISABLED_SYNC_CONTROLLER.status,
      subscribe: engine ? engine.subscribe.bind(engine) : () => () => undefined,
      syncNow,
      account,
      authState,
      signIn,
      signUp,
      signOut,
      unavailable,
    }),
    [account, authState, engine, signIn, signOut, signUp, status, syncNow, unavailable],
  );

  return <SyncControllerContext.Provider value={controller}>{children}</SyncControllerContext.Provider>;
}

export function useSyncController(): SyncController {
  return useContext(SyncControllerContext);
}
