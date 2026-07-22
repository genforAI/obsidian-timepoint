import { TFile, Vault, normalizePath } from "obsidian";
import { strFromU8, unzipSync } from "fflate";
import type { TimePointEntry } from "../model/types";
import {
  DAY_INDEX_BASENAME,
  entryFileName,
  parseStandaloneEntry,
  preservedDayViewStateBlock,
  serializeDayIndex,
  serializeStandaloneEntry,
  type DayFileRepository,
} from "../storage";
import { sha256Hex } from "./ExternalSnapshotService";

export type PortableAttachmentKind =
  | "raster-image"
  | "svg-image"
  | "pdf"
  | "audio"
  | "video"
  | "html"
  | "text"
  | "office"
  | "archive"
  | "other";

export type PortableAttachmentRenderPolicy =
  | "inline-image"
  | "sanitized-svg"
  | "sandboxed-pdf"
  | "local-audio"
  | "local-video"
  | "sanitized-html"
  | "inline-text"
  | "download-only";

export interface PortableAttachmentRecord {
  id: string;
  eventId: string;
  path: string;
  archivePath: string;
  fileName: string;
  mimeType: string;
  kind: PortableAttachmentKind;
  renderPolicy: PortableAttachmentRenderPolicy;
  size: number;
  sha256: string;
}

export interface PortableManifest {
  schema: "timepoint-portable";
  schemaVersion: 1;
  exportedAt: string;
  generator: "timepoint-web" | "obsidian-timepoint";
  generatorVersion: string;
  entrySchemaVersion: 1;
  entryCount: number;
  attachmentCount: number;
  dates: string[];
  attachments: PortableAttachmentRecord[];
}

export interface PortableAttachmentArtifact {
  record: PortableAttachmentRecord;
  bytes: ArrayBuffer;
}

export interface PreparedPortableContent {
  entries: Map<string, TimePointEntry>;
  attachments: PortableAttachmentArtifact[];
  errors: string[];
}

export type PortableLinkResolver = (target: string, sourcePath: string) => TFile | null;

export interface PortableArchivePreview {
  entryCount: number;
  attachmentCount: number;
  dates: string[];
  conflicts: string[];
  errors: string[];
  planFingerprint: string;
  canImport: boolean;
}

