import { describe, expect, it } from "vitest";
import { contentHash, sha256Hex, toHex } from "./hash";

describe("hashing", () => {
  it("matches the published SHA-256 test vectors", async () => {
    // FIPS 180-4 / RFC 6234 vectors; the Rust core asserts the same values.
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("treats text and its UTF-8 bytes identically", async () => {
    const text = "héllo → 世界";
    expect(await contentHash(text)).toBe(await sha256Hex(new TextEncoder().encode(text)));
  });

  it("hex-encodes low and high nibbles with padding", () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xf0, 0xff]))).toBe("000ff0ff");
  });
});
