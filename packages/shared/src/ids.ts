/**
 * Stable identifiers. Every notebook, folder, note and attachment gets a UUID
 * that is never derived from a title or a path, so rename/move operations
 * preserve identity and sync history.
 */
import { getCrypto } from "./platform";

export function newId(): string {
  const c = getCrypto();
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    return formatUuid(bytes);
  }
  throw new Error("No cryptographically secure random source available");
}

function formatUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Deterministic, filesystem-safe key derived from an id (never from a title). */
export function shortId(id: string): string {
  const compact = id.replace(/-/g, "");
  return compact.slice(0, 12);
}
