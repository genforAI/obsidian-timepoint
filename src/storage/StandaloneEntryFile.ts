import type { ParseDiagnostic, TimePointEntry } from "../model/types";
import { isValidDateString, isValidStoredTime, timeToMinuteOfDay } from "../utils/time";

export const ENTRY_FILE_SCHEMA_VERSION = 1 as const;
export const DAY_INDEX_SCHEMA_VERSION = 2 as const;
export const DAY_INDEX_BASENAME = "_Timeline";

const FRONTMATTER_PATTERN = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const KNOWN_FIELDS = new Set([
  "timepoint-entry-schema",
  "id",
  "date",
  "time",
  "timezone",
  "createdAt",
  "updatedAt",
  "tags",
  "source",
]);
const entryFileSnapshots = new WeakMap<TimePointEntry, string>();

export interface ParseStandaloneEntryOptions {
  expectedDate?: string;
  sourcePath?: string;
  fallbackUpdatedAt?: string;
}

export interface ParsedStandaloneEntry {
  entry?: TimePointEntry;
  diagnostics: ParseDiagnostic[];
  bodyMarkdown: string;
  unknownFrontmatterFields: string[];
}

export interface StandaloneEditorTarget {
  cursorOffset: number;
  contentStart: number;
  contentEnd: number;
}

/** Serialize one event as an ordinary, independently movable Markdown note. */
export function serializeStandaloneEntry(entry: TimePointEntry, eol = "\n"): string {
  if (eol !== "\n" && eol !== "\r\n") throw new Error("Unsupported line ending.");
  const lines = [
    "---",
    `timepoint-entry-schema: ${ENTRY_FILE_SCHEMA_VERSION}`,
    `id: ${JSON.stringify(entry.id)}`,
    `date: ${entry.date}`,
    `time: ${JSON.stringify(entry.time)}`,
    ...(entry.timezone ? [`timezone: ${JSON.stringify(entry.timezone)}`] : []),
    `createdAt: ${JSON.stringify(entry.createdAt)}`,
    `updatedAt: ${JSON.stringify(entry.updatedAt)}`,
    `tags: ${JSON.stringify(entry.tags)}`,
    ...(entry.source ? [`source: ${JSON.stringify(entry.source)}`] : []),
    "---",
    "",
  ];
  const body = entry.contentMarkdown.replace(/\r\n?/gu, "\n").replace(/^\n+|\n+$/gu, "");
  if (body) lines.push(body.replaceAll("\n", eol), "");
  return lines.join(eol);
}

/**
 * Replace TimePoint-owned properties and the note body while keeping unrelated
 * YAML properties byte-for-byte. This lets an event remain a normal Obsidian
 * note: users may add aliases, cssclasses, or plugin properties without losing
 * them on a later TimePoint edit.
 */
export function updateStandaloneEntryMarkdown(
  currentMarkdown: string,
  entry: TimePointEntry,
): string {
  const frontmatter = FRONTMATTER_PATTERN.exec(currentMarkdown);
  if (!frontmatter) return serializeStandaloneEntry(entry, detectEol(currentMarkdown));

  const eol = detectEol(currentMarkdown);
  const existingLines = (frontmatter[1] ?? "").split(/\r?\n/u);
  const preservedLines: string[] = [];
  for (let index = 0; index < existingLines.length; index += 1) {
    const line = existingLines[index] ?? "";
    const property = /^([A-Za-z0-9_-]+):/u.exec(line)?.[1];
    if (!property || !KNOWN_FIELDS.has(property)) {
      preservedLines.push(line);
      continue;
    }
    while (index + 1 < existingLines.length && /^[ \t]+/u.test(existingLines[index + 1] ?? "")) {
      index += 1;
    }
  }

  const canonical = serializeStandaloneEntry(entry, eol);
  const canonicalFrontmatter = FRONTMATTER_PATTERN.exec(canonical)?.[1] ?? "";
  const mergedFrontmatter = [
    canonicalFrontmatter,
    ...trimBlankEdges(preservedLines).map((line) => line.replace(/\r$/u, "")),
  ]
    .filter(Boolean)
    .join(eol);
  const canonicalBody = canonical.slice(FRONTMATTER_PATTERN.exec(canonical)?.[0].length ?? 0);
  return `---${eol}${mergedFrontmatter}${eol}---${eol}${canonicalBody.replace(/^(?:\r?\n)+/u, "")}`;
}

