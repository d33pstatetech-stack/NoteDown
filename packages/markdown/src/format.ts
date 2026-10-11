import type { NodeKind, SyncState } from "@localnotes/shared";

export const ARCHIVE_FORMAT = "localnotes-archive";
export const ARCHIVE_VERSION = 1;
export const METADATA_DIR = ".localnotes";
export const METADATA_PATH = `${METADATA_DIR}/metadata.json`;
export const README_PATH = "README.txt";
export const NOTEBOOKS_DIR = "notebooks";

export interface ArchiveNodeEntry {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  title: string;
  /** Archive path of the note file; `null` for notebooks and folders. */
  path: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  syncState: SyncState;
}

export interface ArchiveAttachmentEntry {
  id: string;
  noteId: string | null;
  path: string;
  filename: string;
  mime: string;
  ext: string;
  size: number;
  sha256: string;
}

/**
 * Sidecar metadata. Everything needed to restore stable ids and relationships.
 * The archive stays usable without it — it is optional, documented, and ignored
 * by any other Markdown tool.
 */
export interface ArchiveMetadata {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  generator: string;
  exportedAt: string;
  checkpoint: string | null;
  nodes: ArchiveNodeEntry[];
  attachments: ArchiveAttachmentEntry[];
}

export function isArchiveMetadata(value: unknown): value is ArchiveMetadata {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ArchiveMetadata>;
  return (
    candidate.format === ARCHIVE_FORMAT &&
    typeof candidate.version === "number" &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.attachments)
  );
}

/**
 * Per-file front matter. A single exported `.md` file therefore still carries
 * its identity when moved out of the archive, and any Markdown editor renders
 * it as a metadata block. Values are JSON-quoted, which is valid YAML for strings.
 */
export function frontMatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to the raw value
    }
  }
  return trimmed.replace(/^'|'$/g, "");
}

/**
 * Splits YAML front matter from the body. Only a leading `---` block with a
 * closing delimiter is treated as front matter; anything else is plain Markdown
 * and is returned untouched (so ordinary hand-written files import cleanly).
 */
export function parseFrontMatter(text: string): {
  fields: Record<string, string>;
  body: string;
  hadFrontMatter: boolean;
} {
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { fields: {}, body: normalized, hadFrontMatter: false };

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "---" && line.trim() !== "...") continue;
    const fields: Record<string, string> = {};
    for (const raw of lines.slice(1, index)) {
      const separator = raw.indexOf(":");
      if (separator <= 0) continue;
      const key = raw.slice(0, separator).trim();
      const value = raw.slice(separator + 1);
      if (key.length > 0) fields[key] = unquote(value);
    }
    return {
      fields,
      body: lines.slice(index + 1).join("\n").replace(/^\n+/, ""),
      hadFrontMatter: true,
    };
  }
  return { fields: {}, body: normalized, hadFrontMatter: false };
}

export function readmeText(metadata: ArchiveMetadata): string {
  const notes = metadata.nodes.filter((node) => node.kind === "note").length;
  const notebooks = metadata.nodes.filter((node) => node.kind === "notebook").length;
  const folders = metadata.nodes.filter((node) => node.kind === "folder").length;
  return [
    "Local-first Markdown Notes — exported archive",
    "=============================================",
    "",
    "This archive is plain Markdown plus the images it references. It opens with",
    "any text editor or Markdown viewer and does not need this application.",
    "",
    "Layout:",
    "  notebooks/<notebook>/<folder>/<note>.md   one file per note",
    "  attachments/<attachment-id>.<ext>         the referenced binary files",
    "  .localnotes/metadata.json                 optional ids and relationships",
    "",
    "Each note file starts with a small YAML front-matter block carrying its",
    "title and stable id. Image references are relative to the note file, so the",
    "whole directory can be copied or zipped and will keep working.",
    "",
    `Export format version: ${metadata.version}`,
    `Exported: ${metadata.exportedAt}`,
    `Contents: ${notebooks} notebook(s), ${folders} folder(s), ${notes} note(s),`,
    `          ${metadata.attachments.length} attachment(s)`,
    "",
    "Importing this archive back into the app preserves note ids, so re-importing",
    "an unchanged archive does not create duplicates.",
    "",
  ].join("\n");
}
