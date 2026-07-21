export const TIMEPOINT_SCHEMA_VERSION = 1 as const;

export type TimelineMode = "elastic" | "realtime";

export type TimePointStorageLayout = "empty" | "legacy-day" | "entry-files";

export type TimePointSource = string;

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
  | "INVALID_TAGS";

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
