import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class TFile {},
  TFolder: class TFolder {},
  normalizePath: (value: string) => value.replace(/\/{2,}/gu, "/"),
}));
import type { TimePointEntry } from "../src/model/types";
import {
  exportTimePointCsv,
  exportTimePointRangeJson,
  exportTimePointRangeMarkdown,
  parseTimePointCsv,
  parseTimePointJson,
  parseTimePointMarkdown,
} from "../src/import-export";
import { enumerateExportDates } from "../src/services/ExportService";

function entry(date: string, time: string, id: string): TimePointEntry {
  return {
    id,
    date,
    time,
    minuteOfDay: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
    contentMarkdown: `# ${date}\n\n${id}`,
    tags: ["range"],
    source: "test",
    createdAt: `${date}T${time}:00.000Z`,
    updatedAt: `${date}T${time}:00.000Z`,
  };
}

describe("inclusive export ranges", () => {
  it("covers leap day and enforces the 366-day ceiling", () => {
    expect(
      enumerateExportDates({
        kind: "range",
        startDate: "2028-02-28",
        endDate: "2028-03-01",
      }),
    ).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
    expect(
      enumerateExportDates({
        kind: "range",
        startDate: "2028-01-01",
        endDate: "2028-12-31",
      }),
    ).toHaveLength(366);
    expect(() =>
      enumerateExportDates({
        kind: "range",
        startDate: "2027-01-01",
        endDate: "2028-01-02",
      }),
    ).toThrow(/366/);
  });

  it("round-trips multi-day JSON, Markdown, and CSV", () => {
    const entries = [
      entry("2028-02-28", "23:55", "tp-before-leap"),
      entry("2028-02-29", "08:05", "tp-leap"),
      entry("2028-03-01", "00:10", "tp-after-leap"),
    ];
    const scope = { startDate: "2028-02-28", endDate: "2028-03-01" };

    const json = exportTimePointRangeJson(entries, scope);
    const markdown = exportTimePointRangeMarkdown(entries, scope);
    const csv = exportTimePointCsv(entries);

    expect(json).toContain('"timepointRangeSchema": 1');
    expect(markdown).toContain("timepoint-range-schema: 1");
    expect(parseTimePointJson(json)).toMatchObject({ ok: true, issues: [], entries });
    expect(parseTimePointMarkdown(markdown)).toMatchObject({ ok: true, issues: [], entries });
    expect(parseTimePointCsv(csv)).toMatchObject({ ok: true, issues: [], entries });
  });

  it("preserves optional card geometry and snapshot associations in every exchange format", () => {
    const snapshotId = "a".repeat(64);
    const withLayout: TimePointEntry = {
      ...entry("2028-02-29", "08:05", "tp-layout"),
      cardLayout: {
        schemaVersion: 1,
        x: 0.812345,
        y: 0.234567,
        width: 0.42,
        height: 214,
        updatedAt: "2028-02-29T10:00:00.000Z",
      },
      linkSnapshotIds: [snapshotId],
    };
    const scope = { startDate: "2028-02-29", endDate: "2028-02-29" };

    for (const parsed of [
      parseTimePointJson(exportTimePointRangeJson([withLayout], scope)),
      parseTimePointMarkdown(exportTimePointRangeMarkdown([withLayout], scope)),
      parseTimePointCsv(exportTimePointCsv([withLayout])),
    ]) {
      expect(parsed).toMatchObject({ ok: true, issues: [], entries: [withLayout] });
    }
  });

  it("round-trips an empty range and detects truncated Markdown", () => {
    const scope = { startDate: "2028-02-28", endDate: "2028-03-01" };
    const empty = exportTimePointRangeMarkdown([], scope);
    expect(parseTimePointMarkdown(empty)).toMatchObject({ ok: true, issues: [], entries: [] });

    const full = exportTimePointRangeMarkdown([entry("2028-02-29", "08:05", "tp-leap")], scope);
    const truncated = full.replace(/<!-- timepoint:range-day:start[\s\S]*$/u, "");
    expect(parseTimePointMarkdown(truncated)).toMatchObject({ ok: false });
  });

  it("blocks duplicate IDs and out-of-range dates during re-import", () => {
    const duplicate = JSON.stringify({
      timepointRangeSchema: 1,
      startDate: "2028-02-28",
      endDate: "2028-03-01",
      entries: [
        { id: "tp-same", date: "2028-02-28", time: "08:00", content: "one" },
        { id: "tp-same", date: "2028-03-01", time: "09:00", content: "two" },
      ],
    });
    const outside = JSON.stringify({
      timepointRangeSchema: 1,
      startDate: "2028-02-28",
      endDate: "2028-03-01",
      entries: [{ id: "tp-out", date: "2028-03-02", time: "08:00", content: "outside" }],
    });
    expect(parseTimePointJson(duplicate).issues).toContainEqual(
      expect.objectContaining({ code: "duplicate-id" }),
    );
    expect(parseTimePointJson(outside).issues).toContainEqual(
      expect.objectContaining({ code: "date-mismatch" }),
    );
  });
});