interface ParsedPortableArchive {
  bytes: Uint8Array;
  entries: TimePointEntry[];
  attachments: PortableAttachmentArtifact[];
  dayIndexes: Map<string, string>;
  manifest: PortableManifest;
  fingerprint: string;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BATCH_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 5_000;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const PORTABLE_ROOT = "TimePoint";
const ENTRY_PATH_PATTERN = /^TimePoint\/Days\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\/([^/]+\.md)$/u;

/**
 * Read only directly referenced, non-Markdown local files. The resulting
 * event copies use portable relative paths; the source entries are untouched.
 */
export async function preparePortableContent(
  vault: Vault,
  repository: DayFileRepository,
  entries: readonly TimePointEntry[],
  resolveLink?: PortableLinkResolver,
): Promise<PreparedPortableContent> {
  const copies = new Map<string, TimePointEntry>();
  const attachments: PortableAttachmentArtifact[] = [];
  const errors: string[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    const [year, month] = entry.date.split("-");
    const sourcePath =
      repository.getEntrySourcePath?.(entry) ??
      `${PORTABLE_ROOT}/Days/${year}/${month}/${entry.date}/${entryFileName(entry)}`;
    const references = extractLocalReferences(entry.contentMarkdown);
    const replacements: Replacement[] = [];
    const handledTargets = new Map<string, PortableAttachmentRecord>();
    for (const reference of references) {
      const targetText = decodeLinkTarget(reference.target);
      if (!targetText || isRemoteTarget(targetText)) continue;
      const target = stripFragmentAndQuery(targetText);
      if (!target || target.toLowerCase().endsWith(".md")) continue;
      const file =
        resolveLink?.(target, sourcePath) ?? resolvePortableTarget(vault, target, sourcePath);
      if (!(file instanceof TFile) || file.extension.toLowerCase() === "md") continue;

      let record = handledTargets.get(file.path);
      if (!record) {
        if (file.stat.size > MAX_FILE_BYTES) {
          errors.push(`Attachment ${file.path} exceeds the 50 MiB portable limit.`);
          continue;
        }
        if (totalBytes + file.stat.size > MAX_BATCH_BYTES) {
          errors.push("Portable attachments exceed the 500 MiB batch limit.");
          continue;
        }
        try {
          const bytes = await vault.readBinary(file);
          const mimeType = mimeFromName(file.name);
          const classification = classifyPortableAttachment(file.name, mimeType, bytes);
          const digest = await sha256Hex(new Uint8Array(bytes));
          const portableName = `${digest.slice(0, 16)}-${sanitizeFileName(file.name)}`;
          const relativePath = `attachments/${portableName}`;
          const [year, month] = entry.date.split("-");
          record = {
            id: `asset-${digest.slice(0, 16)}-${entry.id.slice(0, 24)}`,
            eventId: entry.id,
            path: relativePath,
            archivePath: `${PORTABLE_ROOT}/Days/${year}/${month}/${entry.date}/${relativePath}`,
            fileName: file.name,
            mimeType,
            kind: classification.kind,
            renderPolicy: classification.renderPolicy,
            size: bytes.byteLength,
            sha256: digest,
          };
          handledTargets.set(file.path, record);
          attachments.push({ record, bytes });
          totalBytes += bytes.byteLength;
        } catch (error) {
          errors.push(
            `Attachment ${file.path} could not be exported safely: ${errorMessage(error)}`,
          );
          continue;
        }
      }
      replacements.push({
        start: reference.start,
        end: reference.end,
        value: `${record.path}${targetText.slice(target.length)}`,
      });
    }
    copies.set(entry.id, {
      ...entry,
      contentMarkdown: applyReplacements(entry.contentMarkdown, replacements),
    });
  }
  return { entries: copies, attachments, errors: [...new Set(errors)] };
}

/** Import a Web/Obsidian portable ZIP without ever replacing existing files. */
export class PortableArchiveService {
  constructor(
    private readonly vault: Vault,
    private readonly repository: DayFileRepository,
    private readonly getStorageFolder: () => string,
    private readonly trashFile: (file: TFile) => Promise<void>,
  ) {}

  async preview(file: File): Promise<PortableArchivePreview> {
    const parsed = await parsePortableArchive(new Uint8Array(await file.arrayBuffer()));
    const conflicts: string[] = [];
    const errors: string[] = [];
    const ids = new Set<string>();
    for (const entry of parsed.entries) {
      if (ids.has(entry.id)) errors.push(`Portable event ID ${entry.id} is duplicated.`);
      ids.add(entry.id);
    }
    for (const date of parsed.manifest.dates) {
      const day = await this.repository.loadDay(date);
      const blocking = day.diagnostics.find((item) => item.severity === "error");
      if (blocking) errors.push(`Import blocked for ${date}: ${blocking.message}`);
      const existingIds = new Set(day.entries.map((entry) => entry.id));
      for (const entry of parsed.entries.filter((candidate) => candidate.date === date)) {
        if (existingIds.has(entry.id)) conflicts.push(entry.id);
        const target = this.entryTarget(entry);
        if (this.vault.getAbstractFileByPath(target)) conflicts.push(target);
      }
      const indexTarget = this.indexTarget(date);
      if (this.vault.getAbstractFileByPath(indexTarget)) conflicts.push(indexTarget);
    }
    for (const attachment of parsed.attachments) {
      const owner = parsed.entries.find((entry) => entry.id === attachment.record.eventId);
      if (!owner) {
        errors.push(`Attachment ${attachment.record.path} has no owning event.`);
        continue;
      }
      const target = normalizePath(`${this.dayFolder(owner.date)}/${attachment.record.path}`);
      if (this.vault.getAbstractFileByPath(target)) conflicts.push(target);
    }
    const stableConflicts = [...new Set(conflicts)].sort();
    const stableErrors = [...new Set(errors)].sort();
    return {
      entryCount: parsed.entries.length,
      attachmentCount: parsed.attachments.length,
      dates: parsed.manifest.dates,
      conflicts: stableConflicts,
      errors: stableErrors,
      planFingerprint: await sha256Hex(
        JSON.stringify({
          source: parsed.fingerprint,
          conflicts: stableConflicts,
          errors: stableErrors,
        }),
      ),
      canImport: stableConflicts.length === 0 && stableErrors.length === 0,
    };
  }