/** Parse TimePoint's documented YAML subset while tolerating unrelated user properties. */
export function parseStandaloneEntry(
  markdown: string,
  options: ParseStandaloneEntryOptions = {},
): ParsedStandaloneEntry {
  const diagnostics: ParseDiagnostic[] = [];
  const diagnostic = (
    severity: "warning" | "error",
    code: ParseDiagnostic["code"],
    message: string,
  ): void => {
    diagnostics.push({
      severity,
      code,
      message,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    });
  };

  const frontmatter = FRONTMATTER_PATTERN.exec(markdown);
  if (!frontmatter) {
    diagnostic("error", "MISSING_FRONTMATTER", "Entry note has no closed YAML frontmatter.");
    return { diagnostics, bodyMarkdown: markdown, unknownFrontmatterFields: [] };
  }

  const parsed = parseFrontmatterSubset(frontmatter[1] ?? "");
  const unknownFrontmatterFields = [...parsed.keys()].filter((key) => !KNOWN_FIELDS.has(key));
  const schema = numberScalar(parsed.get("timepoint-entry-schema"));
  if (schema !== ENTRY_FILE_SCHEMA_VERSION) {
    diagnostic(
      "error",
      "UNSUPPORTED_SCHEMA",
      `Entry note schema ${schema ?? "(missing)"} is not supported schema ${ENTRY_FILE_SCHEMA_VERSION}.`,
    );
  }

  const id = stringScalar(parsed.get("id"));
  if (!id || !ENTRY_ID_PATTERN.test(id)) diagnostic("error", "INVALID_ID", "Invalid entry ID.");

  const declaredDate = stringScalar(parsed.get("date"));
  const expectedDate = options.expectedDate;
  if (expectedDate && !isValidDateString(expectedDate)) {
    diagnostic("error", "INVALID_DATE", `Invalid path date ${expectedDate}.`);
  }
  if (declaredDate && !isValidDateString(declaredDate)) {
    diagnostic("error", "INVALID_DATE", `Invalid entry date ${declaredDate}.`);
  }
  if (expectedDate && declaredDate && expectedDate !== declaredDate) {
    diagnostic(
      "warning",
      "DATE_MISMATCH",
      `Entry note moved from ${declaredDate} into ${expectedDate}; the folder date is used.`,
    );
  }
  const date = expectedDate ?? declaredDate;

  const time = stringScalar(parsed.get("time"));
  if (!time || !isValidStoredTime(time)) diagnostic("error", "INVALID_TIME", "Invalid entry time.");

  const createdAt = stringScalar(parsed.get("createdAt"));
  if (!createdAt || !isTimestamp(createdAt)) {
    diagnostic("error", "INVALID_TIMESTAMP", "Invalid or missing createdAt timestamp.");
  }
  const declaredUpdatedAt = stringScalar(parsed.get("updatedAt"));
  const updatedAt =
    declaredUpdatedAt && isTimestamp(declaredUpdatedAt)
      ? declaredUpdatedAt
      : options.fallbackUpdatedAt && isTimestamp(options.fallbackUpdatedAt)
        ? options.fallbackUpdatedAt
        : createdAt;
  if (!updatedAt)
    diagnostic("error", "INVALID_TIMESTAMP", "Invalid or missing updatedAt timestamp.");

  const tags = tagsScalar(parsed.get("tags"));
  if (!tags) diagnostic("warning", "INVALID_TAGS", "Invalid tags; an empty list was used.");

  const bodyStart = frontmatter.index + frontmatter[0].length;
  const bodyMarkdown = markdown
    .slice(bodyStart)
    .replace(/^(?:[ \t]*\r?\n)+/u, "")
    .replace(/(?:\r?\n[ \t]*)+$/u, "");

  if (
    diagnostics.some((item) => item.severity === "error") ||
    !id ||
    !date ||
    !time ||
    !createdAt ||
    !updatedAt
  ) {
    return { diagnostics, bodyMarkdown, unknownFrontmatterFields };
  }

  const entry: TimePointEntry = {
    id,
    date,
    time,
    minuteOfDay: timeToMinuteOfDay(time),
    ...(stringScalar(parsed.get("timezone"))
      ? { timezone: stringScalar(parsed.get("timezone")) }
      : {}),
    contentMarkdown: bodyMarkdown,
    tags: tags ?? [],
    ...(stringScalar(parsed.get("source")) ? { source: stringScalar(parsed.get("source")) } : {}),
    createdAt,
    updatedAt,
  };
  entryFileSnapshots.set(entry, markdown);
  return {
    entry,
    diagnostics,
    bodyMarkdown,
    unknownFrontmatterFields,
  };
}

