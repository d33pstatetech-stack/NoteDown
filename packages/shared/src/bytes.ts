import { getFileReaderConstructor } from "./platform";

/** Base64 helpers used for IPC transports that only carry JSON (Tauri). */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += B64.charAt(b0 >> 2);
    out += B64.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    out += i + 1 < bytes.length ? B64.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : "=";
    out += i + 2 < bytes.length ? B64.charAt(b2 & 0x3f) : "=";
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean.charAt(i));
    const c1 = B64.indexOf(clean.charAt(i + 1));
    const c2 = B64.indexOf(clean.charAt(i + 2));
    const c3 = B64.indexOf(clean.charAt(i + 3));
    if (c0 < 0 || c1 < 0) break;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0 && o < out.length) out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 >= 0 && o < out.length) out[o++] = ((c2 & 0x03) << 6) | c3;
  }
  return out.subarray(0, o);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a picked or dropped file into bytes.
 *
 * `Blob.arrayBuffer()` is the modern path, but it is missing in some older
 * engines (and in jsdom), so `FileReader` is the fallback rather than a hard
 * requirement. Nothing here trusts the file's name or declared type.
 */
export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  const modern = (file as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (typeof modern === "function") {
    try {
      return new Uint8Array(await modern.call(file));
    } catch {
      // fall through to FileReader
    }
  }
  const FileReaderImpl = getFileReaderConstructor();
  if (!FileReaderImpl) {
    throw new Error("This runtime can neither use Blob#arrayBuffer nor FileReader");
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReaderImpl();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error("The file could not be read as binary data"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read"));
    reader.readAsArrayBuffer(file);
  });
}