  async import(file: File, expectedPlanFingerprint: string): Promise<PortableArchivePreview> {
    const preview = await this.preview(file);
    if (!preview.canImport) {
      throw new Error(
        preview.errors[0] ??
          preview.conflicts[0] ??
          "Portable import is not safe to apply to this vault.",
      );
    }
    if (preview.planFingerprint !== expectedPlanFingerprint) {
      throw new Error("The vault changed after preview. Preview the portable ZIP again.");
    }
    const parsed = await parsePortableArchive(new Uint8Array(await file.arrayBuffer()));
    const created: string[] = [];
    try {
      for (const entry of parsed.entries) {
        const path = this.entryTarget(entry);
        await ensureFolder(this.vault, parentPath(path));
        if (this.vault.getAbstractFileByPath(path))
          throw new Error(`Import target exists: ${path}`);
        await this.vault.create(path, serializeStandaloneEntry(entry));
        created.push(path);
      }
      const writtenAttachmentTargets = new Set<string>();
      for (const attachment of parsed.attachments) {
        const owner = parsed.entries.find((entry) => entry.id === attachment.record.eventId);
        if (!owner) throw new Error(`Attachment ${attachment.record.path} has no owner.`);
        const path = normalizePath(`${this.dayFolder(owner.date)}/${attachment.record.path}`);
        if (writtenAttachmentTargets.has(path)) continue;
        await ensureFolder(this.vault, parentPath(path));
        if (this.vault.getAbstractFileByPath(path))
          throw new Error(`Import target exists: ${path}`);
        await this.vault.createBinary(path, attachment.bytes);
        created.push(path);
        writtenAttachmentTargets.add(path);
      }
      for (const date of parsed.manifest.dates) {
        const entries = parsed.entries.filter((entry) => entry.date === date);
        const sourceIndex = parsed.dayIndexes.get(date) ?? "";
        const path = this.indexTarget(date);
        await ensureFolder(this.vault, parentPath(path));
        if (this.vault.getAbstractFileByPath(path))
          throw new Error(`Import target exists: ${path}`);
        await this.vault.create(
          path,
          serializeDayIndex(
            date,
            entries,
            undefined,
            undefined,
            preservedDayViewStateBlock(sourceIndex),
          ),
        );
        created.push(path);
      }
    } catch (error) {
      await this.rollback(created);
      throw error;
    }
    return preview;
  }

  private dayFolder(date: string): string {
    const [year, month] = date.split("-");
    return normalizePath(
      `${this.getStorageFolder().replace(/\/+$/u, "")}/${year}/${month}/${date}`,
    );
  }

  private entryTarget(entry: TimePointEntry): string {
    return normalizePath(`${this.dayFolder(entry.date)}/${entryFileName(entry)}`);
  }

  private indexTarget(date: string): string {
    return normalizePath(`${this.dayFolder(date)}/${DAY_INDEX_BASENAME}.md`);
  }

