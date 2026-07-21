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
  serializeDayIndex,
  serializeStandaloneEntry,
  type DayFileRepository,
} from "../storage";
import { isValidDateString, shiftDate } from "../utils/time";

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
  preview: ExportPreview;
}

interface PendingFile {
  path: string;
  content: string;
}

const MAX_RANGE_DAYS = 366;
const MAX_COPYABLE_BYTES = 2 * 1024 * 1024;

export class ExportService {
  constructor(
    private readonly vault: Vault,
    private readonly repository: DayFileRepository,
    private readonly getExportFolder: () => string,
    private readonly trashFile: (file: TFile) => Promise<void>,
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

    const output = this.prepareOutput(request, loaded);
    const created: string[] = [];
    try {
      for (const file of output.files) {
        await ensureFolder(this.vault, parentPath(file.path));
        if (this.vault.getAbstractFileByPath(file.path)) {
          throw new Error(
            `Export target ${file.path} appeared after preview; no partial result was kept.`,
          );
        }
        await this.vault.create(file.path, file.content);
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
      ...(onlyFile && utf8ByteLength(onlyFile.content) <= MAX_COPYABLE_BYTES
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
      })),
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
    return { dates, days, entries, preview };
  }

  private prepareOutput(
    request: ExportRequest,
    loaded: LoadedRange,
  ): { files: PendingFile[]; primaryPath: string } {
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
    for (const day of loaded.days) {
      if (!day.date || day.entries.length === 0) continue;
      const [year, month] = day.date.split("-");
      if (!year || !month) throw new Error(`Invalid loaded date ${day.date}.`);
      const dayFolder = normalizePath(`${root}/TimePoint/Days/${year}/${month}/${day.date}`);
      for (const entry of day.entries) {
        files.push({
          path: normalizePath(`${dayFolder}/${entryFileName(entry)}`),
          content: serializeStandaloneEntry(entry),
        });
      }
      const indexPath = normalizePath(`${dayFolder}/${DAY_INDEX_BASENAME}.md`);
      files.push({
        path: indexPath,
        content: serializeDayIndex(day.date, day.entries, day.timezone),
      });
      dayLinks.push(
        `- [${day.date}](TimePoint/Days/${year}/${month}/${day.date}/${DAY_INDEX_BASENAME}.md)`,
      );
    }
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
