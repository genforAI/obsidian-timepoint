import type { TimePointEntry } from "../model/types";
import { parseStandaloneEntry } from "../storage/StandaloneEntryFile";
import { parseDayFile } from "../storage/TimePointParser";
import {
  TIMEPOINT_EXPORT_SCHEMA_VERSION,
  TIMEPOINT_RANGE_SCHEMA_VERSION,
  type ImportIssue,
  type JsonExportOptions,
  type ParsedImport,
  type RangeExportOptions,
} from "./types";
import { isValidDate, validateEntry } from "./validation";

/**
 * Produces a portable day file using the same visible-heading + hidden-metadata
 * shape as TimePoint storage. It intentionally stores no pixel/layout state.
 */
export function exportTimePointMarkdown(
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
  sorted.sort((a, b) => a.minuteOfDay - b.minuteOfDay || a.id.localeCompare(b.id));

  const frontmatter = [
    "---",
    `timepoint-schema: ${TIMEPOINT_EXPORT_SCHEMA_VERSION}`,
    `date: ${options.date}`,
    ...(options.timezone ? [`timezone: ${JSON.stringify(options.timezone)}`] : []),
    "---",
  ].join("\n");
  const blocks = sorted.map((entry) => {
    const metadata = {
      schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
      id: entry.id,
      date: entry.date,
      time: entry.time,
      ...(entry.timezone ? { timezone: entry.timezone } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      tags: [...entry.tags],
      ...(entry.source ? { source: entry.source } : {}),
    };
    const content = entry.contentMarkdown.replace(/\s+$/u, "");
    return [
      `<!-- timepoint:entry:start id="${entry.id}" -->`,
      `## ${entry.time} ^${entry.id}`,
      "",
      "<!-- timepoint",
      JSON.stringify(metadata, null, 2),
      "-->",
      ...(content ? ["", content] : []),
      "",
      `<!-- timepoint:entry:end id="${entry.id}" -->`,
    ].join("\n");
  });

  return `${frontmatter}${blocks.length ? `\n\n${blocks.join("\n\n")}` : ""}\n`;
}

/**
 * A range is a small manifest around complete, independently parseable day
 * documents. This preserves exact single-day compatibility and makes recovery
 * possible even when a user manually splits the exported file.
 */
export function exportTimePointRangeMarkdown(
  entries: readonly TimePointEntry[],
  options: RangeExportOptions,
): string {
  assertRange(options);
  const byDate = new Map<string, TimePointEntry[]>();
  for (const entry of entries) {
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      throw new Error(`Cannot export entry ${entry.id}: ${problems.join(", ")}`);
    }
    if (entry.date < options.startDate || entry.date > options.endDate) {
      throw new Error(
        `Cannot export entry ${entry.id}: ${entry.date} is outside ${options.startDate}…${options.endDate}`,
      );
    }
    if (/<!--\s*timepoint:range-day:/iu.test(entry.contentMarkdown)) {
      throw new Error(
        `Cannot export entry ${entry.id}: content contains a reserved TimePoint range boundary marker.`,
      );
    }
    const dateEntries = byDate.get(entry.date) ?? [];
    dateEntries.push(entry);
    byDate.set(entry.date, dateEntries);
  }

  const blocks = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dateEntries]) => {
      const document = exportTimePointMarkdown(dateEntries, { date }).trimEnd();
      return [
        `<!-- timepoint:range-day:start date="${date}" -->`,
        document,
        `<!-- timepoint:range-day:end date="${date}" -->`,
      ].join("\n");
    });
  return [
    "---",
    `timepoint-range-schema: ${TIMEPOINT_RANGE_SCHEMA_VERSION}`,
    `startDate: ${options.startDate}`,
    `endDate: ${options.endDate}`,
    `eventCount: ${entries.length}`,
    "---",
    "",
    `# TimePoint · ${options.startDate} – ${options.endDate}`,
    ...(blocks.length ? ["", blocks.join("\n\n")] : []),
    "",
  ].join("\n");
}

