import { zipSync, strToU8 } from "fflate";
import { safeFilename } from "@localnotes/shared";
import type { AttachmentMeta, Node, Store } from "@localnotes/shared";
import { canonicalRef, rewriteForExport } from "./refs";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  METADATA_PATH,
  NOTEBOOKS_DIR,
  README_PATH,
  readmeText,
  frontMatter,
  type ArchiveAttachmentEntry,
  type ArchiveMetadata,
  type ArchiveNodeEntry,
} from "./format";
import { joinPath, relativeFromDirectory, uniquePath } from "./paths";

export type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface ExportOptions {
  /** Compression level for `fflate` (0–9). Defaults to 6. */
  level?: ZipLevel;
  /** Write the `.localnotes/metadata.json` sidecar (default: true). */
  includeMetadata?: boolean;
  now?: () => Date;
}

export interface ExportResult {
  bytes: Uint8Array;
  files: string[];
  /** Node id → archive path. Handy for tests and for a "where did it go" preview. */
  nodePathById: Record<string, string>;
  noteCount: number;
  attachmentCount: number;
  warnings: string[];
}

export const GENERATOR = "localnotes/0.1.0";

/**
 * Builds a portable ZIP archive from the local store.
 *
 * - `notebooks/<notebook>/<folder>/<note>.md`, one file per note, titled by path.
 * - `attachments/<attachment-id>.<ext>`, referenced with paths relative to the
 *   note file so the archive works in any Markdown viewer.
 * - `.localnotes/metadata.json`, the optional sidecar with stable ids and
 *   parent relationships used to restore the hierarchy on import.
 *
 * Nothing machine-specific (absolute paths, object URLs, database ids of the
 * host) is written into the Markdown.
 */
export async function exportArchive(
  store: Store,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const now = options.now ?? (() => new Date());
  const includeMetadata = options.includeMetadata ?? true;
  const warnings: string[] = [];

  const nodes = await store.listNodes();
  const notebooks = nodes.filter((node) => node.kind === "notebook");
  const generatedAt = now().toISOString();

  // ── assign archive paths, resolving title collisions deterministically ──
  const taken = new Set<string>();
  const pathById = new Map<string, string>();

  const assign = (node: Node, parentDir: string): void => {
    const isNote = node.kind === "note";
    const filename = safeFilename(node.title, isNote ? "md" : "");
    const candidate = joinPath(parentDir, filename);
    const path = uniquePath(candidate, taken);
    taken.add(path);
    pathById.set(node.id, path);
    if (isNote) return;
    for (const child of nodes.filter((candidate) => candidate.parentId === node.id)) {
      assign(child, path);
    }
  };

  for (const notebook of notebooks) {
    const dir = joinPath(NOTEBOOKS_DIR, safeFilename(notebook.title, ""));
    const path = uniquePath(dir, taken);
    taken.add(path);
    pathById.set(notebook.id, path);
    for (const child of nodes.filter((node) => node.parentId === notebook.id)) {
      assign(child, path);
    }
  }

  const noteNodes = nodes.filter((node) => node.kind === "note");
  for (const orphan of noteNodes.filter((node) => !pathById.has(node.id))) {
    // A note whose notebook is missing from the snapshot still must not be lost.
    const path = uniquePath(joinPath(NOTEBOOKS_DIR, "Recovered", `${safeFilename(orphan.title, "md")}`), taken);
    taken.add(path);
    pathById.set(orphan.id, path);
    warnings.push(`Note ${orphan.id} had no notebook and was exported under ${NOTEBOOKS_DIR}/Recovered/`);
  }

  // ── attachments ────────────────────────────────────────────────────────
  const attachments = await store.listAttachments();
  const files: Record<string, Uint8Array> = {};
  const attachmentPathById = new Map<string, string>();
  const attachmentEntries: ArchiveAttachmentEntry[] = [];
  const resolvedAttachments = new Map<string, AttachmentMeta>();

  for (const meta of attachments) {
    const record = await store.getAttachment(meta.id);
    if (!record) {
      warnings.push(`Attachment ${meta.id} (${meta.filename}) is missing its bytes; reference left as-is`);
      continue;
    }
    const path = canonicalRef(meta);
    attachmentPathById.set(meta.id, path);
    resolvedAttachments.set(meta.id, meta);
    attachmentEntries.push({
      id: meta.id,
      noteId: meta.noteId,
      path,
      filename: meta.filename,
      mime: meta.mime,
      ext: meta.ext,
      size: meta.size,
      sha256: meta.sha256,
    });
  }

  // ── notes ──────────────────────────────────────────────────────────────
  const nodeEntries: ArchiveNodeEntry[] = [];
  for (const node of nodes) {
    const path = pathById.get(node.id) ?? null;
    if (node.kind === "note" && path) {
      const { markdown, missing } = rewriteForExport(node.content, path, attachmentPathById);
      for (const ref of missing) {
        warnings.push(`Note "${node.title}" references ${ref}, whose bytes are not available`);
      }
      files[path] = strToU8(
        frontMatter({
          title: node.title,
          id: node.id,
          created: node.createdAt,
          updated: node.updatedAt,
        }) + markdown,
      );
    }
    nodeEntries.push({
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      title: node.title,
      path,
      position: node.position,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      contentHash: node.contentHash,
      syncState: node.syncState,
    });
  }

  for (const entry of attachmentEntries) {
    const record = resolvedAttachments.get(entry.id);
    if (!record) continue;
    const read = await store.getAttachment(entry.id);
    if (read) files[entry.path] = read.bytes;
  }

  const metadata: ArchiveMetadata = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    generator: GENERATOR,
    exportedAt: generatedAt,
    checkpoint: await store.getCheckpoint(),
    nodes: nodeEntries,
    attachments: attachmentEntries,
  };

  files[README_PATH] = strToU8(readmeText(metadata));
  if (includeMetadata) files[METADATA_PATH] = strToU8(`${JSON.stringify(metadata, null, 2)}\n`);

  const sorted: Record<string, Uint8Array> = {};
  for (const key of Object.keys(files).sort()) {
    sorted[key] = files[key] as Uint8Array;
  }

  return {
    bytes: zipSync(sorted, { level: options.level ?? 6 }),
    files: Object.keys(sorted),
    nodePathById: Object.fromEntries(pathById),
    noteCount: Object.keys(sorted).filter((path) => path.endsWith(".md")).length,
    attachmentCount: attachmentEntries.length,
    warnings,
  };
}

/** Exported for tests and for the UI's "show me where it will land" preview. */
export function attachmentExportPath(meta: AttachmentMeta): string {
  return canonicalRef(meta);
}

export { relativeFromDirectory };