  private async rollback(paths: readonly string[]): Promise<void> {
    for (const path of [...paths].reverse()) {
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      try {
        await this.trashFile(file);
      } catch {
        // Preserve the original error. Missing day indexes still make an
        // interrupted portable import visibly incomplete.
      }
    }
  }
}

async function parsePortableArchive(bytes: Uint8Array): Promise<ParsedPortableArchive> {
  if (bytes.byteLength > MAX_BATCH_BYTES) throw new Error("ZIP exceeds the 500 MiB limit.");
  preflightZipDirectory(bytes);
  let expandedBytes = 0;
  let fileCount = 0;
  const paths = new Set<string>();
  const files = unzipSync(bytes, {
    filter(file) {
      assertSafeArchivePath(file.name);
      if (paths.has(file.name)) throw new Error(`ZIP repeats path ${file.name}.`);
      paths.add(file.name);
      fileCount += 1;
      expandedBytes += file.originalSize;
      if (fileCount > MAX_FILES) throw new Error("ZIP contains too many files.");
      if (file.originalSize > MAX_FILE_BYTES)
        throw new Error(`ZIP member ${file.name} exceeds 50 MiB.`);
      if (expandedBytes > MAX_BATCH_BYTES)
        throw new Error("ZIP expands beyond the 500 MiB batch limit.");
      if (
        file.originalSize > 10 * 1024 * 1024 &&
        file.size > 0 &&
        file.originalSize / file.size > 200
      ) {
        throw new Error(`ZIP member ${file.name} has an unsafe compression ratio.`);
      }
      return true;
    },
  });
  const manifestBytes = files["manifest.json"] ?? files["portable-manifest.json"];
  if (!manifestBytes) throw new Error("Portable ZIP has no manifest.json.");
  const parsedManifest = JSON.parse(strFromU8(manifestBytes)) as unknown;
  if (!isPortableManifest(parsedManifest))
    throw new Error("Portable ZIP manifest is invalid or unsupported.");
  const manifest = parsedManifest;
  const entries: TimePointEntry[] = [];
  const dayIndexes = new Map<string, string>();
  for (const [path, content] of Object.entries(files)) {
    const match = ENTRY_PATH_PATTERN.exec(path);
    if (!match) continue;
    const date = match[3] ?? "";
    const basename = match[4] ?? "";
    if (match[1] !== date.slice(0, 4) || match[2] !== date.slice(5, 7))
      throw new Error(`Portable path ${path} does not match its date.`);
    if (content.byteLength > MAX_MARKDOWN_BYTES)
      throw new Error(`Markdown file ${path} exceeds 2 MiB.`);
    const markdown = strFromU8(content);
    if (basename === `${DAY_INDEX_BASENAME}.md`) {
      dayIndexes.set(date, markdown);
      continue;
    }
    const parsed = parseStandaloneEntry(markdown, { expectedDate: date, sourcePath: path });
    const blocking = parsed.diagnostics.find((item) => item.severity === "error");
    if (!parsed.entry || blocking)
      throw new Error(`Portable event ${path} is invalid: ${blocking?.message ?? "no entry"}`);
    entries.push(parsed.entry);
  }
  const attachments: PortableAttachmentArtifact[] = [];
  const attachmentIds = new Set<string>();
  for (const record of manifest.attachments) {
    if (attachmentIds.has(record.id))
      throw new Error(`Portable manifest repeats attachment ID ${record.id}.`);
    attachmentIds.add(record.id);
    const content = files[record.archivePath];
    if (!content) throw new Error(`Portable attachment ${record.archivePath} is missing.`);
    if (content.byteLength !== record.size)
      throw new Error(`Portable attachment ${record.archivePath} failed its size check.`);
    const digest = await sha256Hex(content);
    if (digest !== record.sha256)
      throw new Error(`Portable attachment ${record.archivePath} failed SHA-256 validation.`);
    const classification = classifyPortableAttachment(record.fileName, record.mimeType, content);
    if (classification.kind !== record.kind || classification.renderPolicy !== record.renderPolicy)
      throw new Error(`Portable attachment ${record.archivePath} has inconsistent metadata.`);
    const owner = entries.find((entry) => entry.id === record.eventId);
    if (!owner) throw new Error(`Portable attachment ${record.archivePath} has no owner.`);
    const [year, month] = owner.date.split("-");
    if (
      record.archivePath !== `${PORTABLE_ROOT}/Days/${year}/${month}/${owner.date}/${record.path}`
    ) {
      throw new Error(`Portable attachment ${record.archivePath} is outside its event day.`);
    }
    attachments.push({ record, bytes: toArrayBuffer(content) });
  }
  const dates = [...new Set([...entries.map((entry) => entry.date), ...dayIndexes.keys()])].sort();
  if (
    manifest.entryCount !== entries.length ||
    manifest.attachmentCount !== attachments.length ||
    JSON.stringify(manifest.dates) !== JSON.stringify(dates)
  ) {
    throw new Error("Portable ZIP manifest counts or dates do not match its contents.");
  }
  return {
    bytes,
    entries,
    attachments,
    dayIndexes,
    manifest,
    fingerprint: await sha256Hex(bytes),
  };
}

interface MarkdownReference {
  start: number;
  end: number;
  target: string;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

function extractLocalReferences(markdown: string): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  const searchable = maskNonLinkMarkdown(markdown);
  const patterns = [
    /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/gu,
    /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu,
    /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/gu,
  ];
  for (const pattern of patterns) {
    for (const match of searchable.matchAll(pattern)) {
      const raw = match[1];
      if (!raw || match.index === undefined) continue;
      if (isEscapedAt(markdown, match.index)) continue;
      const relative = match[0].indexOf(raw);
      const unwrapped = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
      const offset = raw.startsWith("<") ? 1 : 0;
      references.push({
        start: match.index + relative + offset,
        end: match.index + relative + offset + unwrapped.length,
        target: unwrapped,
      });
    }
  }
  return references.sort((left, right) => left.start - right.start);
}

function maskNonLinkMarkdown(markdown: string): string {
  const preserveLines = (value: string) => value.replace(/[^\r\n]/gu, " ");
  return markdown
    .replace(/^(\s*)(`{3,}|~{3,})[^\r\n]*(?:\r?\n[\s\S]*?^(?:\1\2)\s*$|[\s\S]*$)/gmu, preserveLines)
    .replace(/<!--[\s\S]*?-->/gu, preserveLines)
    .replace(/(`+)(?!`)([^\r\n]*?)\1/gu, preserveLines);
}

function isEscapedAt(markdown: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function applyReplacements(markdown: string, replacements: readonly Replacement[]): string {
  let result = markdown;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function resolvePortableTarget(vault: Vault, target: string, sourcePath: string): TFile | null {
  const direct = vault.getAbstractFileByPath(normalizePath(target));
  if (direct instanceof TFile) return direct;
  const parent = parentPath(sourcePath);
  const relative = vault.getAbstractFileByPath(normalizePath(`${parent}/${target}`));
  return relative instanceof TFile ? relative : null;
}

function classifyPortableAttachment(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array | ArrayBuffer,
): { kind: PortableAttachmentKind; renderPolicy: PortableAttachmentRenderPolicy } {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
    if (!matchesRasterMagic(mimeType, data)) throw new Error("image signature mismatch");
    return { kind: "raster-image", renderPolicy: "inline-image" };
  }
  if (mimeType === "image/svg+xml" || extension === "svg") {
    if (
      !isText(data) ||
      !/<svg(?:\s|\/?>)/iu.test(new TextDecoder().decode(data.subarray(0, 262_144)))
    )
      throw new Error("SVG signature mismatch");
    return { kind: "svg-image", renderPolicy: "sanitized-svg" };
  }
  if (mimeType === "application/pdf" || extension === "pdf") {
    if (!asciiAt(data, 0, "%PDF-")) throw new Error("PDF signature mismatch");
    return { kind: "pdf", renderPolicy: "sandboxed-pdf" };
  }
  if (mimeType.startsWith("audio/")) return { kind: "audio", renderPolicy: "local-audio" };
  if (mimeType.startsWith("video/")) return { kind: "video", renderPolicy: "local-video" };
  if (mimeType === "text/html" || extension === "html" || extension === "htm") {
    if (!isText(data)) throw new Error("HTML is not text");
    return { kind: "html", renderPolicy: "sanitized-html" };
  }
  if (mimeType.startsWith("text/")) {
    if (!isText(data)) throw new Error("text attachment contains binary data");
    return { kind: "text", renderPolicy: "inline-text" };
  }
  if (["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(extension)) {
    if (!startsWith(data, [0x50, 0x4b])) throw new Error("office signature mismatch");
    return { kind: "office", renderPolicy: "download-only" };
  }
  if (["zip", "7z", "rar"].includes(extension)) {
    if (extension === "zip" && !startsWith(data, [0x50, 0x4b]))
      throw new Error("ZIP signature mismatch");
    return { kind: "archive", renderPolicy: "download-only" };
  }
  return { kind: "other", renderPolicy: "download-only" };
}

function matchesRasterMagic(mimeType: string, bytes: Uint8Array): boolean {
  return (
    (mimeType === "image/png" &&
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (mimeType === "image/jpeg" && startsWith(bytes, [0xff, 0xd8, 0xff])) ||
    (mimeType === "image/gif" && (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a"))) ||
    (mimeType === "image/webp" && asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP"))
  );
}

function isPortableManifest(value: unknown): value is PortableManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PortableManifest>;
  return (
    candidate.schema === "timepoint-portable" &&
    candidate.schemaVersion === 1 &&
    candidate.entrySchemaVersion === 1 &&
    typeof candidate.exportedAt === "string" &&
    (candidate.generator === "timepoint-web" || candidate.generator === "obsidian-timepoint") &&
    typeof candidate.generatorVersion === "string" &&
    Number.isInteger(candidate.entryCount) &&
    Number.isInteger(candidate.attachmentCount) &&
    Array.isArray(candidate.dates) &&
    candidate.dates.every(
      (date) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date),
    ) &&
    Array.isArray(candidate.attachments) &&
    candidate.attachments.every(isPortableAttachmentRecord)
  );
}

function isPortableAttachmentRecord(value: unknown): value is PortableAttachmentRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PortableAttachmentRecord>;
  const kinds: PortableAttachmentKind[] = [
    "raster-image",
    "svg-image",
    "pdf",
    "audio",
    "video",
    "html",
    "text",
    "office",
    "archive",
    "other",
  ];
  const policies: PortableAttachmentRenderPolicy[] = [
    "inline-image",
    "sanitized-svg",
    "sandboxed-pdf",
    "local-audio",
    "local-video",
    "sanitized-html",
    "inline-text",
    "download-only",
  ];
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.archivePath !== "string" ||
    typeof candidate.fileName !== "string" ||
    typeof candidate.mimeType !== "string" ||
    !candidate.kind ||
    !kinds.includes(candidate.kind) ||
    !candidate.renderPolicy ||
    !policies.includes(candidate.renderPolicy) ||
    typeof candidate.size !== "number" ||
    !Number.isInteger(candidate.size) ||
    candidate.size < 0 ||
    candidate.size > MAX_FILE_BYTES ||
    typeof candidate.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.sha256)
  ) {
    return false;
  }
  try {
    assertSafeArchivePath(candidate.archivePath);
  } catch {
    return false;
  }
  return (
    candidate.path.startsWith("attachments/") &&
    !candidate.path.includes("..") &&
    candidate.archivePath.endsWith(`/${candidate.path}`)
  );
}

function assertSafeArchivePath(path: string): void {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    /^[A-Za-z]:/u.test(normalized) ||
    hasControlCharacter(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`ZIP contains unsafe path ${JSON.stringify(path)}.`);
  }
}

/** Reject dangerous declarations before unzipSync can allocate output. */
function preflightZipDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  const maximumComment = 65_535;
  let eocd = -1;
  for (
    let offset = bytes.byteLength - minimumEocd;
    offset >= Math.max(0, bytes.byteLength - minimumEocd - maximumComment);
    offset -= 1
  ) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + minimumEocd + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-directory record is missing.");
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw new Error("Multi-volume and ZIP64 archives are not supported.");
  if (entryCount > MAX_FILES) throw new Error("ZIP contains too many files.");
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > eocd) throw new Error("ZIP central directory is outside the archive.");

  const paths = new Set<string>();
  let expandedBytes = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("ZIP central directory is malformed.");
    const flags = view.getUint16(cursor + 8, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const originalSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (compressedSize === 0xffffffff || originalSize === 0xffffffff || localOffset === 0xffffffff)
      throw new Error("ZIP64 members are not supported.");
    if ((flags & 0x1) !== 0) throw new Error("Encrypted ZIP members are not supported.");
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > directoryEnd) throw new Error("ZIP central directory entry is truncated.");
    const path = decodeZipPath(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    assertSafeArchivePath(path);
    const normalizedPath = path.normalize("NFC").toLowerCase();
    if (paths.has(normalizedPath)) throw new Error(`ZIP repeats path ${path}.`);
    paths.add(normalizedPath);
    if (originalSize > MAX_FILE_BYTES) throw new Error(`ZIP member ${path} exceeds 50 MiB.`);
    expandedBytes += originalSize;
    if (expandedBytes > MAX_BATCH_BYTES)
      throw new Error("ZIP expands beyond the 500 MiB batch limit.");
    if (
      originalSize > 10 * 1024 * 1024 &&
      (compressedSize === 0 || originalSize / compressedSize > 200)
    )
      throw new Error(`ZIP member ${path} has an unsafe compression ratio.`);
    validateLocalZipHeader(bytes, view, localOffset, path, compressedSize, directoryOffset);
    cursor = recordEnd;
  }
  if (cursor !== directoryEnd)
    throw new Error("ZIP central directory has unexpected trailing records.");
}

function validateLocalZipHeader(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  expectedPath: string,
  compressedSize: number,
  directoryOffset: number,
): void {
  if (offset + 30 > directoryOffset || view.getUint32(offset, true) !== 0x04034b50)
    throw new Error(`ZIP local header for ${expectedPath} is invalid.`);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameLength + extraLength;
  if (dataOffset + compressedSize > directoryOffset)
    throw new Error(`ZIP member ${expectedPath} extends outside its data area.`);
  const localPath = decodeZipPath(bytes.subarray(offset + 30, offset + 30 + nameLength));
  if (localPath !== expectedPath)
    throw new Error(`ZIP member ${expectedPath} has mismatched local metadata.`);
}

function decodeZipPath(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ZIP contains a path that is not valid UTF-8.");
  }
}

function mimeFromName(fileName: string): string {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const values: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    html: "text/html",
    htm: "text/html",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return values[extension] ?? "application/octet-stream";
}

function sanitizeFileName(value: string): string {
  const safe = [...value.normalize("NFKC")]
    .map((character) =>
      /[\\/:*?"<>|]/u.test(character) || hasControlCharacter(character) ? "-" : character,
    )
    .join("")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 120);
  return safe || "attachment.bin";
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function decodeLinkTarget(value: string): string {
  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim();
  }
}

function stripFragmentAndQuery(value: string): string {
  return value.split(/[?#]/u, 1)[0] ?? "";
}

function isRemoteTarget(value: string): boolean {
  return value.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value);
}

function isText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, Math.min(bytes.length, 262_144)).includes(0);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
