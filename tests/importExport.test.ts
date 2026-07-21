import { describe, expect, it } from "vitest";
import type { TimePointEntry } from "../src/model/types";
import {
  applyImportPlan,
  exportTimePointCsv,
  exportTimePointJson,
  exportTimePointMarkdown,
  fingerprintImportPlans,
  parseCsvRecords,
  parseTimePointCsv,
  parseTimePointJson,
  parseTimePointMarkdown,
  planImport,
} from "../src/import-export";
import { serializeStandaloneEntry } from "../src/storage";

function entry(overrides: Partial<TimePointEntry> = {}): TimePointEntry {
  return {
    id: "tp-20260718-081500-a1",
    date: "2026-07-18",
    time: "08:15",
    minuteOfDay: 495,
    timezone: "Asia/Shanghai",
    contentMarkdown: '### Morning plan\n\n- Review yesterday\n- Say "hello", again',
    tags: ["planning", "morning"],
    source: "manual",
    createdAt: "2026-07-18T08:15:00+08:00",
    updatedAt: "2026-07-18T08:16:00+08:00",
    ...overrides,
  };
}

describe("TimePoint JSON import/export", () => {
  it("round-trips all user-facing entry data", () => {
    const original = entry();
    const exported = exportTimePointJson([original], {
      date: original.date,
      timezone: original.timezone,
    });
    const parsed = parseTimePointJson(exported);

    expect(parsed).toMatchObject({ ok: true, issues: [] });
    expect(parsed.entries).toEqual([original]);
  });

  it("provides deterministic timestamps for minimal interoperable JSON", () => {
    const parsed = parseTimePointJson(
      JSON.stringify({
        schemaVersion: 1,
        date: "2026-07-18",
        entries: [{ id: "tp-minimal", time: "00:00", content: "Midnight", tags: [] }],
      }),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.entries[0]).toMatchObject({
      id: "tp-minimal",
      minuteOfDay: 0,
      source: "import-json",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
  });

  it.each([
    [
      "unsupported schema",
      { schemaVersion: 2, date: "2026-07-18", entries: [] },
      "unsupported-schema",
    ],
    ["impossible date", { schemaVersion: 1, date: "2026-02-29", entries: [] }, "invalid-date"],
  ])("rejects %s", (_label, document, code) => {
    const parsed = parseTimePointJson(JSON.stringify(document));
    expect(parsed.ok).toBe(false);
    expect(parsed.entries).toEqual([]);
    expect(parsed.issues[0]?.code).toBe(code);
  });

  it("rejects 24:00 without discarding unrelated valid rows", () => {
    const parsed = parseTimePointJson(
      JSON.stringify({
        schemaVersion: 1,
        date: "2026-07-18",
        entries: [
          { id: "tp-good", time: "23:59", content: "Valid" },
          { id: "tp-bad", time: "24:00", content: "Invalid" },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.entries.map(({ id }) => id)).toEqual(["tp-good"]);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: "invalid-time", row: 2 }));
  });

  it("blocks duplicate IDs inside one JSON document before planning any write", () => {
    const parsed = parseTimePointJson(
      JSON.stringify({
        schemaVersion: 1,
        date: "2026-07-18",
        entries: [
          { id: "tp-duplicate", time: "08:00", content: "First" },
          { id: "tp-duplicate", time: "09:00", content: "Second" },
        ],
      }),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: "duplicate-id", row: 2, field: "id" }),
    );
    expect(() => planImport([parsed.entries[0]!, parsed.entries[0]!], [], "replace")).toThrow(
      /incoming ID .* more than once.*nothing was written/i,
    );
  });
});

