export const TIMEPOINT_SCHEMA_VERSION = 1 as const;

export type TimelineMode = "elastic" | "realtime";

export type TimePointStorageLayout = "empty" | "legacy-day" | "entry-files";

export type TimePointSource = string;

export const TIMEPOINT_CARD_SCHEMA_VERSION = 1 as const;
export const TIMEPOINT_VIEW_STATE_SCHEMA_VERSION = 1 as const;

/** Optional visual geometry. It never changes an event's wall-clock time. */
export interface TimePointCardLayout {
  schemaVersion: typeof TIMEPOINT_CARD_SCHEMA_VERSION;
  /** Preferred card centre within the logical card canvas, normalized to 0…1. */
  x: number;
  /** Preferred card centre within the logical day canvas, normalized to 0…1. */
  y: number;
  /** Preferred width as a fraction of the available card canvas. */
  width: number;
  /** Preferred logical height at 100% timeline zoom, in pixels. */
  height: number;
  /** Layout-only revision. This is deliberately separate from `updatedAt`. */
  updatedAt: string;
}

export interface TimelineViewportState {
  zoom: number;
  /** Normalized horizontal viewport centre. */
  centerX: number;
  /** Normalized vertical viewport centre. */
  centerY: number;
  /** Optional in legacy state; 1 is the normal 24-hour vertical scale. */
  verticalScale?: number;
}

export interface TimePointReferenceCardState {
  id: string;
  kind: "local-note" | "day-entry" | "external-url";
  target: string;
  x: number;
  y: number;
  width: number;
  height: number;
  expanded: boolean;
}

export type TimePointRelationTargetKind =
  "same-day-entry" | "day-entry" | "local-note" | "external-url";

export interface TimePointRelationCard {
  id: string;
  kind: Exclude<TimePointRelationTargetKind, "same-day-entry">;
  target: string;
  title: string;
  description?: string;
  sourceEntryIds: string[];
  targetEntryId?: string;
  targetDate?: string;
  snapshotId?: string;
  previewPath?: string;
}

export interface TimePointRelationEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: "timepoint" | "local" | "external";
}

export interface TimePointRelationGraph {
  cards: TimePointRelationCard[];
  edges: TimePointRelationEdge[];
  truncatedCards: number;
  truncatedEdges: number;
  cycles: string[];
}

export interface TimePointLinkSnapshot {
  id: string;
  originalUrl: string;
  normalizedUrl: string;
  title: string;
  description: string;
  fetchedAt: string;
  contentHash: string;
  sourceEntryIds: string[];
  snapshotPath: string;
  previewPath?: string;
}

/** Per-day display state stored in the managed `_Timeline.md` index. */
export interface TimePointDayViewState {
  schemaVersion: typeof TIMEPOINT_VIEW_STATE_SCHEMA_VERSION;
  modes: Record<TimelineMode, TimelineViewportState>;
  minimapExpanded: boolean;
  relationsEnabled: boolean;
  stackOrder: string[];
  referenceCards: Record<string, TimePointReferenceCardState>;
}

export type CanvasGestureState =
  | { kind: "idle" }
  | {
      kind: "pending";
      pointerId: number;
      target: "axis" | "blank" | "card" | "resize" | "minimap";
      startX: number;
      startY: number;
      threshold: number;
      entryId?: string;
      handle?: ResizeHandle;
    }
  | {
      kind: "panning" | "moving" | "resizing" | "minimap-panning";
      pointerId: number;
      startX: number;
      startY: number;
      entryId?: string;
      handle?: ResizeHandle;
    };

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface LayoutMutation {
  date: string;
  entryId: string;
  before: TimePointCardLayout | null;
  after: TimePointCardLayout | null;
  reason: "move" | "resize" | "reset";
}

export interface LayoutUndoEntry extends LayoutMutation {
  committedAt: string;
}

/**
 * A normalized, runtime TimePoint entry.
 *
 * `time` is always a stored wall-clock time in the inclusive range 00:00–23:59.
 * The 24:00 label belongs to the rendered axis only and is never persisted here.
 */
export interface TimePointEntry {
  id: string;
  date: string;
  time: string;
  minuteOfDay: number;
  timezone?: string;
  contentMarkdown: string;
  tags: string[];
  source?: TimePointSource;
  createdAt: string;
  updatedAt: string;
  /** Optional layout preference. Content and `time` remain authoritative. */
  cardLayout?: TimePointCardLayout;
  /** IDs of completed external-link snapshots associated with this entry. */
  linkSnapshotIds?: string[];
}

export interface NewTimePointEntryInput {
  id?: string;
  date: string;
  time: string;
  timezone?: string;
  contentMarkdown: string;
  tags?: readonly string[];
  source?: TimePointSource;
  /** ISO timestamp. Defaults to the current instant when omitted. */
  createdAt?: string;
  /** ISO timestamp. Defaults to `createdAt` when omitted. */
  updatedAt?: string;
}

export type ParseDiagnosticSeverity = "warning" | "error";

export type ParseDiagnosticCode =
  | "MISSING_FRONTMATTER"
  | "INVALID_FRONTMATTER"
  | "UNSUPPORTED_SCHEMA"
  | "DATE_MISMATCH"
  | "ORPHAN_END_MARKER"
  | "MISSING_END_MARKER"
  | "MISMATCHED_END_MARKER"
  | "DUPLICATE_ID"
  | "INVALID_ID"
  | "MISSING_HEADING"
  | "HEADING_ID_MISMATCH"
  | "MISSING_METADATA"
  | "MALFORMED_METADATA"
  | "UNKNOWN_METADATA_FIELD"
  | "METADATA_ID_MISMATCH"
  | "METADATA_DATE_MISMATCH"
  | "METADATA_TIME_MISMATCH"
  | "INVALID_DATE"
  | "INVALID_TIME"
  | "INVALID_TIMESTAMP"
  | "INVALID_TAGS"
  | "INVALID_CARD_LAYOUT"
  | "INVALID_VIEW_STATE";

export interface ParseDiagnostic {
  severity: ParseDiagnosticSeverity;
  code: ParseDiagnosticCode;
  message: string;
  entryId?: string;
  line?: number;
  startOffset?: number;
  endOffset?: number;
  /** Vault path that owns the diagnostic when entries are stored separately. */
  sourcePath?: string;
}

export interface ParsedDayFile {
  schemaVersion?: number;
  date?: string;
  timezone?: string;
  entries: TimePointEntry[];
  diagnostics: ParseDiagnostic[];
  rawMarkdown: string;
  storageLayout?: TimePointStorageLayout;
  /** Portable interactive index for entry-file days. */
  indexPath?: string;
  /** True when every current error has a conservative automatic repair. */
  canRepair?: boolean;
  /** Sanitized runtime state. A future state schema falls back here without blocking entries. */
  viewState?: TimePointDayViewState;
}

export interface ParseDayFileOptions {
  /**
   * The date implied by the file path. When present, it wins over conflicting
   * manually edited metadata while a diagnostic records the mismatch.
   */
  expectedDate?: string;
}

export interface EntryMutationExpectation {
  /** Complete normalized entry state captured when the editor/plan was opened. */
  expectedEntry?: TimePointEntry;
  /** Exact managed block bytes captured by the parser, including unknown current-schema fields. */
  expectedSourceBlock?: string;
  /** Legacy narrow guards retained for API compatibility and focused callers. */
  expectedUpdatedAt?: string;
  expectedTime?: string;
  expectedContentMarkdown?: string;
}