export function getStandaloneEntrySnapshot(entry: TimePointEntry): string | undefined {
  return entryFileSnapshots.get(entry);
}

export function locateStandaloneEditorTarget(markdown: string): StandaloneEditorTarget | null {
  const frontmatter = FRONTMATTER_PATTERN.exec(markdown);
  if (!frontmatter) return null;
  let contentStart = frontmatter.index + frontmatter[0].length;
  const leading = /^(?:[ \t]*\r?\n)+/u.exec(markdown.slice(contentStart));
  if (leading) contentStart += leading[0].length;
  return {
    cursorOffset: contentStart,
    contentStart,
    contentEnd: markdown.length,
  };
}

export function entryFileName(entry: Pick<TimePointEntry, "id" | "time">): string {
  return `${entry.time.replace(":", "")}--${entry.id}.md`;
}

export function serializeDayIndex(
  date: string,
  entries: readonly TimePointEntry[],
  timezone?: string,
  legacySourcePath?: string,
): string {
  const links = [...entries]
    .sort((left, right) => left.minuteOfDay - right.minuteOfDay || left.id.localeCompare(right.id))
    .map((entry) => `- [[${entryFileName(entry).slice(0, -3)}|${entry.time}]]`);
  return [
    "---",
    `timepoint-layout: entry-files`,
    `timepoint-schema: ${DAY_INDEX_SCHEMA_VERSION}`,
    `date: ${date}`,
    ...(timezone ? [`timezone: ${JSON.stringify(timezone)}`] : []),
    ...(legacySourcePath ? [`legacy-source: ${JSON.stringify(legacySourcePath)}`] : []),
    "---",
    "",
    `# TimePoint · ${date}`,
    "",
    "> [!info] Portable interactive day",
    "> Each event is an ordinary Markdown note in this folder. Copy the folder to transfer the day.",
    "",
    "```timepoint",
    `date: ${date}`,
    "mode: elastic",
    "editable: true",
    "```",
    "",
    "## Event notes",
    "",
    ...(links.length > 0 ? links : ["_No events yet._"]),
    "",
  ].join("\n");
}

function parseFrontmatterSubset(source: string): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    const scalar = match[2]?.trim() ?? "";
    if (!key) continue;
    if (scalar) {
      result.set(key, parseYamlScalar(scalar));
      continue;
    }
    const sequence: string[] = [];
    while (index + 1 < lines.length) {
      const item = /^[ \t]+-[ \t]+(.*)$/u.exec(lines[index + 1] ?? "");
      if (!item) break;
      sequence.push(String(parseYamlScalar(item[1]?.trim() ?? "")));
      index += 1;
    }
    result.set(key, sequence);
  }
  return result;
}

function parseYamlScalar(value: string): unknown {
  if (value.startsWith("[") || value.startsWith('"')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value.replace(/^['"]|['"]$/gu, "");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (/^\d+$/u.test(value)) return Number(value);
  return value;
}

function stringScalar(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberScalar(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function tagsScalar(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string") return undefined;
    const tag = item.trim();
    if (tag) tags.push(tag);
  }
  return [...new Set(tags)];
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function detectEol(markdown: string): "\n" | "\r\n" {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}

function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !(lines[start] ?? "").trim()) start += 1;
  while (end > start && !(lines[end - 1] ?? "").trim()) end -= 1;
  return lines.slice(start, end);
}