describe("TimePoint CSV import/export", () => {
  it("round-trips commas, quotes, multiline Markdown, and tags", () => {
    const original = entry({
      contentMarkdown: 'Line one, with comma\nLine two with "quotes"\n\n- item',
      tags: ["one,comma", "two"],
    });
    const exported = exportTimePointCsv([original]);
    const parsed = parseTimePointCsv(exported);

    expect(exported).toContain('"Line one, with comma\nLine two with ""quotes""');
    expect(parsed).toMatchObject({ ok: true, issues: [] });
    expect(parsed.entries).toEqual([original]);
  });

  it("parses RFC4180 quoted records directly", () => {
    expect(parseCsvRecords('a,b\r\n"one\r\ntwo","say ""hello"""\r\n')).toEqual([
      ["a", "b"],
      ["one\r\ntwo", 'say "hello"'],
    ]);
  });

  it("reports malformed quoting and invalid rows", () => {
    const malformed = parseTimePointCsv(
      'date,time,id,content\r\n2026-07-18,08:15,tp-one,"unclosed',
    );
    expect(malformed.ok).toBe(false);
    expect(malformed.issues[0]?.code).toBe("invalid-csv");

    const badValues = parseTimePointCsv("date,time,id,content\r\n2026-02-29,24:00,tp-bad,bad\r\n");
    expect(badValues.entries).toEqual([]);
    expect(badValues.issues.map(({ code }) => code)).toEqual([
      "invalid-date",
      "invalid-time",
      "invalid-timestamp",
      "invalid-timestamp",
    ]);
  });

  it("blocks duplicate IDs inside one CSV document", () => {
    const parsed = parseTimePointCsv(
      [
        "date,time,id,content",
        "2026-07-18,08:00,tp-duplicate,First",
        "2026-07-18,09:00,tp-duplicate,Second",
      ].join("\r\n"),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: "duplicate-id", row: 3, field: "id" }),
    );
  });
});

describe("Markdown export", () => {
  it("imports both a portable event note and a complete day export", () => {
    const original = entry();
    const portableEvent = parseTimePointMarkdown(serializeStandaloneEntry(original));
    const portableDay = parseTimePointMarkdown(
      exportTimePointMarkdown([original], {
        date: original.date,
        timezone: original.timezone,
      }),
    );

    expect(portableEvent).toMatchObject({ ok: true, issues: [], entries: [original] });
    expect(portableDay).toMatchObject({ ok: true, issues: [], entries: [original] });
  });

  it("blocks malformed portable Markdown before planning a write", () => {
    const malformed = serializeStandaloneEntry(entry()).replace('time: "08:15"', "time: 25:00");
    const parsed = parseTimePointMarkdown(malformed);
    expect(parsed.ok).toBe(false);
    const invalidTime = parsed.issues.find((issue) => issue.code === "invalid-markdown");
    expect(invalidTime?.message).toMatch(/INVALID_TIME/);
  });

  it("is deterministic, chronological, Markdown-readable, and stores no layout pixels", () => {
    const later = entry();
    const earlier = entry({
      id: "tp-early",
      time: "07:00",
      minuteOfDay: 420,
      contentMarkdown: "Earlier",
    });
    const markdown = exportTimePointMarkdown([later, earlier], {
      date: "2026-07-18",
      timezone: "Asia/Shanghai",
    });

    expect(markdown).toContain("timepoint-schema: 1");
    expect(markdown.indexOf("## 07:00")).toBeLessThan(markdown.indexOf("## 08:15"));
    expect(markdown).toContain('<!-- timepoint:entry:start id="tp-early" -->');
    expect(markdown).toContain('<!-- timepoint:entry:end id="tp-early" -->');
    expect(markdown).toContain("Earlier");
    expect(markdown).not.toMatch(/pixel|top|left|position/i);
  });

  it("rejects note content that could collide with canonical entry boundaries", () => {
    expect(() =>
      exportTimePointMarkdown(
        [
          entry({
            contentMarkdown: 'Before\n<!-- timepoint:entry:end id="tp-forged" -->\nAfter',
          }),
        ],
        { date: "2026-07-18" },
      ),
    ).toThrow(/reserved TimePoint boundary marker/);
  });

  it("allows marker documentation inside fenced code without creating a boundary", () => {
    const contentMarkdown = [
      "```markdown",
      '<!-- timepoint:entry:start id="documented-example" -->',
      '<!-- timepoint:entry:end id="documented-example" -->',
      "```",
    ].join("\n");

    const exported = exportTimePointMarkdown([entry({ contentMarkdown })], {
      date: "2026-07-18",
    });
    const plan = planImport([entry({ contentMarkdown })], [], "skip");

    expect(exported).toContain(contentMarkdown);
    expect(plan).toMatchObject({ insertCount: 1, rejectCount: 0 });
  });
});

