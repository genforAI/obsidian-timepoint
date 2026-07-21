import type { TimePointEntry } from "../model/types";
import {
  TIMEPOINT_EXPORT_SCHEMA_VERSION,
  TIMEPOINT_RANGE_SCHEMA_VERSION,
  type ImportIssue,
  type JsonExportOptions,
  type ParsedImport,
  type RangeExportOptions,
} from "./types";
import {
  isValidDate,
  isValidEntryId,
  isValidTime,
  isValidTimestamp,
  minuteOfDay,
  syntheticTimestamp,
  validateEntry,
} from "./validation";

type UnknownRecord = Record<string, unknown>;

export function exportTimePointJson(
  entries: readonly TimePointEntry[],
  options: JsonExportOptions,
): string {
  if (!isValidDate(options.date)) {
    throw new Error(`Cannot export invalid date: ${options.date}`);
  }

  const sorted = entries.map((entry) => {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      throw new Error(`Cannot export entry ${entry.id}: ${problems.join(", ")}`);
    }
    if (entry.date !== options.date) {
      throw new Error(
        `Cannot export entry ${entry.id}: ${entry.date} does not match ${options.date}`,
      );
    }
    return entry;
  });
  sorted.sort(compareEntries);

  const document = {
    schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
    date: options.date,
    ...(options.timezone ? { timezone: options.timezone } : {}),
    entries: sorted.map((entry) => ({
      id: entry.id,
      time: entry.time,
      content: entry.contentMarkdown,
      tags: [...entry.tags],
      ...(entry.timezone ? { timezone: entry.timezone } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Serialize an inclusive, multi-day range without changing the day schema. */
export function exportTimePointRangeJson(
  entries: readonly TimePointEntry[],
  options: RangeExportOptions,
): string {
  assertRange(options);
  const sorted = entries.map((entry) => {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      throw new Error(`Cannot export entry ${entry.id}: ${problems.join(", ")}`);
    }
    if (entry.date < options.startDate || entry.date > options.endDate) {
      throw new Error(
        `Cannot export entry ${entry.id}: ${entry.date} is outside ${options.startDate}…${options.endDate}`,
      );
    }
    return entry;
  });
  sorted.sort(compareRangeEntries);

  return `${JSON.stringify(
    {
      timepointRangeSchema: TIMEPOINT_RANGE_SCHEMA_VERSION,
      startDate: options.startDate,
      endDate: options.endDate,
      entries: sorted.map((entry) => ({
        id: entry.id,
        date: entry.date,
        time: entry.time,
        content: entry.contentMarkdown,
        tags: [...entry.tags],
        ...(entry.timezone ? { timezone: entry.timezone } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    },
    null,
    2,
  )}\n`;
}

export function parseTimePointJson(input: string): ParsedImport {
  if (input.trim().length === 0) {
    return failed({ code: "empty-input", message: "The JSON import is empty." });
  }

  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch (error) {
    return failed({
      code: "invalid-json",
      message: `The JSON import could not be parsed: ${errorMessage(error)}`,
    });
  }

  if (!isRecord(value)) {
    return failed({
      code: "invalid-document",
      message: "The JSON import must contain one object.",
    });
  }

  if (value.timepointRangeSchema !== undefined) {
    return parseRangeJson(value);
  }

  if (value.schemaVersion !== TIMEPOINT_EXPORT_SCHEMA_VERSION) {
    return failed({
      code: "unsupported-schema",
      field: "schemaVersion",
      message: `Unsupported schemaVersion ${String(value.schemaVersion)}; expected ${TIMEPOINT_EXPORT_SCHEMA_VERSION}.`,
    });
  }
  if (typeof value.date !== "string" || !isValidDate(value.date)) {
    return failed({
      code: "invalid-date",
      field: "date",
      message: "The JSON document date must be a real YYYY-MM-DD date.",
    });
  }
  if (!Array.isArray(value.entries)) {
    return failed({
      code: "invalid-document",
      field: "entries",
      message: "The JSON document entries field must be an array.",
    });
  }
  if (value.timezone !== undefined && typeof value.timezone !== "string") {
    return failed({
      code: "invalid-document",
      field: "timezone",
      message: "The JSON document timezone must be a string when provided.",
    });
  }

  const documentDate = value.date;
  const documentTimezone = optionalString(value.timezone);
  const issues: ImportIssue[] = [];
  const entries: TimePointEntry[] = [];
  const seenIds = new Map<string, number>();

  value.entries.forEach((raw, index) => {
    const row = index + 1;
    if (!isRecord(raw)) {
      issues.push({
        code: "invalid-document",
        row,
        message: `Entry ${row} must be an object.`,
      });
      return;
    }

    const normalized = normalizeJsonEntry(raw, documentDate, documentTimezone, row, issues);
    if (normalized) {
      const firstRow = seenIds.get(normalized.id);
      if (firstRow !== undefined) {
        issues.push({
          code: "duplicate-id",
          row,
          field: "id",
          message: `Entry ${row} repeats TimePoint ID ${normalized.id} from entry ${firstRow}; the entire import was blocked before writing.`,
        });
      } else {
        seenIds.set(normalized.id, row);
        entries.push(normalized);
      }
    }
  });

  return {
    schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
    entries,
    issues,
    ok: issues.length === 0,
  };
}

function parseRangeJson(value: UnknownRecord): ParsedImport {
  if (value.timepointRangeSchema !== TIMEPOINT_RANGE_SCHEMA_VERSION) {
    return failed({
      code: "unsupported-schema",
      field: "timepointRangeSchema",
      message: `Unsupported timepointRangeSchema ${String(value.timepointRangeSchema)}; expected ${TIMEPOINT_RANGE_SCHEMA_VERSION}.`,
    });
  }
  if (typeof value.startDate !== "string" || !isValidDate(value.startDate)) {
    return failed({
      code: "invalid-date",
      field: "startDate",
      message: "The JSON range startDate must be a real YYYY-MM-DD date.",
    });
  }
  if (typeof value.endDate !== "string" || !isValidDate(value.endDate)) {
    return failed({
      code: "invalid-date",
      field: "endDate",
      message: "The JSON range endDate must be a real YYYY-MM-DD date.",
    });
  }
  if (value.startDate > value.endDate) {
    return failed({
      code: "invalid-date",
      field: "endDate",
      message: "The JSON range endDate must be on or after startDate.",
    });
  }
  if (!Array.isArray(value.entries)) {
    return failed({
      code: "invalid-document",
      field: "entries",
      message: "The JSON range entries field must be an array.",
    });
  }

  const startDate = value.startDate;
  const endDate = value.endDate;
  const issues: ImportIssue[] = [];
  const entries: TimePointEntry[] = [];
  const seenIds = new Map<string, number>();
  value.entries.forEach((raw, index) => {
    const row = index + 1;
    if (!isRecord(raw)) {
      issues.push({ code: "invalid-document", row, message: `Entry ${row} must be an object.` });
      return;
    }
    if (typeof raw.date !== "string" || !isValidDate(raw.date)) {
      issues.push({
        code: "invalid-date",
        row,
        field: "date",
        message: `Entry ${row} must include a real YYYY-MM-DD date.`,
      });
      return;
    }
    if (raw.date < startDate || raw.date > endDate) {
      issues.push({
        code: "date-mismatch",
        row,
        field: "date",
        message: `Entry ${row} date ${raw.date} is outside ${startDate}…${endDate}.`,
      });
      return;
    }
    const normalized = normalizeJsonEntry(raw, raw.date, undefined, row, issues);
    if (!normalized) return;
    const firstRow = seenIds.get(normalized.id);
    if (firstRow !== undefined) {
      issues.push({
        code: "duplicate-id",
        row,
        field: "id",
        message: `Entry ${row} repeats TimePoint ID ${normalized.id} from entry ${firstRow}; the entire import was blocked before writing.`,
      });
      return;
    }
    seenIds.set(normalized.id, row);
    entries.push(normalized);
  });
  entries.sort(compareRangeEntries);
  return {
    schemaVersion: TIMEPOINT_RANGE_SCHEMA_VERSION,
    entries,
    issues,
    ok: issues.length === 0,
  };
}

function normalizeJsonEntry(
  raw: UnknownRecord,
  documentDate: string,
  documentTimezone: string | undefined,
  row: number,
  issues: ImportIssue[],
): TimePointEntry | undefined {
  const issueStart = issues.length;
  const date = raw.date === undefined ? documentDate : raw.date;
  const id = raw.id;
  const time = raw.time;
  const content = raw.contentMarkdown ?? raw.content;

  if (typeof date !== "string" || !isValidDate(date)) {
    issues.push({
      code: "invalid-date",
      row,
      field: "date",
      message: `Entry ${row} has an invalid date.`,
    });
  } else if (date !== documentDate) {
    issues.push({
      code: "date-mismatch",
      row,
      field: "date",
      message: `Entry ${row} date ${date} does not match document date ${documentDate}.`,
    });
  }
  if (typeof id !== "string" || !isValidEntryId(id)) {
    issues.push({
      code: "invalid-id",
      row,
      field: "id",
      message: `Entry ${row} must have a safe, non-empty TimePoint ID.`,
    });
  }
  if (typeof time !== "string" || !isValidTime(time)) {
    issues.push({
      code: "invalid-time",
      row,
      field: "time",
      message: `Entry ${row} time must be between 00:00 and 23:59.`,
    });
  }
  if (typeof content !== "string") {
    issues.push({
      code: "invalid-content",
      row,
      field: "content",
      message: `Entry ${row} content must be a string.`,
    });
  }
  if (
    raw.tags !== undefined &&
    (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string"))
  ) {
    issues.push({
      code: "invalid-tags",
      row,
      field: "tags",
      message: `Entry ${row} tags must be an array of strings.`,
    });
  }
  if (raw.timezone !== undefined && typeof raw.timezone !== "string") {
    issues.push({
      code: "invalid-document",
      row,
      field: "timezone",
      message: `Entry ${row} timezone must be a string when provided.`,
    });
  }
  if (raw.source !== undefined && typeof raw.source !== "string") {
    issues.push({
      code: "invalid-document",
      row,
      field: "source",
      message: `Entry ${row} source must be a string when provided.`,
    });
  }

  const fallbackTimestamp =
    typeof date === "string" && typeof time === "string" && isValidDate(date) && isValidTime(time)
      ? syntheticTimestamp(date, time)
      : "";
  const createdAt = raw.createdAt ?? fallbackTimestamp;
  const updatedAt = raw.updatedAt ?? createdAt;
  if (typeof createdAt !== "string" || !isValidTimestamp(createdAt)) {
    issues.push({
      code: "invalid-timestamp",
      row,
      field: "createdAt",
      message: `Entry ${row} createdAt must be a valid timestamp when provided.`,
    });
  }
  if (typeof updatedAt !== "string" || !isValidTimestamp(updatedAt)) {
    issues.push({
      code: "invalid-timestamp",
      row,
      field: "updatedAt",
      message: `Entry ${row} updatedAt must be a valid timestamp when provided.`,
    });
  }

  if (issues.length !== issueStart) return undefined;

  const safeDate = date as string;
  const safeTime = time as string;
  return {
    id: id as string,
    date: safeDate,
    time: safeTime,
    minuteOfDay: minuteOfDay(safeTime),
    timezone: optionalString(raw.timezone) ?? documentTimezone,
    contentMarkdown: content as string,
    tags: raw.tags === undefined ? [] : [...(raw.tags as string[])],
    source: optionalString(raw.source) ?? "import-json",
    createdAt: createdAt as string,
    updatedAt: updatedAt as string,
  };
}

function failed(issue: ImportIssue): ParsedImport {
  return {
    schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
    entries: [],
    issues: [issue],
    ok: false,
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareEntries(a: TimePointEntry, b: TimePointEntry): number {
  return a.minuteOfDay - b.minuteOfDay || a.id.localeCompare(b.id);
}

function compareRangeEntries(a: TimePointEntry, b: TimePointEntry): number {
  return a.date.localeCompare(b.date) || compareEntries(a, b);
}

function assertRange(options: RangeExportOptions): void {
  if (!isValidDate(options.startDate) || !isValidDate(options.endDate)) {
    throw new Error(`Cannot export invalid date range: ${options.startDate}…${options.endDate}`);
  }
  if (options.startDate > options.endDate) {
    throw new Error("Cannot export a range whose end date precedes its start date.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
