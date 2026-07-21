import {
  TIMEPOINT_SCHEMA_VERSION,
  type ParseDayFileOptions,
  type ParseDiagnostic,
  type ParsedDayFile,
  type TimePointEntry,
} from "../model/types";
import { isValidDateString, isValidStoredTime, timeToMinuteOfDay } from "../utils/time";

const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const FRONTMATTER_PATTERN = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const HEADING_PATTERN = /^##[ \t]+([^\s]+)[ \t]+\^([^\s]+)[ \t]*$/m;
const METADATA_PATTERN = /<!--\s*timepoint(?=\s)([\s\S]*?)-->/i;
const MARKER_LINE_PATTERN =
  /^[ \t]*<!--\s*timepoint:entry:(start|end)[ \t]+id="([^"\r\n]+)"\s*-->[ \t]*$/;
const entrySourceBlocks = new WeakMap<TimePointEntry, string>();

interface FrontmatterData {
  schemaVersion?: number;
  date?: string;
  timezone?: string;
}

export interface EntrySourceBlock {
  id: string;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  line: number;
}

interface MarkerToken {
  kind: "start" | "end";
  id: string;
  start: number;
  commentEnd: number;
  lineEnd: number;
  line: number;
}

interface EntryMetadata {
  schemaVersion?: number;
  id?: string;
  date?: string;
  time?: string;
  timezone?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: unknown;
  source?: string;
}

const ENTRY_METADATA_FIELDS = new Set<keyof EntryMetadata>([
  "schemaVersion",
  "id",
  "date",
  "time",
  "timezone",
  "createdAt",
  "updatedAt",
  "tags",
  "source",
]);

export interface EntryMarkerScanResult {
  blocks: EntrySourceBlock[];
  diagnostics: ParseDiagnostic[];
  /** Includes both paired and unpaired marker IDs, in source order. */
  markerIds: string[];
}

export function parseDayFile(markdown: string, options: ParseDayFileOptions = {}): ParsedDayFile {
  const diagnostics: ParseDiagnostic[] = [];
  const frontmatter = parseFrontmatter(markdown, diagnostics);
  const expectedDate = resolveExpectedDate(options.expectedDate, diagnostics);

  if (expectedDate && frontmatter.date && expectedDate !== frontmatter.date) {
    diagnostics.push({
      severity: "error",
      code: "DATE_MISMATCH",
      message: `File path date ${expectedDate} disagrees with frontmatter date ${frontmatter.date}; the path date was used.`,
      line: 1,
    });
  }

  const dayDate = expectedDate ?? frontmatter.date;
  const scan = locateEntryBlocks(markdown);
  diagnostics.push(...scan.diagnostics);

  const entries: TimePointEntry[] = [];
  const seenIds = new Set<string>();
  for (const block of scan.blocks) {
    if (seenIds.has(block.id)) {
      diagnostics.push(
        blockDiagnostic(
          block,
          "error",
          "DUPLICATE_ID",
          `Duplicate entry ID ${block.id}; the later entry was ignored.`,
        ),
      );
      continue;
    }
    seenIds.add(block.id);

    const entry = parseEntryBlock(markdown, block, dayDate, frontmatter.timezone, diagnostics);
    if (entry) {
      entrySourceBlocks.set(entry, markdown.slice(block.start, block.end));
      entries.push(entry);
    }
  }

  entries.sort(
    (left, right) =>
      left.minuteOfDay - right.minuteOfDay ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );

  return {
    schemaVersion: frontmatter.schemaVersion,
    date: dayDate,
    timezone: frontmatter.timezone,
    entries,
    diagnostics,
    rawMarkdown: markdown,
  };
}

/**
 * Returns the exact managed block captured while parsing this entry. The
 * snapshot is runtime-only and deliberately absent from serialized/exported
 * entry data.
 */
export function getEntrySourceBlockSnapshot(entry: TimePointEntry): string | undefined {
  return entrySourceBlocks.get(entry);
}

/**
 * Finds only unambiguous, immediately paired entry markers. Marker-looking text
 * inside fenced code blocks is intentionally ignored.
 */
