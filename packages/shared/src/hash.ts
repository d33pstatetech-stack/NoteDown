import { getCrypto } from "./platform";

const encoder = new TextEncoder();

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0x0f];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/**
 * SHA-256 as lowercase hex. Uses Web Crypto, which is available in browsers,
 * Node >= 20, and Cloudflare Workers, so local and server hashes agree. The
 * desktop SQLite core computes the same digest with the `sha2` crate.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const subtle = getCrypto()?.subtle;
  if (!subtle) {
    throw new Error("SHA-256 is unavailable: Web Crypto is not present in this runtime");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export async function contentHash(content: string): Promise<string> {
  return sha256Hex(content);
}