/** Parse either one portable event note or a complete legacy/day Markdown export. */
export function parseTimePointMarkdown(input: string): ParsedImport {
  if (!input.trim()) return failedMarkdown("The Markdown import is empty.");

  if (/^---\r?\n[\s\S]*?^timepoint-range-schema:/mu.test(input)) {
    return parseRangeMarkdown(input);
  }

  if (/^---\r?\n[\s\S]*?^timepoint-entry-schema:/mu.test(input)) {
    const parsed = parseStandaloneEntry(input);
    const issues = parsed.diagnostics.map(diagnosticToImportIssue);
    if (!parsed.entry && issues.length === 0) {
      issues.push({
        code: "invalid-markdown",
        message: "The Markdown does not contain a valid portable TimePoint event.",
      });
    }
    return {
      schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
      entries: parsed.entry ? [parsed.entry] : [],
      issues,
      ok: Boolean(parsed.entry) && issues.length === 0,
    };
  }

  const parsed = parseDayFile(input);
  const issues = parsed.diagnostics.map(diagnosticToImportIssue);
  if (!parsed.date && issues.length === 0) {
    issues.push({
      code: "invalid-markdown",
      message: "The Markdown does not contain a TimePoint day or portable event.",
    });
  }
  return {
    schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
    entries: parsed.entries,
    issues,
    ok: Boolean(parsed.date) && issues.length === 0,
  };
}

function parseRangeMarkdown(input: string): ParsedImport {
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(input);
  if (!header) return failedMarkdown("The Markdown range has no closed YAML frontmatter.");
  const fields = new Map<string, string>();
  for (const line of (header[1] ?? "").split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
  }
  const schema = Number(fields.get("timepoint-range-schema"));
  if (schema !== TIMEPOINT_RANGE_SCHEMA_VERSION) {
    return failedMarkdown(
      `Unsupported timepoint-range-schema ${String(fields.get("timepoint-range-schema"))}; expected ${TIMEPOINT_RANGE_SCHEMA_VERSION}.`,
      "unsupported-schema",
    );
  }
  const startDate = fields.get("startDate") ?? "";
  const endDate = fields.get("endDate") ?? "";
  if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
    return failedMarkdown(
      "The Markdown range must contain a valid inclusive date range.",
      "invalid-date",
    );
  }
  const expectedEntryCount = Number(fields.get("eventCount"));
  if (!Number.isInteger(expectedEntryCount) || expectedEntryCount < 0) {
    return failedMarkdown(
      "The Markdown range must declare a non-negative integer eventCount.",
      "invalid-document",
    );
  }

  const entries: TimePointEntry[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  const blockPattern =
    /<!-- timepoint:range-day:start date="([0-9]{4}-[0-9]{2}-[0-9]{2})" -->\r?\n([\s\S]*?)\r?\n<!-- timepoint:range-day:end date="\1" -->/gu;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(input)) !== null) {
    const date = match[1] ?? "";
    const document = match[2] ?? "";
    if (date < startDate || date > endDate) {
      issues.push({
        code: "date-mismatch",
        message: `Range day ${date} is outside ${startDate}…${endDate}.`,
      });
      continue;
    }
    const parsed = parseDayFile(document, { expectedDate: date });
    issues.push(...parsed.diagnostics.map(diagnosticToImportIssue));
    for (const entry of parsed.entries) {
      if (seen.has(entry.id)) {
        issues.push({
          code: "duplicate-id",
          field: "id",
          message: `TimePoint ID ${entry.id} appears more than once in the range; the entire import was blocked before writing.`,
        });
      } else {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
  }
  if (entries.length !== expectedEntryCount) {
    issues.push({
      code: "invalid-markdown",
      message: `The Markdown range declared ${expectedEntryCount} events but contained ${entries.length} valid events.`,
    });
  }
  entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.minuteOfDay - b.minuteOfDay || a.id.localeCompare(b.id),
  );
  return {
    schemaVersion: TIMEPOINT_RANGE_SCHEMA_VERSION,
    entries,
    issues,
    ok: issues.length === 0,
  };
}

function diagnosticToImportIssue(diagnostic: {
  code: string;
  message: string;
  line?: number;
}): ImportIssue {
  return {
    code: "invalid-markdown",
    message: `${diagnostic.code}: ${diagnostic.message}`,
    ...(diagnostic.line ? { row: diagnostic.line } : {}),
  };
}

function failedMarkdown(message: string, code: ImportIssue["code"] = "empty-input"): ParsedImport {
  return {
    schemaVersion: TIMEPOINT_EXPORT_SCHEMA_VERSION,
    entries: [],
    issues: [{ code, message }],
    ok: false,
  };
}

function assertRange(options: RangeExportOptions): void {
  if (!isValidDate(options.startDate) || !isValidDate(options.endDate)) {
    throw new Error(`Cannot export invalid date range: ${options.startDate}…${options.endDate}`);
  }
  if (options.startDate > options.endDate) {
    throw new Error("Cannot export a range whose end date precedes its start date.");
  }
}
