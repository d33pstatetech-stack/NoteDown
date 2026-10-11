import "fake-indexeddb/auto";
import { describeBackend } from "./backend-contract";
import { IndexedDbBackend, MemoryBackend } from "@localnotes/storage";
import type { StoreBackend } from "@localnotes/shared";

describeBackend("memory", async () => new MemoryBackend());

let dbCounter = 0;
describeBackend("indexeddb (fake-indexeddb)", async () => {
  dbCounter += 1;
  const backend: StoreBackend = new IndexedDbBackend({
    factory: globalThis.indexedDB,
    databaseName: `localnotes-test-${dbCounter}`,
  });
  return backend;
});
