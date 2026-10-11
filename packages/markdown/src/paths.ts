import { ImportError } from "@localnotes/shared";

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_ENTRY_PATH_LENGTH = 1024;

/**
 * Normalizes an archive entry path and refuses anything that could escape the
 * extraction root. Rejected, never silently repaired: a bad archive is a
 * security event, not something to guess about.
 *
 * Rejected shapes: absolute paths, Windows drive letters, UNC prefixes,
 * backslashes, `.`/`..` segments, NUL and other control characters, empty
 * segments, trailing slashes, reserved device names and over-long paths.
 */
export function normalizeArchivePath(input: string): string {
  if (input.length === 0) throw new ImportError("Archive contains an entry with an empty path");
  if (input.length > MAX_ENTRY_PATH_LENGTH) {
    throw new ImportError(`Archive entry path is too long (${input.length} characters)`);
  }
  if (input.includes("\u0000")) throw new ImportError("Archive entry path contains a NUL byte");
  if (input.includes("\\")) {
    throw new ImportError(`Archive entry path contains a backslash: ${input}`);
  }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.startsWith("//")) {
    throw new ImportError(`Archive entry path is absolute: ${input}`);
  }
  const segments = input.split("/");
  for (const segment of segments) {
    if (segment.length === 0) throw new ImportError(`Archive entry path has an empty segment: ${input}`);
    if (segment === "." || segment === "..") {
      throw new ImportError(`Archive entry path escapes the archive root: ${input}`);
    }
    for (const char of segment) {
      const code = char.charCodeAt(0);
      if (code < 32 || code === 127) {
        throw new ImportError(`Archive entry path contains a control character: ${input}`);
      }
    }
  }
  return segments.join("/");
}

export function splitSegments(path: string): string[] {
  return path.length === 0 ? [] : path.split("/").filter((segment) => segment.length > 0);
}

export function dirname(path: string): string {
  const segments = splitSegments(path);
  segments.pop();
  return segments.join("/");
}

export function basename(path: string): string {
  const segments = splitSegments(path);
  return segments[segments.length - 1] ?? "";
}

export function joinPath(...parts: string[]): string {
  return parts.flatMap((part) => splitSegments(part)).join("/");
}

/** Path of `target` as seen from the directory `fromDir` (both archive-relative). */
export function relativeFromDirectory(fromDir: string, target: string): string {
  const from = splitSegments(fromDir);
  const to = splitSegments(target);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  const up = new Array<string>(from.length - shared).fill("..");
  const down = to.slice(shared);
  const result = [...up, ...down].join("/");
  return result.length === 0 ? basename(target) : result;
}

/**
 * Resolves a (possibly relative) Markdown reference against the directory of
 * the referring file and returns an archive-root-relative path, or `null` when
 * the reference is external (http, data:, mailto:, blob:, absolute).
 */
export function resolveReference(noteDir: string, reference: string): string | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // scheme: http:, data:, mailto:
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return null;

  const decoded = decodeUriSafely(trimmed.split("#")[0]?.split("?")[0] ?? "");
  if (decoded.length === 0) return null;
  const base = splitSegments(noteDir);
  const stack = [...base];
  for (const segment of decoded.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null; // would escape the archive root
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

function decodeUriSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Appends `-2`, `-3`, … until the path is unique. Used so two notes with the
 * same title never collapse into one file on export.
 */
export function uniquePath(path: string, taken: ReadonlySet<string>): string {
  if (!taken.has(path)) return path;
  const dir = dirname(path);
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = joinPath(dir, `${stem}-${index}${ext}`);
    if (!taken.has(candidate)) return candidate;
  }
  throw new ImportError(`Could not find a unique path for ${path}`);
}

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.test(name);
}
