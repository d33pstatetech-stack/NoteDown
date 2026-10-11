/**
 * Vite's `?raw` suffix inlines a file as a string at build time. The Worker
 * schema test relies on it because those tests execute inside workerd, which has
 * no filesystem to read from.
 *
 * This file must stay a *script* (no top-level `import`/`export`): wildcard
 * module declarations are only honoured in ambient context.
 */
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
