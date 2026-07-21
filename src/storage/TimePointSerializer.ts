import {
  TIMEPOINT_SCHEMA_VERSION,
  type EntryMutationExpectation,
  type NewTimePointEntryInput,
  type ParsedDayFile,
  type TimePointEntry,
} from "../model/types";
import { isValidDateString, isValidStoredTime, timeToMinuteOfDay } from "../utils/time";
import { getStandaloneEntrySnapshot } from "./StandaloneEntryFile";
import { getEntrySourceBlockSnapshot, locateEntryBlocks, parseDayFile } from "./TimePointParser";

export const ENTRY_START_PREFIX = "<!-- timepoint:entry:start";
export const ENTRY_END_PREFIX = "<!-- timepoint:entry:end";

const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const RESERVED_MARKER_LINE = /^[ \t]*<!--\s*timepoint:entry:(?:start|end)\b.*-->[ \t]*$/;

export type StorageMutationErrorCode =
  | "INVALID_ENTRY"
  | "DUPLICATE_ID"
  | "ENTRY_NOT_FOUND"
  | "DATE_MISMATCH"
  | "UNSUPPORTED_SCHEMA"
  | "CONFLICT"
  | "AMBIGUOUS_ENTRY";

export class StorageMutationError extends Error {
  constructor(
    public readonly code: StorageMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StorageMutationError";
  }
}

/**
 * Binds a mutation to both the complete normalized entry and its exact source
 * block when the entry originated in parseDayFile().
 */
export function createEntryMutationExpectation(entry: TimePointEntry): EntryMutationExpectation {
  const expectedSourceBlock =
    getStandaloneEntrySnapshot(entry) ?? getEntrySourceBlockSnapshot(entry);
  return {
    expectedEntry: { ...entry, tags: [...entry.tags] },
    ...(expectedSourceBlock !== undefined ? { expectedSourceBlock } : {}),
  };
}

export function createTimePointEntry(input: NewTimePointEntryInput): TimePointEntry {
  assertDate(input.date);
  assertTime(input.time);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;
  assertTimestamp(createdAt, "createdAt");
  assertTimestamp(updatedAt, "updatedAt");

  const id = input.id ?? generateTimePointId(input.date, input.time);
  assertEntryId(id);
  assertSafeOptionalText(input.timezone, "timezone");
  assertSafeOptionalText(input.source, "source");
  assertContent(input.contentMarkdown);

  return {
    id,
    date: input.date,
    time: input.time,
    minuteOfDay: timeToMinuteOfDay(input.time),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    contentMarkdown: input.contentMarkdown,
    tags: normalizeTags(input.tags ?? []),
    ...(input.source ? { source: input.source } : { source: "manual" }),
    createdAt,
    updatedAt,
  };
}

export function generateTimePointId(date: string, time: string, token?: string): string {
  assertDate(date);
  assertTime(time);
  const suffix = token === undefined ? randomToken() : normalizeIdToken(token);
  const id = `tp-${date.replaceAll("-", "")}-${time.replace(":", "")}00-${suffix}`;
  assertEntryId(id);
  return id;
}

export function serializeDayFile(
  date: string,
  timezone?: string,
  entries: readonly TimePointEntry[] = [],
): string {
  assertDate(date);
  assertSafeOptionalText(timezone, "timezone");
  for (const entry of entries) {
    validateEntry(entry);
    if (entry.date !== date) {
      throw new StorageMutationError(
        "DATE_MISMATCH",
        `Entry ${entry.id} belongs to ${entry.date}, not ${date}.`,
      );
    }
  }

  const frontmatter = [
    "---",
    `timepoint-schema: ${TIMEPOINT_SCHEMA_VERSION}`,
    `date: ${date}`,
    ...(timezone ? [`timezone: ${JSON.stringify(timezone)}`] : []),
    "---",
    "",
    `# TimePoint — ${date}`,
  ].join("\n");
  if (entries.length === 0) return `${frontmatter}\n`;

  const blocks = [...entries]
    .sort((left, right) => left.minuteOfDay - right.minuteOfDay || left.id.localeCompare(right.id))
    .map((entry) => serializeEntry(entry));
  return `${frontmatter}\n\n${blocks.join("\n\n")}\n`;
}

