import { useCallback, useEffect, useMemo, useState } from "react";
import { parseCanonicalRef, referencedAttachmentIds } from "@localnotes/markdown";
import type { AttachmentResolver } from "@localnotes/editor";
import type { Store } from "@localnotes/shared";

export interface AttachmentUrls {
  /** Attachment reference (as written in Markdown) → `blob:` URL. */
  imageUrls: ReadonlyMap<string, string>;
  /** Resolver for references that are not in the map yet. */
  resolve: AttachmentResolver;
  loading: boolean;
  /** True when at least one referenced attachment has no bytes locally. */
  missing: string[];
}

/**
 * Resolves the attachment references in a note to `blob:` object URLs.
 *
 * URLs are created for the current note only and revoked on cleanup, so
 * switching notes cannot leak memory or show stale bytes for an attachment that
 * was replaced or deleted.
 */
export function useAttachmentUrls(store: Store | null, markdown: string): AttachmentUrls {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const ids = useMemo(() => referencedAttachmentIds(markdown), [markdown]);

  useEffect(() => {
    if (!store || ids.length === 0) {
      setUrls(new Map());
      setMissing([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const created: string[] = [];
    setLoading(true);

    void (async () => {
      const next = new Map<string, string>();
      const absent: string[] = [];
      for (const id of ids) {
        const record = await store.getAttachment(id);
        if (cancelled) break;
        if (!record) {
          absent.push(id);
          continue;
        }
        const blob = new Blob([record.bytes as unknown as BlobPart], { type: record.meta.mime });
        const url = URL.createObjectURL(blob);
        created.push(url);
        next.set(`attachments/${id}.${record.meta.ext}`, url);
        next.set(id, url);
      }
      if (cancelled) {
        for (const url of created) URL.revokeObjectURL(url);
        return;
      }
      setUrls(next);
      setMissing(absent);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [store, ids]);

  const resolve = useCallback<AttachmentResolver>(
    (reference: string) => {
      const direct = urls.get(reference);
      if (direct) return direct;
      const parsed = parseCanonicalRef(reference);
      return parsed ? urls.get(parsed.id) ?? null : null;
    },
    [urls],
  );

  return { imageUrls: urls, resolve, loading, missing };
}
