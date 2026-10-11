import { MemoryBackend } from "./memory";
import { IndexedDbBackend } from "./indexeddb";
import { TauriBackend, type InvokeFn } from "./tauri";
import type { StoreBackend } from "@localnotes/shared";

export interface SelectBackendOptions {
  /** Injected by tests; defaults to the global. */
  tauriInvoke?: InvokeFn;
  indexedDbFactory?: IDBFactory;
  databaseName?: string;
}

/**
 * Picks the right adapter for the current shell: Tauri when the native bridge
 * is present, IndexedDB in a browser, and in-memory otherwise. The desktop app
 * never needs the hosted site to be online — this only chooses *local* storage.
 */
export function selectBackend(options: SelectBackendOptions = {}): StoreBackend {
  const invoke = options.tauriInvoke ?? detectTauriInvoke();
  if (invoke) return new TauriBackend(invoke);

  const factory = options.indexedDbFactory ?? globalThis.indexedDB;
  if (factory) {
    return new IndexedDbBackend({
      factory,
      ...(options.databaseName === undefined ? {} : { databaseName: options.databaseName }),
    });
  }
  return new MemoryBackend({ persistent: false, location: "memory (no persistent storage)" });
}

function detectTauriInvoke(): InvokeFn | null {
  const w = globalThis as unknown as {
    __TAURI_INTERNALS__?: { invoke?: InvokeFn };
    __TAURI__?: { core?: { invoke?: InvokeFn } };
  };
  const direct = w.__TAURI_INTERNALS__?.invoke;
  if (typeof direct === "function") return direct;
  const core = w.__TAURI__?.core?.invoke;
  return typeof core === "function" ? core : null;
}