export function serializeEntry(entry: TimePointEntry, eol = "\n"): string {
  validateEntry(entry);
  if (eol !== "\n" && eol !== "\r\n") {
    throw new StorageMutationError("INVALID_ENTRY", "Entry line ending must be LF or CRLF.");
  }

  const metadata = {
    schemaVersion: TIMEPOINT_SCHEMA_VERSION,
    id: entry.id,
    date: entry.date,
    time: entry.time,
    ...(entry.timezone ? { timezone: entry.timezone } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: normalizeTags(entry.tags),
    ...(entry.source ? { source: entry.source } : {}),
  };
  const content = entry.contentMarkdown
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\n+|\n+$/g, "");
  const lines = [
    `<!-- timepoint:entry:start id="${entry.id}" -->`,
    `## ${entry.time} ^${entry.id}`,
    "",
    "<!-- timepoint",
    JSON.stringify(metadata, null, 2).replaceAll("\n", eol),
    "-->",
    "",
    ...(content.length > 0 ? [content, ""] : []),
    `<!-- timepoint:entry:end id="${entry.id}" -->`,
  ];
  return lines.join("\n").replace(/\n/g, eol);
}

/** Appends one managed block without rewriting any existing Markdown. */
export function addEntryToMarkdown(markdown: string, entry: TimePointEntry): string {
  validateEntry(entry);
  parseMutationTarget(markdown, entry.date);
  const scan = locateEntryBlocks(markdown);
  if (scan.markerIds.includes(entry.id)) {
    throw new StorageMutationError("DUPLICATE_ID", `Entry ${entry.id} already exists.`);
  }

  const eol = detectLineEnding(markdown);
  const separator =
    markdown.length === 0
      ? ""
      : markdown.endsWith(`${eol}${eol}`)
        ? ""
        : markdown.endsWith(eol)
          ? eol
          : `${eol}${eol}`;
  return `${markdown}${separator}${serializeEntry(entry, eol)}${eol}`;
}

/** Replaces only the explicitly bounded block for `entry.id`. */
export function updateEntryInMarkdown(
  markdown: string,
  entry: TimePointEntry,
  expectation: EntryMutationExpectation = {},
): string {
  validateEntry(entry);
  const parsed = parseMutationTarget(markdown, entry.date);
  const block = requireSingleBlock(markdown, entry.id);
  assertExpectation(
    parsed.entries.find((candidate) => candidate.id === entry.id),
    expectation,
    entry.id,
    markdown.slice(block.start, block.end),
  );

  const replacement = serializeEntry(entry, detectLineEnding(markdown));
  return markdown.slice(0, block.start) + replacement + markdown.slice(block.end);
}

/** Removes only the explicitly bounded block for `id`. */
export function deleteEntryFromMarkdown(
  markdown: string,
  date: string,
  id: string,
  expectation: EntryMutationExpectation = {},
): string {
  assertDate(date);
  assertEntryId(id);
  const parsed = parseMutationTarget(markdown, date);
  const block = requireSingleBlock(markdown, id);
  assertExpectation(
    parsed.entries.find((candidate) => candidate.id === id),
    expectation,
    id,
    markdown.slice(block.start, block.end),
  );
  return markdown.slice(0, block.start) + markdown.slice(block.end);
}

/**
 * Mutations may conservatively preserve malformed current-schema files, but a
 * file written by a newer TimePoint schema is never modified. We cannot know
 * which bytes or invariants that future schema owns.
 */
