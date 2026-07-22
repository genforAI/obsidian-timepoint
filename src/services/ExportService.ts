import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import {
  exportTimePointCsv,
  exportTimePointJson,
  exportTimePointMarkdown,
  exportTimePointRangeJson,
  exportTimePointRangeMarkdown,
} from "../import-export";
import type { ParseDiagnostic, ParsedDayFile, TimePointEntry } from "../model/types";
import {
  DAY_INDEX_BASENAME,
  entryFileName,
  preservedDayViewStateBlock,
  serializeDayIndex,
  serializeStandaloneEntry,
  type DayFileRepository,
} from "../storage";
import { isValidDateString, shiftDate } from "../utils/time";
import {
  matchesImageMagic,
  parseSnapshotMarkdown,
  sha256Hex,
  validatePublicHttpsUrl,
} from "./ExternalSnapshotService";
import {
  preparePortableContent,
  type PortableAttachmentArtifact,
  type PortableLinkResolver,
  type PortableManifest,
} from "./PortableArchiveService";

export type ExportScope =
  { kind: "day"; date: string } | { kind: "range"; startDate: string; endDate: string };

export type ExportFormat = "markdown" | "json" | "csv" | "portable";

export interface ExportRequest {
  scope: ExportScope;
  format: ExportFormat;
}

export interface ExportPreview {
  request: ExportRequest;
  dates: string[];
  dayCount: number;
  entryCount: number;
  emptyDayCount: number;
  conflictCount: number;
  warningCount: number;
  errorCount: number;
  errors: string[];
  sourceFingerprint: string;
  canExport: boolean;
}

export interface ExportResult {
  request: ExportRequest;
  dayCount: number;
  entryCount: number;
  files: string[];
  primaryPath: string;
  /** Present only for a single output file no larger than 2 MiB. */
  copyableContent?: string;
}

interface LoadedRange {
  dates: string[];
  days: ParsedDayFile[];
  entries: TimePointEntry[];
  snapshotArtifacts: SnapshotArtifact[];
  portableEntries: Map<string, TimePointEntry>;
  localAttachments: PortableAttachmentArtifact[];
  preview: ExportPreview;
}

interface PendingFile {
  path: string;
  content: string | ArrayBuffer;
}

interface SnapshotArtifact {
  id: string;
  markdown: string;
  preview?: ArrayBuffer;
}

const MAX_RANGE_DAYS = 366;
const MAX_COPYABLE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_PREVIEW_BYTES = 2 * 1024 * 1024;

export class ExportService {
  constructor(
    private readonly vault: Vault,
    private readonly repository: DayFileRepository,
    private readonly getExportFolder: () => string,
    private readonly trashFile: (file: TFile) => Promise<void>,
    private readonly resolveLink?: PortableLinkResolver,
  ) {}

  async preview(request: ExportRequest): Promise<ExportPreview> {
    return (await this.load(request)).preview;
  }

  /**
   * Write only after a successful preview of the exact same normalized source.
   * The second read prevents a stale preview from being presented as success.
   */
  async export(request: ExportRequest, expectedFingerprint: string): Promise<ExportResult> {
    const loaded = await this.load(request);
    if (!loaded.preview.canExport) {
      throw new Error(
        loaded.preview.errors[0] ??
          "Export blocked because the selected data is not safe to export.",
      );
    }
    if (loaded.preview.sourceFingerprint !== expectedFingerprint) {
      throw new Error(
        "Export preview is stale because timeline data changed. Preview again; no export was written.",
      );
    }

    const output = await this.prepareOutput(request, loaded);
    const created: string[] = [];
    try {
      for (const file of output.files) {
        await ensureFolder(this.vault, parentPath(file.path));
        if (this.vault.getAbstractFileByPath(file.path)) {
          throw new Error(
            `Export target ${file.path} appeared after preview; no partial result was kept.`,
          );
        }
        if (typeof file.content === "string") {
          await this.vault.create(file.path, file.content);
        } else {
          await this.vault.createBinary(file.path, file.content);
        }
        created.push(file.path);
      }
    } catch (error) {
      await this.rollbackCreatedFiles(created);
      throw error;
    }

    const onlyFile = output.files.length === 1 ? output.files[0] : undefined;
    return {
      request,
      dayCount: loaded.preview.dayCount,
      entryCount: loaded.preview.entryCount,
      files: output.files.map((file) => file.path),
      primaryPath: output.primaryPath,
      ...(onlyFile &&
      typeof onlyFile.content === "string" &&
      utf8ByteLength(onlyFile.content) <= MAX_COPYABLE_BYTES
        ? { copyableContent: onlyFile.content }
        : {}),
    };
  }