export function locateEntryBlocks(markdown: string): EntryMarkerScanResult {
  const tokens = scanMarkerTokens(markdown);
  const blocks: EntrySourceBlock[] = [];
  const diagnostics: ParseDiagnostic[] = [];

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (!token) break;

    if (token.kind === "end") {
      diagnostics.push(
        tokenDiagnostic(
          token,
          "error",
          "ORPHAN_END_MARKER",
          `Entry end marker ${token.id} has no matching start marker.`,
        ),
      );
      index += 1;
      continue;
    }

    const next = tokens[index + 1];
    if (!next || next.kind === "start") {
      diagnostics.push(
        tokenDiagnostic(
          token,
          "error",
          "MISSING_END_MARKER",
          `Entry ${token.id} has no matching end marker.`,
        ),
      );
      index += 1;
      continue;
    }

    if (next.id !== token.id) {
      diagnostics.push(
        tokenDiagnostic(
          token,
          "error",
          "MISMATCHED_END_MARKER",
          `Entry ${token.id} is followed by an end marker for ${next.id}; neither marker was paired.`,
        ),
      );
      index += 1;
      continue;
    }

    blocks.push({
      id: token.id,
      start: token.start,
      end: next.commentEnd,
      contentStart: token.lineEnd,
      contentEnd: next.start,
      line: token.line,
    });
    index += 2;
  }

  return { blocks, diagnostics, markerIds: tokens.map((token) => token.id) };
}

function parseFrontmatter(markdown: string, diagnostics: ParseDiagnostic[]): FrontmatterData {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (!match) {
    diagnostics.push({
      severity: "warning",
      code: markdown.startsWith("---") ? "INVALID_FRONTMATTER" : "MISSING_FRONTMATTER",
      message: markdown.startsWith("---")
        ? "Frontmatter is not closed or is malformed. Entries will be recovered where possible."
        : "TimePoint frontmatter is missing. Entries will be recovered where possible.",
      line: 1,
    });
    return {};
  }

  const body = match[1] ?? "";
  const schemaText = readFrontmatterScalar(body, "timepoint-schema");
  const dateText = readFrontmatterScalar(body, "date");
  const timezoneText = readFrontmatterScalar(body, "timezone");
  const data: FrontmatterData = {};

  if (schemaText !== undefined) {
    const schemaVersion = Number(schemaText);
    if (Number.isInteger(schemaVersion) && schemaVersion > 0) {
      data.schemaVersion = schemaVersion;
      if (schemaVersion !== TIMEPOINT_SCHEMA_VERSION) {
        const isFutureSchema = schemaVersion > TIMEPOINT_SCHEMA_VERSION;
        diagnostics.push({
          severity: isFutureSchema ? "error" : "warning",
          code: "UNSUPPORTED_SCHEMA",
          message: isFutureSchema
            ? `Day file schema ${schemaVersion} is newer than supported schema ${TIMEPOINT_SCHEMA_VERSION}; it was opened read-only and cannot be safely modified or exported.`
            : `Day file schema ${schemaVersion} is not the supported schema ${TIMEPOINT_SCHEMA_VERSION}; known fields were parsed conservatively.`,
          line: 2,
        });
      }
    } else {
      diagnostics.push({
        severity: "warning",
        code: "INVALID_FRONTMATTER",
        message: "Invalid timepoint-schema value.",
        line: 2,
      });
    }
  }

  if (dateText !== undefined) {
    if (isValidDateString(dateText)) data.date = dateText;
    else
      diagnostics.push({
        severity: "error",
        code: "INVALID_DATE",
        message: `Invalid frontmatter date: ${dateText}.`,
        line: 1,
      });
  }

  if (timezoneText !== undefined && timezoneText.length > 0) data.timezone = timezoneText;
  return data;
}

function resolveExpectedDate(
  expectedDate: string | undefined,
  diagnostics: ParseDiagnostic[],
): string | undefined {
  if (expectedDate === undefined) return undefined;
  if (isValidDateString(expectedDate)) return expectedDate;
  diagnostics.push({
    severity: "error",
    code: "INVALID_DATE",
    message: `Invalid expected file date: ${expectedDate}.`,
  });
  return undefined;
}