function parseMutationTarget(markdown: string, date: string): ParsedDayFile {
  const parsed = parseDayFile(markdown, { expectedDate: date });
  const futureSchemaDiagnostic = parsed.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error" && diagnostic.code === "UNSUPPORTED_SCHEMA",
  );
  if (
    (parsed.schemaVersion !== undefined && parsed.schemaVersion > TIMEPOINT_SCHEMA_VERSION) ||
    futureSchemaDiagnostic
  ) {
    throw new StorageMutationError(
      "UNSUPPORTED_SCHEMA",
      `${futureSchemaDiagnostic?.message ?? `Day file schema ${parsed.schemaVersion} is newer than supported schema ${TIMEPOINT_SCHEMA_VERSION}.`} Refusing to modify the day file.`,
    );
  }
  const unknownMetadataDiagnostic = parsed.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error" && diagnostic.code === "UNKNOWN_METADATA_FIELD",
  );
  if (unknownMetadataDiagnostic) {
    throw new StorageMutationError(
      "CONFLICT",
      `${unknownMetadataDiagnostic.message} Refusing to modify the day file.`,
    );
  }
  if (parsed.diagnostics.some((diagnostic) => diagnostic.code === "DATE_MISMATCH")) {
    throw new StorageMutationError("DATE_MISMATCH", `The target file does not belong to ${date}.`);
  }
  return parsed;
}

export function validateEntry(entry: TimePointEntry): void {
  assertEntryId(entry.id);
  assertDate(entry.date);
  assertTime(entry.time);
  if (!Number.isInteger(entry.minuteOfDay) || entry.minuteOfDay !== timeToMinuteOfDay(entry.time)) {
    throw new StorageMutationError(
      "INVALID_ENTRY",
      `Entry ${entry.id} minuteOfDay does not match ${entry.time}.`,
    );
  }
  assertTimestamp(entry.createdAt, "createdAt");
  assertTimestamp(entry.updatedAt, "updatedAt");
  assertSafeOptionalText(entry.timezone, "timezone");
  assertSafeOptionalText(entry.source, "source");
  assertContent(entry.contentMarkdown);
  if (
    !Array.isArray(entry.tags) ||
    entry.tags.some((tag) => typeof tag !== "string" || tag.includes("-->"))
  ) {
    throw new StorageMutationError(
      "INVALID_ENTRY",
      `Entry ${entry.id} tags must be strings without an HTML comment terminator.`,
    );
  }
}

function requireSingleBlock(markdown: string, id: string) {
  const scan = locateEntryBlocks(markdown);
  const matches = scan.blocks.filter((block) => block.id === id);
  if (matches.length === 0)
    throw new StorageMutationError("ENTRY_NOT_FOUND", `Entry ${id} was not found.`);
  if (matches.length > 1 || scan.markerIds.filter((markerId) => markerId === id).length !== 2) {
    throw new StorageMutationError(
      "AMBIGUOUS_ENTRY",
      `Entry ${id} occurs more than once or has unpaired markers; refusing to modify an ambiguous file.`,
    );
  }
  const block = matches[0];
  if (!block) throw new StorageMutationError("ENTRY_NOT_FOUND", `Entry ${id} was not found.`);
  return block;
}

function assertExpectation(
  current: TimePointEntry | undefined,
  expectation: EntryMutationExpectation,
  id: string,
  currentSourceBlock: string,
): void {
  if (Object.keys(expectation).length === 0) return;
  if (!current) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry ${id} cannot be safely reconstructed; reload before modifying it.`,
    );
  }
  if (
    expectation.expectedSourceBlock !== undefined &&
    currentSourceBlock !== expectation.expectedSourceBlock
  ) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry ${id} changed inside its managed block since it was opened.`,
    );
  }
  if (
    expectation.expectedEntry !== undefined &&
    normalizedEntryFingerprint(current) !== normalizedEntryFingerprint(expectation.expectedEntry)
  ) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry ${id} metadata or content changed since it was opened.`,
    );
  }
  if (
    expectation.expectedUpdatedAt !== undefined &&
    current.updatedAt !== expectation.expectedUpdatedAt
  ) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry ${id} changed since it was opened (updatedAt mismatch).`,
    );
  }
  if (expectation.expectedTime !== undefined && current.time !== expectation.expectedTime) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry ${id} changed since it was opened (time mismatch).`,
    );
  }
  if (
    expectation.expectedContentMarkdown !== undefined &&
    current.contentMarkdown !== expectation.expectedContentMarkdown
  ) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry ${id} changed since it was opened (content mismatch).`,
    );
  }
}