  /** Compatibility wrapper for callers that have not yet adopted the preview panel. */
  async exportDay(date: string, format: ExportFormat): Promise<string> {
    const request: ExportRequest = { scope: { kind: "day", date }, format };
    const preview = await this.preview(request);
    if (!preview.canExport) {
      throw new Error(
        `Export blocked: ${preview.errors[0] ?? "the selected data is unsafe"}. No export was written.`,
      );
    }
    return (await this.export(request, preview.sourceFingerprint)).primaryPath;
  }

  private async load(request: ExportRequest): Promise<LoadedRange> {
    const dates = enumerateExportDates(request.scope);
    const days = await Promise.all(dates.map((date) => this.repository.loadDay(date)));
    const entries = days.flatMap((day) => day.entries);
    const snapshotIds = [
      ...new Set(entries.flatMap((entry) => entry.linkSnapshotIds ?? [])),
    ].sort();
    const snapshotLoad =
      request.format === "portable"
        ? await this.readSnapshotArtifacts(snapshotIds)
        : { artifacts: [] as SnapshotArtifact[], errors: [] as string[] };
    const portableLoad =
      request.format === "portable"
        ? await preparePortableContent(this.vault, this.repository, entries, this.resolveLink)
        : {
            entries: new Map<string, TimePointEntry>(),
            attachments: [] as PortableAttachmentArtifact[],
            errors: [] as string[],
          };
    const diagnostics = days.flatMap((day, index) =>
      day.diagnostics.map((diagnostic) => ({ date: dates[index] ?? "", diagnostic })),
    );
    const errors = diagnostics.filter(({ diagnostic }) => diagnostic.severity === "error");
    const warnings = diagnostics.filter(({ diagnostic }) => diagnostic.severity === "warning");
    const seenIds = new Map<string, string>();
    const duplicateErrors: string[] = [];
    for (const entry of entries) {
      const firstDate = seenIds.get(entry.id);
      if (firstDate) {
        duplicateErrors.push(
          `Duplicate TimePoint ID ${entry.id} appears on ${firstDate} and ${entry.date}.`,
        );
      } else {
        seenIds.set(entry.id, entry.date);
      }
    }
    const errorMessages = [
      ...errors.map(({ date, diagnostic }) => formatDiagnostic(date, diagnostic)),
      ...duplicateErrors,
      ...snapshotLoad.errors,
      ...portableLoad.errors,
    ];
    const sourceFingerprint = fingerprint({
      request,
      dates,
      days: days.map((day) => ({
        date: day.date,
        timezone: day.timezone,
        storageLayout: day.storageLayout,
        entries: day.entries,
        diagnostics: day.diagnostics,
        viewState: day.viewState,
        viewStateBlock: preservedDayViewStateBlock(day.rawMarkdown),
      })),
      snapshots: snapshotLoad.artifacts.map((artifact) => ({
        id: artifact.id,
        markdown: artifact.markdown,
        preview: artifact.preview ? binaryFingerprint(artifact.preview) : null,
      })),
      localAttachments: portableLoad.attachments.map((artifact) => artifact.record),
    });
    const preview: ExportPreview = {
      request,
      dates,
      dayCount: dates.length,
      entryCount: entries.length,
      emptyDayCount: days.filter((day) => day.entries.length === 0).length,
      conflictCount: duplicateErrors.length,
      warningCount: warnings.length,
      errorCount: errorMessages.length,
      errors: errorMessages,
      sourceFingerprint,
      canExport: errorMessages.length === 0,
    };
    return {
      dates,
      days,
      entries,
      snapshotArtifacts: snapshotLoad.artifacts,
      portableEntries: portableLoad.entries,
      localAttachments: portableLoad.attachments,
      preview,
    };
  }

  private async prepareOutput(
    request: ExportRequest,
    loaded: LoadedRange,
  ): Promise<{ files: PendingFile[]; primaryPath: string }> {
    const scopeLabel = exportScopeLabel(request.scope);
    const baseFolder = normalizePath(`${this.getExportFolder()}/${scopeLabel}`);
    if (request.format === "portable") {
      return this.preparePortableOutput(baseFolder, request, loaded);
    }

    const extension = request.format === "markdown" ? "md" : request.format;
    const preferredPath = normalizePath(`${baseFolder}/timepoint-${scopeLabel}.${extension}`);
    const path = this.nextAvailablePath(preferredPath, extension);
    let content: string;
    if (request.format === "csv") {
      content = exportTimePointCsv(loaded.entries);
    } else if (request.scope.kind === "day") {
      const options = {
        date: request.scope.date,
        ...(loaded.days[0]?.timezone ? { timezone: loaded.days[0].timezone } : {}),
      };
      content =
        request.format === "json"
          ? exportTimePointJson(loaded.entries, options)
          : exportTimePointMarkdown(loaded.entries, options);
    } else {
      content =
        request.format === "json"
          ? exportTimePointRangeJson(loaded.entries, request.scope)
          : exportTimePointRangeMarkdown(loaded.entries, request.scope);
    }
    return { files: [{ path, content }], primaryPath: path };
  }

