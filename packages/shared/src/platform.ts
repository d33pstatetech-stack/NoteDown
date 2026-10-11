/**
 * Minimal structural views of the few host globals this package needs.
 *
 * The shared layer is compiled (or type-checked) with **no DOM lib**: the same
 * source has to satisfy a browser build, Node tests and a Cloudflare Worker, and
 * pulling in `lib.dom` would let code accidentally depend on a browser-only API
 * such as `FileReader` in a Worker. Declaring only the shapes actually used
 * keeps that boundary honest and explicit.
 */

export interface SubtleCryptoLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

export interface CryptoLike {
  subtle?: SubtleCryptoLike;
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

export interface FileReaderLike {
  result: unknown;
  error: unknown;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  readAsArrayBuffer(blob: unknown): void;
}

export function getCrypto(): CryptoLike | undefined {
  return (globalThis as unknown as { crypto?: CryptoLike }).crypto;
}

export function getFileReaderConstructor(): (new () => FileReaderLike) | undefined {
  return (globalThis as unknown as { FileReader?: new () => FileReaderLike }).FileReader;
}
