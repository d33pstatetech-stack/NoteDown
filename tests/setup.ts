import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { webcrypto } from "node:crypto";

// Node >= 20 exposes Web Crypto as `globalThis.crypto`; jsdom projects do not
// always. The domain layer uses Web Crypto for SHA-256 everywhere.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

afterEach(() => {
  cleanup();
});

// jsdom does not implement geometry APIs that CodeMirror measures with. Stub
// them so the real EditorView can be mounted in component tests.
if (typeof Range !== "undefined" && typeof Range.prototype.getClientRects !== "function") {
  const emptyRectList = () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = function getClientRects() {
    return emptyRectList();
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}
