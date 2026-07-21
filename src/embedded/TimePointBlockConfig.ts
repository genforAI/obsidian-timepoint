import type { TimelineMode } from "../model/types";
import { isValidDateString } from "../utils/time";

export interface TimePointBlockConfig {
  /** Resolved ISO calendar date. `today` is never retained at runtime. */
  date: string;
  dateSource: "today" | "explicit";
  mode: TimelineMode;
  editable: boolean;
}

export type TimePointBlockConfigIssueCode =
  | "INVALID_SYNTAX"
  | "UNKNOWN_KEY"
  | "DUPLICATE_KEY"
  | "INVALID_DATE"
  | "INVALID_MODE"
  | "INVALID_EDITABLE";

export interface TimePointBlockConfigIssue {
  code: TimePointBlockConfigIssueCode;
  line: number;
  key?: string;
  message: string;
}

export type TimePointBlockConfigResult =
  | { ok: true; config: TimePointBlockConfig; issues: [] }
  | { ok: false; issues: TimePointBlockConfigIssue[] };

export interface ParseTimePointBlockConfigOptions {
  /**
   * The date used to resolve `date: today`. It is supplied by the plugin so
   * parsing remains deterministic and independently testable.
   */
  today: string;
}

const KNOWN_KEYS = new Set(["date", "mode", "editable"]);

/**
 * Parse the deliberately small, YAML-like TimePoint code-block language.
 *
 * This is intentionally not a general YAML parser: accepting only one
 * `key: value` pair per line keeps behavior deterministic and makes typos or
 * unsupported options visible instead of silently ignoring them.
 */
export function parseTimePointBlockConfig(
  source: string,
  options: ParseTimePointBlockConfigOptions,
): TimePointBlockConfigResult {
  const issues: TimePointBlockConfigIssue[] = [];
  const values = new Map<string, { value: string; line: number }>();

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/u.exec(trimmed);
    if (!match) {
      issues.push({
        code: "INVALID_SYNTAX",
        line,
        message: `Line ${line} must contain one key-value pair such as "mode: elastic".`,
      });
      continue;
    }

    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (!KNOWN_KEYS.has(key)) {
      issues.push({
        code: "UNKNOWN_KEY",
        line,
        key,
        message: `Line ${line} uses unknown key "${key}". Supported keys are date, mode, and editable.`,
      });
      continue;
    }
    if (values.has(key)) {
      issues.push({
        code: "DUPLICATE_KEY",
        line,
        key,
        message: `Line ${line} repeats "${key}". Each key may appear only once.`,
      });
      continue;
    }
    values.set(key, { value, line });
  }

  const dateSetting = values.get("date");
  const modeSetting = values.get("mode");
  const editableSetting = values.get("editable");

  const rawDate = dateSetting?.value ?? "today";
  const dateSource = rawDate === "today" ? "today" : "explicit";
  const date = dateSource === "today" ? options.today : rawDate;
  if (!isValidDateString(date)) {
    issues.push({
      code: "INVALID_DATE",
      line: dateSetting?.line ?? 1,
      key: "date",
      message:
        rawDate === "today"
          ? `The supplied current date "${options.today}" is invalid.`
          : `Date "${rawDate}" is invalid. Use "today" or an existing YYYY-MM-DD calendar date.`,
    });
  }

  const rawMode = modeSetting?.value ?? "elastic";
  if (rawMode !== "elastic" && rawMode !== "realtime") {
    issues.push({
      code: "INVALID_MODE",
      line: modeSetting?.line ?? 1,
      key: "mode",
      message: `Mode "${rawMode}" is invalid. Use "elastic" or "realtime".`,
    });
  }

  const rawEditable = editableSetting?.value ?? "false";
  if (rawEditable !== "true" && rawEditable !== "false") {
    issues.push({
      code: "INVALID_EDITABLE",
      line: editableSetting?.line ?? 1,
      key: "editable",
      message: `Editable value "${rawEditable}" is invalid. Use "true" or "false".`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: {
      date,
      dateSource,
      mode: rawMode as TimelineMode,
      editable: rawEditable === "true",
    },
    issues: [],
  };
}

/** Pure path matcher shared by the Reading View lifecycle and unit tests. */
export function pathsAffectEmbeddedDay(dayPath: string, changedPaths: readonly string[]): boolean {
  const entryFolder = dayPath.replace(/\.md$/iu, "");
  return changedPaths.some((path) => path === dayPath || path.startsWith(`${entryFolder}/`));
}