describe("duplicate conflict planning", () => {
  const existing = entry({ contentMarkdown: "Existing" });
  const incoming = entry({ contentMarkdown: "Incoming" });

  it("makes skip explicit and leaves existing data untouched", () => {
    const plan = planImport([incoming], [existing], "skip");
    expect(plan).toMatchObject({ conflictCount: 1, skipCount: 1 });
    expect(plan.actions[0]?.kind).toBe("skip");
    expect(applyImportPlan([existing], plan)).toEqual([existing]);
  });

  it("makes replacement explicit", () => {
    const plan = planImport([incoming], [existing], "replace");
    expect(plan).toMatchObject({ conflictCount: 1, replaceCount: 1 });
    expect(plan.actions[0]).toMatchObject({
      kind: "replace",
      replacedEntry: { contentMarkdown: "Existing" },
      entry: { contentMarkdown: "Incoming" },
    });
    expect(applyImportPlan([existing], plan)[0]?.contentMarkdown).toBe("Incoming");
  });

  it("changes the preview fingerprint when a target appears or changes before commit", () => {
    const noConflict = planImport([incoming], [], "replace");
    const appeared = planImport([incoming], [existing], "replace");
    const changed = planImport(
      [incoming],
      [entry({ contentMarkdown: "Externally changed", updatedAt: "2026-07-18T09:00:00Z" })],
      "replace",
    );

    expect(fingerprintImportPlans([noConflict])).not.toBe(fingerprintImportPlans([appeared]));
    expect(fingerprintImportPlans([appeared])).not.toBe(fingerprintImportPlans([changed]));
  });

  it("generates a deterministic unused ID without mutating the incoming object", () => {
    const occupiedImportId = entry({ id: `${incoming.id}-import-1` });
    const plan = planImport([incoming], [existing, occupiedImportId], "new-id");
    expect(plan.actions.map((action) => action.entry.id)).toEqual([`${incoming.id}-import-2`]);
    expect(incoming.id).toBe("tp-20260718-081500-a1");
    expect(applyImportPlan([existing, occupiedImportId], plan).map(({ id }) => id)).toEqual([
      existing.id,
      `${incoming.id}-import-1`,
      `${incoming.id}-import-2`,
    ]);
  });

  it("rejects duplicate incoming IDs before creating a replace plan", () => {
    expect(() => planImport([incoming, { ...incoming }], [existing], "replace")).toThrow(
      /incoming ID .* more than once.*nothing was written/i,
    );
  });

  it("keeps generated IDs inside the canonical 128-character storage limit", () => {
    const longId = `tp-${"a".repeat(125)}`;
    const longEntry = entry({ id: longId });
    const plan = planImport([longEntry], [longEntry], "new-id");
    const action = plan.actions[0];
    expect(action?.kind).toBe("rename-and-insert");
    expect(action?.entry.id).toHaveLength(128);
    expect(action?.entry.id).toMatch(/-import-1$/u);
  });

  it("rejects invalid typed entries instead of applying them", () => {
    const invalid = entry({ time: "24:00", minuteOfDay: 1440 });
    const plan = planImport([invalid], [], "replace");
    expect(plan).toMatchObject({ rejectCount: 1, insertCount: 0 });
    expect(plan.actions[0]?.kind).toBe("reject");
    expect(applyImportPlan([], plan)).toEqual([]);
  });

  it("rejects IDs or note markers that canonical storage cannot safely write", () => {
    const plan = planImport(
      [
        entry({ id: "tp_invalid_underscore" }),
        entry({
          id: "tp-marker-collision",
          contentMarkdown: '<!-- timepoint:entry:start id="forged" -->',
        }),
        entry({ id: "tp-unsafe-timezone", timezone: "UTC --> forged" }),
        entry({ id: "tp-unsafe-source", source: "import --> forged" }),
        entry({ id: "tp-unsafe-tag", tags: ["forged-->tag"] }),
      ],
      [],
      "skip",
    );

    expect(plan).toMatchObject({ rejectCount: 5, insertCount: 0 });
    expect(plan.actions.every((action) => action.kind === "reject")).toBe(true);
  });
});
