import { unzipSync } from "fflate";
import {
  ImportError,
  ValidationError,
  contentHash,
  extForMime,
  isUuid,
  newId,
  safeFilename,
  sha256Hex,
  validateAttachment,
} from "@localnotes/shared";
import type {
  AttachmentMeta,
  Node,
  NodeKind,
  Snapshot,
  Store,
} from "@localnotes/shared";
import { canonicalRefFromMime, rewriteForImport } from "./refs";
import {
  METADATA_PATH,
  NOTEBOOKS_DIR,
  isArchiveMetadata,
  parseFrontMatter,
  type ArchiveMetadata,
  type ArchiveNodeEntry,
} from "./format";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  basename,
  dirname,
  normalizeArchivePath,
  splitSegments,
} from "./paths";

export interface ImportOptions {
  now?: () => Date;
  maxBytes?: number;
  maxEntries?: number;
  /** Rebuild ids and hierarchy from paths instead of trusting the sidecar. */
  ignoreMetadata?: boolean;
}

export interface ImportResult {
  report: Awaited<ReturnType<Store["importSnapshot"]>>;
  usedMetadata: boolean;
  noteFiles: number;
  attachmentFiles: number;
  warnings: string[];
}

const JUNK_PREFIXES = ["__MACOSX/"];
const JUNK_NAMES = [".DS_Store", "Thumbs.db", "desktop.ini"];

/**
 * Imports a `localnotes` archive, or any directory tree of Markdown files.
 *
 * Every entry is validated before its content is used: absolute paths, `..`,
 * drive letters, backslashes, control characters, duplicate entries, over-long
 * paths, too many entries and oversized archives are rejected outright.
 * Attachment bytes are sniffed by content rather than trusted by name, so a file
 * called `logo.png` that is not an image is refused. Non-image files under
 * `attachments/` are reported and skipped; everything else aborts the import.
 *
 * Stable ids are preserved when the archive carries them: from
 * `.localnotes/metadata.json` first, then from the per-file YAML front matter,
 * then from UUID-named attachment files. Ids already in use with different
 * content are remapped by `Store.importSnapshot`, so nothing is overwritten.
 */
