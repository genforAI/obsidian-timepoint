import type { TimePointEntry } from "../model/types";
import { parseSnapshotIds, sanitizeCardLayout } from "../storage/CardLayoutMetadata";
import { TIMEPOINT_EXPORT_SCHEMA_VERSION, type ImportIssue, type ParsedImport } from "./types";
import {
  isValidDate,
  isValidEntryId,
  isValidTime,
  isValidTimestamp,
  minuteOfDay,
  syntheticTimestamp,
  validateEntry,
} from "./validation";

const CSV_COLUMNS = [
  "date",
  "time",
  "id",
  "content",
  "tags",
  "timezone",
  "source",
  "createdAt",
  "updatedAt",
  "cardSchema",
  "cardX",
  "cardY",
  "cardWidth",
  "cardHeight",
  "cardUpdatedAt",
  "linkSnapshotIds",
] as const;

export class CsvSyntaxError extends Error {
  constructor(
    message: string,
    readonly row: number,
  ) {
    super(message);
    this.name = "CsvSyntaxError";
  }
}

export function exportTimePointCsv(entries: readonly TimePointEntry[]): string {
  const sorted = entries.map((entry) => {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      throw new Error(`Cannot export entry ${entry.id}: ${problems.join(", ")}`);
    }
    return entry;
  });
  sorted.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.minuteOfDay - b.minuteOfDay || a.id.localeCompare(b.id),
  );

  const rows: string[][] = [
    [...CSV_COLUMNS],
    ...sorted.map((entry) => [
      entry.date,
      entry.time,
      entry.id,
      entry.contentMarkdown,
      JSON.stringify(entry.tags),
      entry.timezone ?? "",
      entry.source ?? "",
      entry.createdAt,
      entry.updatedAt,
      entry.cardLayout ? String(entry.cardLayout.schemaVersion) : "",
      entry.cardLayout ? String(entry.cardLayout.x) : "",
      entry.cardLayout ? String(entry.cardLayout.y) : "",
      entry.cardLayout ? String(entry.cardLayout.width) : "",
      entry.cardLayout ? String(entry.cardLayout.height) : "",
      entry.cardLayout?.updatedAt ?? "",
      entry.linkSnapshotIds?.length
        ? JSON.stringify([...new Set(entry.linkSnapshotIds)].sort())
        : "",
    ]),
  ];
  return `${rows.map((row) => row.map(escapeCsvField).join(",")).join("\r\n")}\r\n`;
}

