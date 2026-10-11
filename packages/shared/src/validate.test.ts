import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors";
import {
  LIMITS,
  extForMime,
  safeFilename,
  sniffImageMime,
  validateAttachment,
  validateContent,
  validateTitle,
} from "./validate";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe("image sniffing", () => {
  it("detects supported types from magic numbers, not from a client header", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
    expect(sniffImageMime(svg)).toBe("image/svg+xml");
  });

  it("refuses content that is not on the allow-list", () => {
    expect(sniffImageMime(new TextEncoder().encode("not an image"))).toBeNull();
    expect(() => validateAttachment(new Uint8Array([1, 2, 3, 4]))).toThrow(ValidationError);
    expect(() => validateAttachment(new Uint8Array(0))).toThrow(/empty/i);
  });

  it("rejects attachments over the documented size limit", () => {
    const tooBig = new Uint8Array(LIMITS.attachmentBytes + 1);
    tooBig.set(png.subarray(0, png.length));
    expect(() => validateAttachment(tooBig)).toThrow(/exceeds/i);
  });

  it("maps MIME types to canonical extensions", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("application/pdf")).toBeNull();
  });
});

describe("filenames", () => {
  it("strips path traversal, separators and control characters", () => {
    expect(safeFilename("../../etc/passwd", "png")).toBe("etc-passwd.png");
    expect(safeFilename("..\\..\\windows\\system32", "png")).toBe("windows-system32.png");
    expect(safeFilename("a\u0000b.png", "png")).toBe("a-b.png");
    expect(safeFilename('bad<>:"|?*name.png', "png")).toBe("bad-name.png");
  });

  it("avoids Windows reserved device names and keeps an extension", () => {
    expect(safeFilename("CON", "png")).toBe("_CON.png");
    expect(safeFilename("diagram", "png")).toBe("diagram.png");
    expect(safeFilename("already.jpg", "png")).toBe("already.jpg");
    expect(safeFilename("   ", "png")).toBe("untitled.png");
  });

  it("caps very long names", () => {
    const long = "x".repeat(400);
    expect(safeFilename(long, "png").length).toBeLessThanOrEqual(124);
  });
});

describe("titles and content", () => {
  it("collapses whitespace and rejects empties", () => {
    expect(validateTitle("  My   note  ")).toBe("My note");
    expect(() => validateTitle("   ")).toThrow(ValidationError);
  });

  it("caps title length", () => {
    expect(() => validateTitle("t".repeat(LIMITS.titleChars + 1))).toThrow(/characters/);
  });

  it("measures content in UTF-8 bytes", () => {
    expect(validateContent("ok")).toBe("ok");
    const big = "é".repeat(LIMITS.contentBytes / 2 + 1);
    expect(() => validateContent(big)).toThrow(/exceeds/i);
  });
});