export async function importArchive(
  data: Uint8Array,
  store: Store,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const warnings: string[] = [];

  if (data.length === 0) throw new ImportError("Archive is empty");
  if (data.length > maxBytes) {
    throw new ImportError(
      `Archive is larger than the ${Math.round(maxBytes / 1024 / 1024)} MiB limit`,
    );
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(data);
  } catch (error) {
    throw new ImportError("Archive is not a readable ZIP file", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const names = Object.keys(raw);
  if (names.length > maxEntries) {
    throw new ImportError(`Archive contains ${names.length} entries (limit ${maxEntries})`);
  }

  // ── validate every entry path before touching any content ───────────────
  const entries = new Map<string, Uint8Array>();
  for (const name of names) {
    if (name.endsWith("/")) continue; // directory marker
    if (JUNK_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (JUNK_NAMES.includes(basename(name))) continue;
    const safe = normalizeArchivePath(name);
    if (entries.has(safe)) throw new ImportError(`Archive contains duplicate entry: ${safe}`);
    entries.set(safe, raw[name] as Uint8Array);
  }

  // ── optional sidecar metadata ──────────────────────────────────────────
  const metadata = readMetadata(entries, options, warnings);
  const nodeByPath = new Map<string, ArchiveNodeEntry>();
  const nodeById = new Map<string, ArchiveNodeEntry>();
  for (const entry of metadata?.nodes ?? []) {
    nodeById.set(entry.id, entry);
    if (entry.path) nodeByPath.set(entry.path, entry);
  }

  // ── attachments ────────────────────────────────────────────────────────
  const attachments: AttachmentMeta[] = [];
  const attachmentBytes = new Map<string, Uint8Array>();
  const attachmentIdByPath = new Map<string, string>();
  const attachmentMetaByArchiveId = new Map(
    (metadata?.attachments ?? []).map((entry) => [entry.id, entry]),
  );
  let attachmentFiles = 0;

  for (const [path, bytes] of entries) {
    const segments = splitSegments(path);
    if (segments.length !== 2 || segments[0] !== "attachments") continue;
    attachmentFiles += 1;

    const file = segments[1] ?? "";
    const dot = file.lastIndexOf(".");
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const fileExt = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";

    let mime: string;
    try {
      mime = validateAttachment(bytes);
    } catch (error) {
      if (error instanceof ValidationError) {
        warnings.push(`Skipped ${path}: ${error.message}`);
        continue;
      }
      throw error;
    }

    const ext = extForMime(mime) ?? fileExt;
    const id = isUuid(stem) ? stem : newId();
    const fromMetadata = attachmentMetaByArchiveId.get(id);
    attachments.push({
      id,
      noteId: fromMetadata?.noteId ?? null,
      filename: fromMetadata?.filename ?? safeFilename(basename(path), ext),
      mime,
      ext,
      size: bytes.length,
      // Always hashed from the bytes. The sidecar's digest is only a claim: an
      // archive is untrusted input, and storing an unverified digest would make
      // every later conflict decision on this attachment wrong.
      sha256: await sha256Hex(bytes),
      createdAt: now().toISOString(),
      syncState: "local-only",
      baseVersion: 0,
    });
    attachmentBytes.set(id, bytes);
    attachmentIdByPath.set(path, id);
  }

  // ── containers (notebooks and folders) ─────────────────────────────────
  const nodes: Node[] = [];
  const nodesById = new Map<string, Node>();
  const directoryIdByPath = new Map<string, string>();

  const addNode = (node: Node): void => {
    nodes.push(node);
    nodesById.set(node.id, node);
  };

  // Sidecar-declared containers first, parents before children, so a note's
  // parentId always resolves inside this snapshot.
  for (const entry of orderContainersFirst(metadata?.nodes ?? [], nodeById)) {
    if (entry.kind === "note" || nodesById.has(entry.id)) continue;
    addNode(
      buildNode({
        id: entry.id,
        kind: entry.kind,
        parentId: entry.parentId,
        title: entry.title,
        position: entry.position,
        createdAt: entry.createdAt,
      }),
    );
    if (entry.path) directoryIdByPath.set(entry.path, entry.id);
  }

  /**
   * The archive-relative directory a note's containers should come from: the
   * `notebooks/` root of the export format is skipped so it does not become a
   * notebook called "notebooks". Files outside `notebooks/` are grouped under a
   * single "Imported" notebook.
   */
  const containerPathFor = (filePath: string): string => {
    const segments = splitSegments(dirname(filePath));
    const relative = segments[0] === NOTEBOOKS_DIR ? segments.slice(1) : segments;
    return relative.length === 0 ? "Imported" : relative.join("/");
  };

  /** Finds or creates the notebook/folder chain for an archive directory. */
  const ensureDirectory = (directoryPath: string): string => {
    const existingSidecar = nodeByPath.get(directoryPath);
    if (existingSidecar && nodesById.has(existingSidecar.id)) return existingSidecar.id;
    const known = directoryIdByPath.get(directoryPath);
    if (known) return known;

    const segments = splitSegments(directoryPath);
    if (segments.length === 0) {
      throw new ImportError(`Cannot determine a container for ${directoryPath}`);
    }
    const parentPath = dirname(directoryPath);
    const parentId = parentPath.length === 0 ? null : ensureDirectory(parentPath);
    const id = newId();
    addNode(
      buildNode({
        id,
        kind: parentId === null ? "notebook" : "folder",
        parentId,
        title: basename(directoryPath) || "Imported",
        position: nodes.length,
        createdAt: now().toISOString(),
      }),
    );
    directoryIdByPath.set(directoryPath, id);
    return id;
  };

  // ── notes ──────────────────────────────────────────────────────────────
  let noteFiles = 0;
  let noteIndex = 0;
  const usedNoteIds = new Set<string>();

  for (const [path, bytes] of entries) {
    if (!path.toLowerCase().endsWith(".md")) continue;
    if ((splitSegments(path)[0] ?? "") === ".localnotes") continue;
    noteFiles += 1;
    noteIndex += 1;

    const { fields, body } = parseFrontMatter(new TextDecoder().decode(bytes));
    const fromMetadata = options.ignoreMetadata ? undefined : nodeByPath.get(path);
    const frontMatterId = fields["id"] && isUuid(fields["id"]) ? fields["id"] : null;

    let id = frontMatterId ?? (fromMetadata && isUuid(fromMetadata.id) ? fromMetadata.id : newId());
    if (usedNoteIds.has(id) || nodesById.has(id)) id = newId();
    usedNoteIds.add(id);

    const parentId = resolveNoteParent(
      path,
      fromMetadata,
      nodesById,
      ensureDirectory,
      containerPathFor,
    );

    const { markdown } = rewriteForImport(body, path, {
      attachmentRef: (resolvedPath, filename) => {
        const byPath = attachmentIdByPath.get(resolvedPath);
        if (byPath) {
          const meta = attachments.find((candidate) => candidate.id === byPath);
          return canonicalRefFromMime(byPath, meta?.mime ?? "image/png");
        }
        const byName = attachments.find((candidate) => candidate.filename === filename);
        return byName ? canonicalRefFromMime(byName.id, byName.mime) : null;
      },
    });

    const node = buildNode({
      id,
      kind: "note",
      parentId,
      title: fields["title"] ?? fromMetadata?.title ?? basename(path).replace(/\.md$/i, ""),
      content: markdown,
      position: fromMetadata?.position ?? noteIndex - 1,
      createdAt: fields["created"] ?? fromMetadata?.createdAt ?? now().toISOString(),
    });
    node.contentHash = await contentHash(markdown);
    addNode(node);
  }

  const snapshot: Snapshot = {
    version: 1,
    exportedAt: now().toISOString(),
    nodes,
    attachments,
    checkpoint: null,
  };

  const report = await store.importSnapshot(snapshot, { attachmentBytes });
  return {
    report,
    usedMetadata: metadata !== null,
    noteFiles,
    attachmentFiles,
    warnings: [...warnings, ...report.warnings],
  };
}

function readMetadata(
  entries: ReadonlyMap<string, Uint8Array>,
  options: ImportOptions,
  warnings: string[],
): ArchiveMetadata | null {
  const bytes = entries.get(METADATA_PATH);
  if (!bytes || options.ignoreMetadata) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isArchiveMetadata(parsed)) return parsed;
    warnings.push(`${METADATA_PATH} was not recognised; directory paths were used instead`);
  } catch {
    warnings.push(`${METADATA_PATH} was not valid JSON; directory paths were used instead`);
  }
  return null;
}

/**
 * A note's parent: the sidecar's parentId when that parent is part of this
 * archive, otherwise the notebook/folder chain derived from the file's directory.
 */
function resolveNoteParent(
  path: string,
  fromMetadata: ArchiveNodeEntry | undefined,
  nodesById: ReadonlyMap<string, Node>,
  ensureDirectory: (directoryPath: string) => string,
  containerPathFor: (filePath: string) => string,
): string | null {
  const declared = fromMetadata?.parentId;
  if (declared && nodesById.has(declared) && declared !== fromMetadata?.id) return declared;
  return ensureDirectory(containerPathFor(path));
}

function buildNode(input: {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  title: string;
  content?: string;
  position: number;
  createdAt: string;
}): Node {
  const content = input.kind === "note" ? (input.content ?? "") : "";
  return {
    id: input.id,
    kind: input.kind,
    parentId: input.parentId,
    title: input.title,
    content,
    position: input.position,
    contentHash: "",
    localVersion: 1,
    baseVersion: 0,
    syncState: "local-only",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deletedAt: null,
    conflictOf: null,
    conflictRecordedAt: null,
  };
}

/** Parents before children, so ids resolve in a single pass. */
function orderContainersFirst(
  entries: readonly ArchiveNodeEntry[],
  byId: ReadonlyMap<string, ArchiveNodeEntry>,
): ArchiveNodeEntry[] {
  const visited = new Set<string>();
  const out: ArchiveNodeEntry[] = [];
  const visit = (entry: ArchiveNodeEntry): void => {
    if (visited.has(entry.id)) return;
    const parent = entry.parentId === null ? null : byId.get(entry.parentId);
    if (parent) visit(parent);
    visited.add(entry.id);
    out.push(entry);
  };
  for (const entry of entries) visit(entry);
  return out;
}