export function parseTimePointCsv(input: string): ParsedImport {
  if (input.length === 0 || input.trim().length === 0) {
    return failed({ code: "empty-input", message: "The CSV import is empty." });
  }

  let records: string[][];
  try {
    records = parseCsvRecords(input);
  } catch (error) {
    const csvError = error instanceof CsvSyntaxError ? error : undefined;
    return failed({
      code: "invalid-csv",
      message: error instanceof Error ? error.message : String(error),
      row: csvError?.row,
    });
  }

  while (records.length > 0 && isEmptyRecord(records.at(-1) ?? [])) records.pop();
  if (records.length === 0) {
    return failed({ code: "empty-input", message: "The CSV import is empty." });
  }

  const header = [...(records[0] ?? [])];
  if (header[0]?.charCodeAt(0) === 0xfeff) header[0] = header[0].slice(1);
  const normalizedHeader = header.map((name) => name.trim());
  const duplicate = normalizedHeader.find(
    (name, index) => normalizedHeader.indexOf(name) !== index,
  );
  if (duplicate !== undefined) {
    return failed({
      code: "duplicate-header",
      field: duplicate,
      message: `CSV header ${duplicate} appears more than once.`,
    });
  }

  const required = ["date", "time", "id", "content"];
  const missing = required.find((name) => !normalizedHeader.includes(name));
  if (missing) {
    return failed({
      code: "missing-field",
      field: missing,
      message: `CSV is missing required column ${missing}.`,
    });
  }

  const issues: ImportIssue[] = [];
  const entries: TimePointEntry[] = [];
  const seenIds = new Map<string, number>();
  records.slice(1).forEach((record, index) => {
    const row = index + 2;
    if (isEmptyRecord(record)) return;
    if (record.length !== normalizedHeader.length) {
      issues.push({
        code: "column-count",
        row,
        message: `CSV row ${row} has ${record.length} fields; expected ${normalizedHeader.length}.`,
      });
      return;
    }

    const values = Object.fromEntries(
      normalizedHeader.map((name, column) => [name, record[column] ?? ""]),
    );
    const entry = normalizeCsvEntry(values, row, issues);
    if (entry) {
      const firstRow = seenIds.get(entry.id);
      if (firstRow !== undefined) {
        issues.push({
          code: "duplicate-id",
          row,
          field: "id",
          message: `CSV row ${row} repeats TimePoint ID ${entry.id} from row ${firstRow}; the entire import was blocked before writing.`,
        });
      } else {
        seenIds.set(entry.id, row);
        entries.push(entry);
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

/** A small strict RFC 4180-style parser, including quoted newlines and `""` escapes. */
export function parseCsvRecords(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let row = 1;

  const endField = (): void => {
    record.push(field);
    field = "";
    afterQuote = false;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    row += 1;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === ",") {
        endField();
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && input[index + 1] === "\n") index += 1;
        endRecord();
      } else {
        throw new CsvSyntaxError(
          `Unexpected character after closing quote on CSV row ${row}.`,
          row,
        );
      }
      continue;
    }

    if (character === '"') {
      if (field.length !== 0) {
        throw new CsvSyntaxError(`Unexpected quote on CSV row ${row}.`, row);
      }
      inQuotes = true;
    } else if (character === ",") {
      endField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      endRecord();
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new CsvSyntaxError(`Unclosed quoted field on CSV row ${row}.`, row);
  }
  if (record.length > 0 || field.length > 0 || afterQuote) endRecord();
  return records;
}

function normalizeCsvEntry(
  values: Record<string, string>,
  row: number,
  issues: ImportIssue[],
): TimePointEntry | undefined {
  const issueStart = issues.length;
  const date = values.date ?? "";
  const time = values.time ?? "";
  const id = values.id ?? "";
  const content = values.content ?? "";

  if (!isValidDate(date)) {
    issues.push({
      code: "invalid-date",
      row,
      field: "date",
      message: `CSV row ${row} date must be a real YYYY-MM-DD date.`,
    });
  }
  if (!isValidTime(time)) {
    issues.push({
      code: "invalid-time",
      row,
      field: "time",
      message: `CSV row ${row} time must be between 00:00 and 23:59.`,
    });
  }
  if (!isValidEntryId(id)) {
    issues.push({
      code: "invalid-id",
      row,
      field: "id",
      message: `CSV row ${row} has an invalid TimePoint ID.`,
    });
  }

  const schemaVersion = values.schemaVersion;
  if (
    schemaVersion !== undefined &&
    schemaVersion.length > 0 &&
    Number(schemaVersion) !== TIMEPOINT_EXPORT_SCHEMA_VERSION
  ) {
    issues.push({
      code: "unsupported-schema",
      row,
      field: "schemaVersion",
      message: `CSV row ${row} has unsupported schemaVersion ${schemaVersion}.`,
    });
  }

  const tags = parseTags(values.tags ?? "", row, issues);
  const fallbackTimestamp =
    isValidDate(date) && isValidTime(time) ? syntheticTimestamp(date, time) : "";
  const createdAt = values.createdAt || fallbackTimestamp;
  const updatedAt = values.updatedAt || createdAt;
  if (!isValidTimestamp(createdAt)) {
    issues.push({
      code: "invalid-timestamp",
      row,
      field: "createdAt",
      message: `CSV row ${row} createdAt must be a valid timestamp when provided.`,
    });
  }
  if (!isValidTimestamp(updatedAt)) {
    issues.push({
      code: "invalid-timestamp",
      row,
      field: "updatedAt",
      message: `CSV row ${row} updatedAt must be a valid timestamp when provided.`,
    });
  }
  if (issues.length !== issueStart) return undefined;

  const cardLayout = sanitizeCardLayout({
    schemaVersion: values.cardSchema,
    x: values.cardX,
    y: values.cardY,
    width: values.cardWidth,
    height: values.cardHeight,
    updatedAt: values.cardUpdatedAt,
  });
  const linkSnapshotIds = parseCsvSnapshotIds(values.linkSnapshotIds);

  return {
    id,
    date,
    time,
    minuteOfDay: minuteOfDay(time),
    timezone: nonEmpty(values.timezone),
    contentMarkdown: content,
    tags,
    source: nonEmpty(values.source) ?? "import-csv",
    createdAt,
    updatedAt,
    ...(cardLayout ? { cardLayout } : {}),
    ...(linkSnapshotIds.length ? { linkSnapshotIds } : {}),
  };
}

function parseCsvSnapshotIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    return parseSnapshotIds(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function parseTags(value: string, row: number, issues: ImportIssue[]): string[] {
  if (value.trim().length === 0) return [];
  if (value.trimStart().startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")) {
        return [...parsed];
      }
    } catch {
      // A precise issue is emitted below.
    }
    issues.push({
      code: "invalid-tags",
      row,
      field: "tags",
      message: `CSV row ${row} tags must be a JSON string array or a comma/semicolon list.`,
    });
    return [];
  }
  return value
    .split(/[;,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function isEmptyRecord(record: readonly string[]): boolean {
  return record.every((field) => field.trim().length === 0);
}

function failed(issue: ImportIssue): ParsedImport {
  return {
    schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
    entries: [],
    issues: [issue],
    ok: false,
  };
}
