import { ValidationError } from "./errors";

export const LIMITS = {
  /** Characters in a node title. */
  titleChars: 512,
  /** Bytes of Markdown in one note (D1 row + R2 object friendly). */
  contentBytes: 2 * 1024 * 1024,
  /** Bytes of one attachment (matches the documented server-side limit). */
  attachmentBytes: 5 * 1024 * 1024,
  /** Total attachment bytes allowed in one local store. */
  attachmentTotalBytes: 512 * 1024 * 1024,
} as const;

export type ImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/avif"
  | "image/bmp"
  | "image/svg+xml";

const MIME_EXT: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export const ALLOWED_IMAGE_MIMES = Object.keys(MIME_EXT) as ImageMime[];

export function extForMime(mime: string): string | null {
  const entry = Object.entries(MIME_EXT).find(([key]) => key === mime);
  return entry ? entry[1] : null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function containsAscii(bytes: Uint8Array, needle: string, limit = 1024): boolean {
  const slice = bytes.subarray(0, Math.min(bytes.length, limit));
  let text = "";
  for (const byte of slice) text += String.fromCharCode(byte);
  return text.includes(needle);
}

/**
 * Determines the MIME type from the bytes themselves. A client-supplied
 * `Content-Type` or filename is never trusted for storage decisions.
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && containsAscii(bytes.subarray(8, 12), "WEBP", 4))
    return "image/webp";
  if (containsAscii(bytes, "ftypavif", 16) || containsAscii(bytes, "ftypavis", 16)) return "image/avif";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  const looksLikeSvg =
    containsAscii(bytes, "<svg", 4096) &&
    (containsAscii(bytes, "xml", 256) || startsWith(bytes, [0x3c, 0x73, 0x76, 0x67]));
  if (looksLikeSvg) return "image/svg+xml";
  return null;
}

export function validateTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) throw new ValidationError("Title cannot be empty");
  if (trimmed.length > LIMITS.titleChars) {
    throw new ValidationError(`Title exceeds ${LIMITS.titleChars} characters`);
  }
  return trimmed;
}

export function validateContent(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > LIMITS.contentBytes) {
    throw new ValidationError(`Note exceeds ${Math.round(LIMITS.contentBytes / 1024)} KiB`, {
      bytes,
    });
  }
  return content;
}

export function validateAttachment(bytes: Uint8Array): ImageMime {
  if (bytes.length === 0) throw new ValidationError("Attachment is empty");
  if (bytes.length > LIMITS.attachmentBytes) {
    throw new ValidationError(
      `Attachment exceeds ${Math.round(LIMITS.attachmentBytes / 1024 / 1024)} MiB`,
      { bytes: bytes.length },
    );
  }
  const mime = sniffImageMime(bytes);
  if (!mime) {
    throw new ValidationError("Unsupported image type (allowed: png, jpeg, gif, webp, avif, bmp, svg)");
  }
  return mime;
}

/**
 * Produces a display/export filename that cannot escape a directory, cannot be
 * a reserved Windows device name, and keeps its extension.
 */
export function safeFilename(name: string, fallbackExt: string): string {
  // Drop empty, "." and ".." segments so nothing can escape a directory, then
  // flatten the remaining segments into one name. Filenames are display/export
  // only: storage keys are always the attachment's UUID.
  const segments = name
    .normalize("NFC")
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  let base = segments.join("-");
  base = Array.from(base)
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? "-" : char))
    .join("");
  base = base.replace(/^[.\s]+/, "").replace(/[<>:"|?*]/g, "-");
  base = base.replace(/\.{2,}/g, ".").replace(/\s+/g, " ").replace(/-+/g, "-").trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  let safe = base.length > 0 ? base : "untitled";
  if (reserved.test(safe)) safe = `_${safe}`;
  if (safe.length > 120) safe = safe.slice(0, 120).trim();
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(safe);
  if (hasExt || fallbackExt.length === 0) return safe;
  return `${safe}.${fallbackExt}`;
}