function normalizedEntryFingerprint(entry: TimePointEntry): string {
  return JSON.stringify({
    id: entry.id,
    date: entry.date,
    time: entry.time,
    minuteOfDay: entry.minuteOfDay,
    timezone: entry.timezone ?? null,
    contentMarkdown: entry.contentMarkdown,
    tags: entry.tags,
    source: entry.source ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function assertEntryId(id: string): void {
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new StorageMutationError(
      "INVALID_ENTRY",
      `Invalid entry ID ${id}; use letters, digits, and hyphens only.`,
    );
  }
}

function assertDate(date: string): void {
  if (!isValidDateString(date))
    throw new StorageMutationError("INVALID_ENTRY", `Invalid date ${date}.`);
}

function assertTime(time: string): void {
  if (!isValidStoredTime(time)) {
    throw new StorageMutationError(
      "INVALID_ENTRY",
      `Invalid stored time ${time}; use 00:00 through 23:59.`,
    );
  }
}

function assertTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)))
    throw new StorageMutationError("INVALID_ENTRY", `Invalid ${field} timestamp ${value}.`);
}

function assertSafeOptionalText(value: string | undefined, field: string): void {
  if (
    value !== undefined &&
    (/\r|\n/u.test(value) || value.length > 256 || value.includes("-->"))
  ) {
    throw new StorageMutationError(
      "INVALID_ENTRY",
      `${field} must be a single line of at most 256 characters without an HTML comment terminator.`,
    );
  }
}

function assertContent(contentMarkdown: string): void {
  if (hasReservedTimePointMarkerOutsideFence(contentMarkdown)) {
    throw new StorageMutationError(
      "INVALID_ENTRY",
      "Note content contains a reserved TimePoint entry marker line.",
    );
  }
}

/**
 * Literal marker examples are useful in Markdown documentation and are safe
 * inside fenced code. Only a real marker line outside a fence can interfere
 * with the bounded-entry scanner.
 */
export function hasReservedTimePointMarkerOutsideFence(markdown: string): boolean {
  let fence: { character: "`" | "~"; length: number } | undefined;
  for (const line of markdown.split(/\r?\n/u)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch) {
        const sequence = fenceMatch[1] ?? "";
        if (sequence.startsWith(fence.character) && sequence.length >= fence.length) {
          fence = undefined;
        }
      }
      continue;
    }
    if (fenceMatch) {
      const sequence = fenceMatch[1] ?? "";
      const character = sequence[0];
      if (character === "`" || character === "~") {
        fence = { character, length: sequence.length };
      }
      continue;
    }
    if (RESERVED_MARKER_LINE.test(line)) return true;
  }
  return false;
}

function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string" || raw.includes("-->")) {
      throw new StorageMutationError(
        "INVALID_ENTRY",
        "Tags must be strings without an HTML comment terminator.",
      );
    }
    const tag = raw.trim().replace(/^#+/, "");
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function normalizeIdToken(token: string): string {
  const normalized = token
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16);
  if (!normalized)
    throw new StorageMutationError("INVALID_ENTRY", "ID token must contain a letter or digit.");
  return normalized;
}

function randomToken(): string {
  const cryptoObject = typeof window === "undefined" ? undefined : window.crypto;
  if (cryptoObject?.getRandomValues) {
    const values = new Uint32Array(2);
    cryptoObject.getRandomValues(values);
    return `${values[0]?.toString(36) ?? "0"}${values[1]?.toString(36) ?? "0"}`.slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(-12);
}

function detectLineEnding(markdown: string): "\n" | "\r\n" {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}
