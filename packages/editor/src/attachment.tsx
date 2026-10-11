import { createContext, useContext, type ReactNode } from "react";
import { parseCanonicalRef } from "@localnotes/markdown";
import { basename, dirname, resolveReference } from "@localnotes/markdown";

/** Returns a displayable URL (`blob:`, `data:`) for an attachment reference. */
export type AttachmentResolver = (reference: string) => string | null;

const AttachmentContext = createContext<AttachmentResolver | null>(null);

export function AttachmentProvider(props: {
  resolver: AttachmentResolver;
  children: ReactNode;
}): ReactNode {
  return (
    <AttachmentContext.Provider value={props.resolver}>{props.children}</AttachmentContext.Provider>
  );
}

export function useAttachmentResolver(): AttachmentResolver | null {
  return useContext(AttachmentContext);
}

const PROTOCOL_RE = /^([a-z][a-z0-9+.-]*):/i;
const DISPLAYABLE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * True only for references the browser can legitimately display. `file:`,
 * `blob:`, `javascript:` and friends are **not** displayable: they either point
 * at the local filesystem, are stale object URLs from another session, or are
 * an injection attempt, so they fall through to the "image not available"
 * placeholder instead of being rendered.
 */
export function isExternalReference(reference: string): boolean {
  const trimmed = reference.trim();
  if (trimmed.startsWith("//")) return true;
  const match = PROTOCOL_RE.exec(trimmed);
  if (!match) return false;
  const scheme = `${(match[1] ?? "").toLowerCase()}:`;
  if (scheme === "data:") return trimmed.toLowerCase().startsWith("data:image/");
  return DISPLAYABLE_SCHEMES.has(scheme);
}

/**
 * Decides what the preview should point an image at. Pure so it can be tested
 * without a DOM, and deliberately conservative: an unresolvable attachment
 * yields `null` (the preview renders "image not available") instead of a broken
 * `<img>` or a leaked filesystem path.
 */
export function resolveImageSource(
  reference: string,
  options: {
    imageUrls?: ReadonlyMap<string, string>;
    resolver?: AttachmentResolver;
    notePath?: string;
  } = {},
): string | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;

  const canonical = parseCanonicalRef(trimmed);
  if (canonical) {
    const direct = options.imageUrls?.get(trimmed);
    if (direct) return direct;
    const resolved = options.resolver?.(trimmed);
    return resolved ?? null;
  }

  if (isExternalReference(trimmed)) return trimmed;

  // A relative path (for example a note imported from an archive that has not
  // been re-linked yet): resolve it against the note and try again.
  if (options.notePath) {
    const absolute = resolveReference(dirname(options.notePath), trimmed);
    if (absolute) {
      const byPath = options.imageUrls?.get(absolute);
      if (byPath) return byPath;
      const resolved = options.resolver?.(absolute);
      if (resolved) return resolved;
    }
  }

  const byName = options.imageUrls?.get(basename(trimmed));
  if (byName) return byName;
  return options.resolver?.(trimmed) ?? null;
}