function parseEntryBlock(
  markdown: string,
  block: EntrySourceBlock,
  dayDate: string | undefined,
  dayTimezone: string | undefined,
  diagnostics: ParseDiagnostic[],
): TimePointEntry | undefined {
  if (!ENTRY_ID_PATTERN.test(block.id)) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "error",
        "INVALID_ID",
        `Entry ID ${block.id} is not a valid Obsidian block ID.`,
      ),
    );
    return undefined;
  }

  const rawBlockContent = markdown.slice(block.contentStart, block.contentEnd);
  const headingMatch = HEADING_PATTERN.exec(rawBlockContent);
  const headingTime = headingMatch?.[1];
  const headingId = headingMatch?.[2];
  if (!headingMatch) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "MISSING_HEADING",
        `Entry ${block.id} is missing its readable time heading.`,
      ),
    );
  } else if (headingId !== block.id) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "HEADING_ID_MISMATCH",
        `Entry heading block ID ${headingId ?? "(missing)"} disagrees with marker ID ${block.id}.`,
      ),
    );
  }

  const metadataMatch = METADATA_PATTERN.exec(rawBlockContent);
  let metadata: EntryMetadata = {};
  if (!metadataMatch) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "MISSING_METADATA",
        `Entry ${block.id} has no hidden TimePoint metadata.`,
      ),
    );
  } else {
    try {
      const candidate: unknown = JSON.parse((metadataMatch[1] ?? "").trim());
      if (isRecord(candidate)) metadata = candidate;
      else throw new Error("metadata is not an object");
    } catch {
      diagnostics.push(
        blockDiagnostic(
          block,
          "warning",
          "MALFORMED_METADATA",
          `Entry ${block.id} has malformed hidden JSON; visible fields were used where possible.`,
        ),
      );
    }
  }

  const unknownMetadataFields = Object.keys(metadata).filter(
    (field) => !ENTRY_METADATA_FIELDS.has(field as keyof EntryMetadata),
  );
  if (unknownMetadataFields.length > 0) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "error",
        "UNKNOWN_METADATA_FIELD",
        `Entry ${block.id} contains unknown metadata ${unknownMetadataFields.join(", ")}; it remains readable, but the day is read-only so an older plugin cannot erase extension data.`,
      ),
    );
  }

  if (metadata.schemaVersion !== undefined && metadata.schemaVersion !== TIMEPOINT_SCHEMA_VERSION) {
    const isFutureSchema =
      typeof metadata.schemaVersion === "number" &&
      Number.isInteger(metadata.schemaVersion) &&
      metadata.schemaVersion > TIMEPOINT_SCHEMA_VERSION;
    diagnostics.push(
      blockDiagnostic(
        block,
        isFutureSchema ? "error" : "warning",
        "UNSUPPORTED_SCHEMA",
        isFutureSchema
          ? `Entry ${block.id} schema ${metadata.schemaVersion} is newer than supported schema ${TIMEPOINT_SCHEMA_VERSION}; the day was opened read-only and cannot be safely modified or exported.`
          : `Entry ${block.id} uses unsupported schema ${String(metadata.schemaVersion)}.`,
      ),
    );
  }
  if (metadata.id !== undefined && metadata.id !== block.id) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "METADATA_ID_MISMATCH",
        `Entry metadata ID ${metadata.id} disagrees with marker ID ${block.id}.`,
      ),
    );
  }

  const metadataDate =
    typeof metadata.date === "string" && isValidDateString(metadata.date)
      ? metadata.date
      : undefined;
  if (typeof metadata.date === "string" && !metadataDate) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "error",
        "INVALID_DATE",
        `Entry ${block.id} has invalid metadata date ${metadata.date}.`,
      ),
    );
  }
  if (dayDate && metadataDate && dayDate !== metadataDate) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "METADATA_DATE_MISMATCH",
        `Entry ${block.id} metadata date ${metadataDate} disagrees with day date ${dayDate}; the day date was used.`,
      ),
    );
  }
  const date = dayDate ?? metadataDate;
  if (!date) {
    diagnostics.push(
      blockDiagnostic(block, "error", "INVALID_DATE", `Entry ${block.id} has no recoverable date.`),
    );
    return undefined;
  }

  const validHeadingTime =
    headingTime !== undefined && isValidStoredTime(headingTime) ? headingTime : undefined;
  if (headingTime !== undefined && !validHeadingTime) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "error",
        "INVALID_TIME",
        `Entry ${block.id} has invalid heading time ${headingTime}; stored times must be 00:00–23:59.`,
      ),
    );
  }
  const validMetadataTime =
    typeof metadata.time === "string" && isValidStoredTime(metadata.time)
      ? metadata.time
      : undefined;
  if (typeof metadata.time === "string" && !validMetadataTime) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "error",
        "INVALID_TIME",
        `Entry ${block.id} has invalid metadata time ${metadata.time}; stored times must be 00:00–23:59.`,
      ),
    );
  }
  if (validHeadingTime && validMetadataTime && validHeadingTime !== validMetadataTime) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "METADATA_TIME_MISMATCH",
        `Entry ${block.id} visible time ${validHeadingTime} disagrees with metadata time ${validMetadataTime}; the visible time was used.`,
      ),
    );
  }
  const time = validHeadingTime ?? validMetadataTime;
  if (!time) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "error",
        "INVALID_TIME",
        `Entry ${block.id} has no recoverable stored time.`,
      ),
    );
    return undefined;
  }

  const fallbackTimestamp = `${date}T${time}:00`;
  const createdAt = validTimestampOrFallback(
    metadata.createdAt,
    fallbackTimestamp,
    block,
    "createdAt",
    diagnostics,
  );
  const updatedAt = validTimestampOrFallback(
    metadata.updatedAt,
    createdAt,
    block,
    "updatedAt",
    diagnostics,
  );
  const contentMarkdown = stripScaffolding(rawBlockContent, headingMatch, metadataMatch);
  const tags = parseTags(metadata.tags, contentMarkdown, block, diagnostics);

  return {
    id: block.id,
    date,
    time,
    minuteOfDay: timeToMinuteOfDay(time),
    ...(typeof metadata.timezone === "string" && metadata.timezone.length > 0
      ? { timezone: metadata.timezone }
      : dayTimezone
        ? { timezone: dayTimezone }
        : {}),
    contentMarkdown,
    tags,
    ...(typeof metadata.source === "string" && metadata.source.length > 0
      ? { source: metadata.source }
      : {}),
    createdAt,
    updatedAt,
  };
}

