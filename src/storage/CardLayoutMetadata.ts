import { TIMEPOINT_CARD_SCHEMA_VERSION, type TimePointCardLayout } from "../model/types";

export const CARD_LAYOUT_FIELDS = [
  "timepoint-card-schema",
  "timepoint-card-x",
  "timepoint-card-y",
  "timepoint-card-width",
  "timepoint-card-height",
  "timepoint-card-updated-at",
] as const;

export const LINK_SNAPSHOT_FIELD = "timepoint-link-snapshots" as const;

export const MIN_CARD_WIDTH = 0.2;
export const MAX_CARD_WIDTH = 1;
export const MIN_CARD_HEIGHT = 72;
export const MAX_CARD_HEIGHT = 720;
/** Manual cards may park below 24:00 up to one extra axis height. */
export const MAX_CANVAS_EXTENSION_RATIO = 2;

type FrontmatterRecord = Record<string, unknown>;

export interface ParsedCardLayout {
  layout?: TimePointCardLayout;
  /** Present when one or more layout fields exist but cannot form a safe layout. */
  warning?: string;
}

export function sanitizeCardLayout(value: unknown): TimePointCardLayout | null {
  if (!isRecord(value)) return null;
  const schemaVersion = finiteNumber(value.schemaVersion);
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  if (
    schemaVersion !== TIMEPOINT_CARD_SCHEMA_VERSION ||
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    !isIsoTimestamp(updatedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: TIMEPOINT_CARD_SCHEMA_VERSION,
    x: round(clamp(x, 0, 1), 6),
    y: round(clamp(y, 0, MAX_CANVAS_EXTENSION_RATIO), 6),
    width: round(clamp(width, MIN_CARD_WIDTH, MAX_CARD_WIDTH), 6),
    height: round(clamp(height, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT), 2),
    updatedAt,
  };
}

/** Parse the documented flat YAML extension from an Obsidian frontmatter object. */
export function parseCardLayoutFrontmatter(frontmatter: FrontmatterRecord): ParsedCardLayout {
  const present = CARD_LAYOUT_FIELDS.filter((field) => frontmatter[field] !== undefined);
  if (present.length === 0) return {};
  const layout = sanitizeCardLayout({
    schemaVersion: frontmatter["timepoint-card-schema"],
    x: frontmatter["timepoint-card-x"],
    y: frontmatter["timepoint-card-y"],
    width: frontmatter["timepoint-card-width"],
    height: frontmatter["timepoint-card-height"],
    updatedAt: frontmatter["timepoint-card-updated-at"],
  });
  return layout
    ? { layout }
    : {
        warning:
          "Invalid timepoint-card fields were ignored; this event uses automatic layout until the fields are fixed or reset.",
      };
}

export function writeCardLayoutFrontmatter(
  frontmatter: FrontmatterRecord,
  layout: TimePointCardLayout | null,
): void {
  for (const field of CARD_LAYOUT_FIELDS) delete frontmatter[field];
  if (!layout) return;
  const safe = sanitizeCardLayout(layout);
  if (!safe) throw new Error("Cannot persist an invalid TimePoint card layout.");
  frontmatter["timepoint-card-schema"] = safe.schemaVersion;
  frontmatter["timepoint-card-x"] = safe.x;
  frontmatter["timepoint-card-y"] = safe.y;
  frontmatter["timepoint-card-width"] = safe.width;
  frontmatter["timepoint-card-height"] = safe.height;
  frontmatter["timepoint-card-updated-at"] = safe.updatedAt;
}

export function parseSnapshotIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isSnapshotId))].sort();
}

export function writeSnapshotIdsFrontmatter(
  frontmatter: FrontmatterRecord,
  ids: readonly string[],
): void {
  const safe = [...new Set(ids.filter(isSnapshotId))].sort();
  if (safe.length) frontmatter[LINK_SNAPSHOT_FIELD] = safe;
  else delete frontmatter[LINK_SNAPSHOT_FIELD];
}

export function createCardLayout(
  input: Omit<TimePointCardLayout, "schemaVersion" | "updatedAt"> & { updatedAt?: string },
): TimePointCardLayout {
  const layout = sanitizeCardLayout({
    schemaVersion: TIMEPOINT_CARD_SCHEMA_VERSION,
    ...input,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  });
  if (!layout) throw new Error("Cannot create an invalid TimePoint card layout.");
  return layout;
}

function isSnapshotId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function isIsoTimestamp(value: string): boolean {
  return value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
