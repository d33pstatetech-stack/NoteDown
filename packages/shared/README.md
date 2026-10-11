# @localnotes/shared

Domain model, invariants and the `Store` facade. No platform APIs: imports
nothing but Web Crypto, `TextEncoder` and standard types, so it runs in the
browser, in Node (tests) and in a Cloudflare Worker.

* `types.ts` — `Node` (notebook | folder | note), `AttachmentMeta`, `QueuedOp`, `Snapshot`.
* `store.ts` — `Store` implements every domain rule on top of the `StoreBackend`
  port: versioning, tombstones, hashing, sibling ordering, queue coalescing,
  conflict preservation, snapshot import/export.
* `tree.ts` / `search.ts` — pure tree and search helpers, independently testable.
* `backend.ts` — the narrow port adapters implement (`readNodes`, `writeNodes`, …).