function scanMarkerTokens(markdown: string): MarkerToken[] {
  const tokens: MarkerToken[] = [];
  let offset = 0;
  let lineNumber = 1;
  let fence: { character: "`" | "~"; length: number } | undefined;

  while (offset < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const fullLine = markdown.slice(offset, lineEnd);
    const line = fullLine.replace(/\r?\n$/, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fence) {
      if (fenceMatch) {
        const sequence = fenceMatch[1] ?? "";
        if (sequence.startsWith(fence.character) && sequence.length >= fence.length)
          fence = undefined;
      }
    } else if (fenceMatch) {
      const sequence = fenceMatch[1] ?? "";
      const character = sequence[0];
      if (character === "`" || character === "~") fence = { character, length: sequence.length };
    } else {
      const marker = MARKER_LINE_PATTERN.exec(line);
      if (marker) {
        const kind = marker[1];
        const id = marker[2];
        if ((kind === "start" || kind === "end") && id !== undefined) {
          tokens.push({
            kind,
            id,
            start: offset,
            commentEnd: offset + line.length,
            lineEnd,
            line: lineNumber,
          });
        }
      }
    }

    offset = lineEnd;
    lineNumber += 1;
  }
  return tokens;
}

function stripScaffolding(
  rawBlockContent: string,
  headingMatch: RegExpExecArray | null,
  metadataMatch: RegExpExecArray | null,
): string {
  const ranges: Array<{ start: number; end: number }> = [];
  if (headingMatch?.index !== undefined)
    ranges.push({ start: headingMatch.index, end: headingMatch.index + headingMatch[0].length });
  if (metadataMatch?.index !== undefined)
    ranges.push({ start: metadataMatch.index, end: metadataMatch.index + metadataMatch[0].length });
  ranges.sort((left, right) => right.start - left.start);

  let content = rawBlockContent;
  for (const range of ranges) content = content.slice(0, range.start) + content.slice(range.end);
  return content.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

function parseTags(
  value: unknown,
  contentMarkdown: string,
  block: EntrySourceBlock,
  diagnostics: ParseDiagnostic[],
): string[] {
  if (value === undefined) return extractMarkdownTags(contentMarkdown);
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "INVALID_TAGS",
        `Entry ${block.id} metadata tags are invalid; tags were reconstructed from Markdown.`,
      ),
    );
    return extractMarkdownTags(contentMarkdown);
  }
  return uniqueTags(value as string[]);
}

function extractMarkdownTags(markdown: string): string[] {
  const tags: string[] = [];
  const pattern = /(?:^|[\s([])#([\p{L}\p{N}_/-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const tag = match[1];
    if (tag) tags.push(tag);
  }
  return uniqueTags(tags);
}

function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawTag of tags) {
    const tag = rawTag.trim().replace(/^#+/, "");
    if (tag.length > 0 && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function validTimestampOrFallback(
  value: unknown,
  fallback: string,
  block: EntrySourceBlock,
  field: string,
  diagnostics: ParseDiagnostic[],
): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  if (value !== undefined) {
    diagnostics.push(
      blockDiagnostic(
        block,
        "warning",
        "INVALID_TIMESTAMP",
        `Entry ${block.id} has invalid ${field}; a deterministic fallback was used.`,
      ),
    );
  }
  return fallback;
}

function readFrontmatterScalar(body: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedKey}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, "m").exec(body);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed.replace(/[ \t]+#.*$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenDiagnostic(
  token: MarkerToken,
  severity: "warning" | "error",
  code: ParseDiagnostic["code"],
  message: string,
): ParseDiagnostic {
  return {
    severity,
    code,
    message,
    entryId: token.id,
    line: token.line,
    startOffset: token.start,
    endOffset: token.commentEnd,
  };
}

function blockDiagnostic(
  block: EntrySourceBlock,
  severity: "warning" | "error",
  code: ParseDiagnostic["code"],
  message: string,
): ParseDiagnostic {
  return {
    severity,
    code,
    message,
    entryId: block.id,
    line: block.line,
    startOffset: block.start,
    endOffset: block.end,
  };
}
