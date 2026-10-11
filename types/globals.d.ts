/**
 * Ambient globals for packages that compile **without** `lib.dom`.
 *
 * `packages/shared` and `cloudflare/worker` are built for the browser, Node and
 * workerd from one source, so they cannot load the DOM library — doing so would
 * let browser-only APIs (`window`, `FileReader`, `document`) leak into code that
 * has to run inside a Worker. That leaves the handful of genuinely universal
 * globals without a declaration, so they are declared here.
 *
 * This file must contain no top-level `import`/`export`: that would make it a
 * module, and `declare class` would then be module-scoped instead of global.
 */

/** WHATWG Encoding `TextEncoder`, present in browsers, Node and workerd. */
declare class TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}

/** WHATWG Encoding `TextDecoder`, present in browsers, Node and workerd. */
declare class TextDecoder {
  readonly encoding: string;
  decode(input?: Uint8Array): string;
}
