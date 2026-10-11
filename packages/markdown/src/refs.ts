import { extForMime } from "@localnotes/shared";
import type { AttachmentMeta } from "@localnotes/shared";
import { basename, dirname, relativeFromDirectory, resolveReference, splitSegments } from "./paths";

export const ATTACHMENTS_DIR = "attachments";

export interface ParsedReference {
  id: string;
  ext: string;
}

/**
 * The portable attachment reference scheme. This is the *only* form stored in
 * Markdown that the app writes: a relative `attachments/` path keyed by the
 * attachment's stable UUID. Machine-specific absolute paths and `blob:` URLs are
 * never persisted, which is what makes an archive portable across devices.
 */
export function canonicalRef(meta: Pick<AttachmentMeta, "id" | "ext">): string {
  return `${ATTACHMENTS_DIR}/${meta.id}.${meta.ext}`;
}

export function canonicalRefFromMime(id: string, mime: string): string {
  const ext = extForMime(mime) ?? "bin";
  return `${ATTACHMENTS_DIR}/${id}.${ext}`;
}

export function parseCanonicalRef(reference: string): ParsedReference | null {
  const segments = splitSegments(reference);
  if (segments.length !== 2) return null;
  if (segments[0] !== ATTACHMENTS_DIR) return null;
  const file = segments[1] ?? "";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = file.slice(0, dot);
  const ext = file.slice(dot + 1);
  if (id.length === 0 || ext.length === 0) return null;
  return { id, ext };
}

/**
 * One combined pass over images, links and inline HTML `<img>` tags. A single
 * pass matters: running the image pattern and then the link pattern would visit
 * an already-rewritten image target a second time and rewrite it again.
 *
 * Groups: 1/3 wrap a Markdown target, 4/6 wrap an HTML `src`. (A regex-based
 * rewriter does not try to model fenced code blocks or escaped brackets; those
 * targets are left alone, which is the safe direction for a rewrite.)
 */
const TARGET_RE =
  /(!?\[[^\]]*\]\()\s*([^)\s]+)(\s*(?:"[^"]*")?\s*\))|(<img\b[^>]*?\bsrc\s*=\s*")([^"]*)(")/gi;

/**
 * Rewrites Markdown references. `map` is called once per candidate target and
 * returns the replacement (or `null`/`undefined` to leave it alone), so callers
 * never need to reconstruct the surrounding syntax.
 */
export function rewriteReferences(
  markdown: string,
  map: (target: string) => string | null | undefined,
): string {
  const apply = (target: string): string => map(target) ?? target;
  return markdown.replace(
    TARGET_RE,
    (
      match: string,
      markdownOpen: string | undefined,
      markdownTarget: string | undefined,
      markdownClose: string | undefined,
      htmlOpen: string | undefined,
      htmlTarget: string | undefined,
      htmlClose: string | undefined,
    ) => {
      if (markdownOpen !== undefined && markdownTarget !== undefined && markdownClose !== undefined) {
        return `${markdownOpen}${apply(markdownTarget)}${markdownClose}`;
      }
      if (htmlOpen !== undefined && htmlTarget !== undefined && htmlClose !== undefined) {
        return `${htmlOpen}${apply(htmlTarget)}${htmlClose}`;
      }
      return match;
    },
  );
}

/**
 * Export direction: rewrite `attachments/<id>.<ext>` into a path relative to the
 * exported note, so the archive works when opened with any Markdown viewer.
 */
export function rewriteForExport(
  markdown: string,
  noteArchivePath: string,
  attachmentPathById?: ReadonlyMap<string, string>,
): { markdown: string; missing: string[] } {
  const noteDir = dirname(noteArchivePath);
  const missing: string[] = [];
  const rewritten = rewriteReferences(markdown, (target) => {
    const parsed = parseCanonicalRef(target);
    if (!parsed) return null;
    const attachmentPath = attachmentPathById
      ? attachmentPathById.get(parsed.id)
      : `${ATTACHMENTS_DIR}/${parsed.id}.${parsed.ext}`;
    if (!attachmentPath) {
      missing.push(target);
      return null;
    }
    return relativeFromDirectory(noteDir, attachmentPath);
  });
  return { markdown: rewritten, missing: [...new Set(missing)] };
}

/**
 * Import direction: resolve each reference against the note's directory inside
 * the archive and turn it into the canonical portable form.
 *
 * `attachmentRef` maps a resolved archive path (plus its filename) to the final
 * canonical reference, which is how an archive whose files are not named after
 * UUIDs gets correct references after new ids are assigned. Returning
 * `undefined` keeps the resolved path; returning `null` leaves the original text
 * untouched (external URLs, unrelated links).
 */
export function rewriteForImport(
  markdown: string,
  noteArchivePath: string,
  options: {
    attachmentRef?: (resolvedPath: string, filename: string) => string | null | undefined;
  } = {},
): { markdown: string; referenced: string[] } {
  const noteDir = dirname(noteArchivePath);
  const referenced: string[] = [];
  const rewritten = rewriteReferences(markdown, (target) => {
    const resolved = resolveReference(noteDir, target);
    if (!resolved) return null;
    const mapped = options.attachmentRef?.(resolved, basename(resolved));
    if (mapped !== undefined) {
      if (mapped === null) return null;
      referenced.push(resolved);
      return mapped;
    }
    if (resolved.startsWith(`${ATTACHMENTS_DIR}/`)) {
      referenced.push(resolved);
      return resolved;
    }
    return null;
  });
  return { markdown: rewritten, referenced };
}

/** All candidate reference targets found in a Markdown document, in order. */
export function extractReferences(markdown: string): string[] {
  const found: string[] = [];
  const visit = (target: string): null => {
    found.push(target);
    return null;
  };
  rewriteReferences(markdown, visit);
  return [...new Set(found)];
}

/** Canonical attachment ids referenced by a Markdown document. */
export function referencedAttachmentIds(markdown: string): string[] {
  const ids = extractReferences(markdown)
    .map((target) => parseCanonicalRef(target)?.id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)];
}