  private preparePortableOutput(
    baseFolder: string,
    request: ExportRequest,
    loaded: LoadedRange,
  ): { files: PendingFile[]; primaryPath: string } {
    const root = this.nextAvailableFolder(normalizePath(`${baseFolder}/portable`));
    const files: PendingFile[] = [];
    const dayLinks: string[] = [];
    for (const [index, day] of loaded.days.entries()) {
      const date = day.date ?? loaded.dates[index];
      if (!date) throw new Error("A selected export day has no recoverable date.");
      const [year, month] = date.split("-");
      if (!year || !month) throw new Error(`Invalid loaded date ${date}.`);
      const dayFolder = normalizePath(`${root}/TimePoint/Days/${year}/${month}/${date}`);
      for (const entry of day.entries) {
        const portableEntry = loaded.portableEntries.get(entry.id) ?? entry;
        files.push({
          path: normalizePath(`${dayFolder}/${entryFileName(portableEntry)}`),
          content: serializeStandaloneEntry(portableEntry),
        });
      }
      const indexPath = normalizePath(`${dayFolder}/${DAY_INDEX_BASENAME}.md`);
      files.push({
        path: indexPath,
        content: serializeDayIndex(
          date,
          day.entries,
          day.timezone,
          undefined,
          preservedDayViewStateBlock(day.rawMarkdown),
        ),
      });
      dayLinks.push(
        `- [${date}](TimePoint/Days/${year}/${month}/${date}/${DAY_INDEX_BASENAME}.md)`,
      );
    }
    const writtenAttachmentPaths = new Set<string>();
    for (const attachment of loaded.localAttachments) {
      const path = normalizePath(`${root}/${attachment.record.archivePath}`);
      if (writtenAttachmentPaths.has(path)) continue;
      files.push({ path, content: attachment.bytes });
      writtenAttachmentPaths.add(path);
    }
    for (const snapshot of loaded.snapshotArtifacts) {
      const folder = normalizePath(`${root}/TimePoint/Snapshots/${snapshot.id}`);
      if (snapshot.preview) {
        files.push({ path: `${folder}/preview.webp`, content: snapshot.preview });
      }
      files.push({ path: `${folder}/snapshot.md`, content: snapshot.markdown });
    }
    const manifest: PortableManifest = {
      schema: "timepoint-portable",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      generator: "obsidian-timepoint",
      generatorVersion: "0.8.0-beta.1",
      entrySchemaVersion: 1,
      entryCount: loaded.entries.length,
      attachmentCount: loaded.localAttachments.length,
      dates: loaded.dates,
      attachments: loaded.localAttachments.map((artifact) => artifact.record),
    };
    files.push({
      path: normalizePath(`${root}/manifest.json`),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    });
    const primaryPath = normalizePath(`${root}/_TimePoint_Export.md`);
    const rangeLabel = exportScopeLabel(request.scope);
    files.push({
      path: primaryPath,
      content: [
        "---",
        "timepoint-portable-export: 1",
        `scope: ${request.scope.kind}`,
        ...(request.scope.kind === "day"
          ? [`date: ${request.scope.date}`]
          : [`startDate: ${request.scope.startDate}`, `endDate: ${request.scope.endDate}`]),
        `eventCount: ${loaded.entries.length}`,
        "---",
        "",
        `# TimePoint portable export · ${rangeLabel}`,
        "",
        "Copy the enclosed `TimePoint` folder into any Obsidian vault. Each event is an ordinary Markdown note and each day has an interactive `_Timeline.md` index.",
        "",
        "## Day indexes",
        "",
        ...(dayLinks.length ? dayLinks : ["_No events in this range._"]),
        "",
      ].join("\n"),
    });
    // The human-readable root index is written last so an interrupted write is
    // never mistaken for a complete portable export.
    return { files, primaryPath };
  }

