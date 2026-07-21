import { TIMEPOINT_SCHEMA_VERSION, type TimePointEntry } from "../model/types";

/** Export/import schema stays locked to the canonical Markdown model schema. */
export const TIMEPOINT_EXPORT_SCHEMA_VERSION = TIMEPOINT_SCHEMA_VERSION;
/** Multi-day exchange format. Kept independent from the storage schema. */
export const TIMEPOINT_RANGE_SCHEMA_VERSION = 1 as const;

export type ImportIssueCode =
  | "empty-input"
  | "invalid-json"
  | "invalid-csv"
  | "invalid-markdown"
  | "invalid-document"
  | "unsupported-schema"
  | "missing-field"
  | "invalid-date"
  | "invalid-time"
  | "invalid-id"
  | "duplicate-id"
  | "invalid-content"
  | "invalid-tags"
  | "invalid-timestamp"
  | "date-mismatch"
  | "duplicate-header"
  | "column-count";

export interface ImportIssue {
  code: ImportIssueCode;
  message: string;
  /** One-based CSV row number, or one-based JSON entry number. */
  row?: number;
  field?: string;
}

/**
 * Parsers never silently coerce invalid records. A caller can choose to offer a
 * partial import, but only after explicitly inspecting `issues`.
 */
export interface ParsedImport {
  schemaVersion: number;
  entries: TimePointEntry[];
  issues: ImportIssue[];
  ok: boolean;
}

export interface JsonExportOptions {
  date: string;
  timezone?: string;
}

export interface RangeExportOptions {
  startDate: string;
  endDate: string;
}

export type ImportConflictStrategy = "skip" | "replace" | "new-id";

export type ImportAction =
  | { kind: "insert"; entry: TimePointEntry }
  | {
      kind: "replace";
      entry: TimePointEntry;
      replacedEntry: TimePointEntry;
    }
  | {
      kind: "skip";
      entry: TimePointEntry;
      conflictingEntry: TimePointEntry;
      reason: "duplicate-id";
    }
  | {
      kind: "rename-and-insert";
      entry: TimePointEntry;
      originalId: string;
      conflictingEntry: TimePointEntry;
    }
  | {
      kind: "reject";
      entry: TimePointEntry;
      reasons: string[];
    };

export interface ImportPlan {
  strategy: ImportConflictStrategy;
  actions: ImportAction[];
  insertCount: number;
  replaceCount: number;
  skipCount: number;
  rejectCount: number;
  conflictCount: number;
}
