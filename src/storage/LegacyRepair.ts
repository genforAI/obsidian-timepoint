import type { ParseDiagnostic } from "../model/types";
import { parseDayFile } from "./TimePointParser";

export interface LegacyRepairChange {
  code: "COMPLETE_END_MARKER" | "APPEND_END_MARKER";
  entryId: string;
  line: number;
  description: string;
}

export interface LegacyRepairPlan {
  originalMarkdown: string;
  repairedMarkdown: string;
  changes: LegacyRepairChange[];
  diagnosticsBefore: ParseDiagnostic[];
  diagnosticsAfter: ParseDiagnostic[];
  canApply: boolean;
}

/**
 * Plan only conservative repairs whose intent is unambiguous. The caller may
 * present the plan before applying it; this function never writes a vault file.
 */
export function planLegacyDayRepair(markdown: string, expectedDate: string): LegacyRepairPlan {
  const before = parseDayFile(markdown, { expectedDate }).diagnostics;
  const changes: LegacyRepairChange[] = [];
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nearEnd = /^(\s*<!--\s*timepoint:entry:end\s+id="([^"\r\n]+)")\s*(.*?)\s*$/u.exec(line);
    if (!nearEnd) continue;
    const prefix = nearEnd[1];
    const entryId = nearEnd[2];
    const suffix = nearEnd[3] ?? "";
    if (!prefix || !entryId || suffix === "-->" || !["", "-", "--", "->"].includes(suffix)) {
      continue;
    }
    lines[index] = `${prefix} -->`;
    changes.push({
      code: "COMPLETE_END_MARKER",
      entryId,
      line: index + 1,
      description: `Completed the truncated end marker for ${entryId}.`,
    });
  }

  let repairedMarkdown = lines.join(eol);
  let after = parseDayFile(repairedMarkdown, { expectedDate }).diagnostics;
  const remainingErrors = after.filter((item) => item.severity === "error");
  if (
    remainingErrors.length === 1 &&
    remainingErrors[0]?.code === "MISSING_END_MARKER" &&
    remainingErrors[0].entryId
  ) {
    const entryId = remainingErrors[0].entryId;
    const startMarker = `<!-- timepoint:entry:start id="${entryId}" -->`;
    const start = repairedMarkdown.lastIndexOf(startMarker);
    const tail = start >= 0 ? repairedMarkdown.slice(start + startMarker.length) : "";
    const hasMatchingHeading = new RegExp(
      `^##[ \\t]+[^\\r\\n]+[ \\t]+\\^${escapeRegExp(entryId)}[ \\t]*$`,
      "mu",
    ).test(tail);
    const hasMatchingMetadata = tail.includes(`"id": "${entryId}"`);
    const hasLaterManagedStart = /<!--\s*timepoint:entry:start\b/iu.test(tail);
    if (start >= 0 && hasMatchingHeading && hasMatchingMetadata && !hasLaterManagedStart) {
      const separator = repairedMarkdown.endsWith(eol) ? "" : eol;
      repairedMarkdown = `${repairedMarkdown}${separator}<!-- timepoint:entry:end id="${entryId}" -->${eol}`;
      changes.push({
        code: "APPEND_END_MARKER",
        entryId,
        line: repairedMarkdown.slice(0, start).split(/\r?\n/u).length,
        description: `Appended the only missing end marker at the end of the file for ${entryId}.`,
      });
      after = parseDayFile(repairedMarkdown, { expectedDate }).diagnostics;
    }
  }

  const errorsBefore = before.filter((item) => item.severity === "error").length;
  const errorsAfter = after.filter((item) => item.severity === "error").length;
  return {
    originalMarkdown: markdown,
    repairedMarkdown,
    changes,
    diagnosticsBefore: before,
    diagnosticsAfter: after,
    canApply: errorsBefore > 0 && changes.length > 0 && errorsAfter === 0,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