  private async readSnapshotArtifacts(
    ids: readonly string[],
  ): Promise<{ artifacts: SnapshotArtifact[]; errors: string[] }> {
    const artifacts: SnapshotArtifact[] = [];
    const errors: string[] = [];
    for (const id of ids) {
      const folder = `TimePoint/Snapshots/${id}`;
      const markerPath = `${folder}/snapshot.md`;
      const marker = this.vault.getAbstractFileByPath(markerPath);
      if (!(marker instanceof TFile)) {
        errors.push(
          `Portable export requires completed snapshot ${id}, but ${markerPath} is missing.`,
        );
        continue;
      }
      const markdown = await this.vault.cachedRead(marker);
      const snapshot = parseSnapshotMarkdown(markdown, markerPath);
      const normalized = snapshot ? validatePublicHttpsUrl(snapshot.normalizedUrl) : null;
      const original = snapshot ? validatePublicHttpsUrl(snapshot.originalUrl) : null;
      if (
        !snapshot ||
        snapshot.id !== id ||
        !normalized?.ok ||
        normalized.normalizedUrl !== snapshot.normalizedUrl ||
        !original?.ok ||
        original.normalizedUrl !== snapshot.normalizedUrl ||
        (await sha256Hex(snapshot.normalizedUrl)) !== id
      ) {
        errors.push(`Portable export requires valid completed snapshot ${id}.`);
        continue;
      }
      const previewPath = `${folder}/preview.webp`;
      if (snapshot.previewPath && snapshot.previewPath !== previewPath) {
        errors.push(`Portable export snapshot ${id} has an unsafe preview path.`);
        continue;
      }
      const previewFile = snapshot.previewPath
        ? this.vault.getAbstractFileByPath(previewPath)
        : null;
      if (snapshot.previewPath && !(previewFile instanceof TFile)) {
        errors.push(`Portable export snapshot ${id} is missing its completed WebP preview.`);
        continue;
      }
      const preview =
        previewFile instanceof TFile ? await this.vault.readBinary(previewFile) : undefined;
      if (
        preview &&
        (preview.byteLength > MAX_SNAPSHOT_PREVIEW_BYTES ||
          !matchesImageMagic(preview, "image/webp"))
      ) {
        errors.push(`Portable export snapshot ${id} has an invalid WebP preview.`);
        continue;
      }
      artifacts.push({ id, markdown, ...(preview ? { preview } : {}) });
    }
    return { artifacts, errors };
  }

  private nextAvailablePath(preferredPath: string, extension: string): string {
    if (!this.vault.getAbstractFileByPath(preferredPath)) return preferredPath;
    const stem = preferredPath.slice(0, -(extension.length + 1));
    let counter = 2;
    let candidate = `${stem}-${counter}.${extension}`;
    while (this.vault.getAbstractFileByPath(candidate)) {
      counter += 1;
      candidate = `${stem}-${counter}.${extension}`;
    }
    return candidate;
  }

  private nextAvailableFolder(preferredPath: string): string {
    if (!this.vault.getAbstractFileByPath(preferredPath)) return preferredPath;
    let counter = 2;
    let candidate = `${preferredPath}-${counter}`;
    while (this.vault.getAbstractFileByPath(candidate)) {
      counter += 1;
      candidate = `${preferredPath}-${counter}`;
    }
    return candidate;
  }

  private async rollbackCreatedFiles(paths: readonly string[]): Promise<void> {
    for (const path of [...paths].reverse()) {
      const file = this.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        try {
          await this.trashFile(file);
        } catch {
          // Preserve the original export error. A missing root index still marks
          // the portable folder as incomplete if the host filesystem also fails rollback.
        }
      }
    }
  }
}

export function enumerateExportDates(scope: ExportScope): string[] {
  const start = scope.kind === "day" ? scope.date : scope.startDate;
  const end = scope.kind === "day" ? scope.date : scope.endDate;
  if (!isValidDateString(start) || !isValidDateString(end)) {
    throw new Error("Export dates must be real YYYY-MM-DD dates.");
  }
  if (start > end) throw new Error("Export end date must be on or after start date.");
  const dates: string[] = [];
  for (let cursor = start; cursor <= end; cursor = shiftDate(cursor, 1)) {
    dates.push(cursor);
    if (dates.length > MAX_RANGE_DAYS) {
      throw new Error(`Export ranges are limited to ${MAX_RANGE_DAYS} inclusive days.`);
    }
  }
  return dates;
}

function exportScopeLabel(scope: ExportScope): string {
  return scope.kind === "day" ? scope.date : `${scope.startDate}_to_${scope.endDate}`;
}

function formatDiagnostic(date: string, diagnostic: ParseDiagnostic): string {
  const source = diagnostic.sourcePath ? ` in ${diagnostic.sourcePath}` : ` on ${date}`;
  return `${diagnostic.code}${source}: ${diagnostic.message}`;
}

function fingerprint(value: unknown): string {
  const source = JSON.stringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function binaryFingerprint(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return `${bytes.byteLength}:${hash.toString(16).padStart(8, "0")}`;
}

async function ensureFolder(vault: Vault, folder: string): Promise<void> {
  if (!folder) return;
  const segments = normalizePath(folder).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const existing = vault.getAbstractFileByPath(current);
    if (existing) {
      if (!(existing instanceof TFolder)) throw new Error(`${current} exists but is not a folder.`);
      continue;
    }
    await vault.createFolder(current);
  }
}
