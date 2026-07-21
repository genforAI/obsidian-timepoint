import { describe, expect, it } from "vitest";
import { parseDayFile } from "../src/storage/TimePointParser";
import {
  createTimePointEntry,
  serializeDayFile,
  serializeEntry,
} from "../src/storage/TimePointSerializer";

function entry(overrides: Partial<ReturnType<typeof createTimePointEntry>> = {}) {
  return {
    ...createTimePointEntry({
      id: "tp-20260718-081500-a1",
      date: "2026-07-18",
      time: "08:15",
      timezone: "Asia/Shanghai",
      contentMarkdown: "### Morning Plan\n\n- Review notes\n- 写下想法\n\n#planning",
      tags: ["planning"],
      source: "manual",
      createdAt: "2026-07-18T08:15:00+08:00",
      updatedAt: "2026-07-18T08:15:00+08:00",
    }),
    ...overrides,
  };
}

describe("canonical TimePoint Markdown", () => {
  it("round-trips a complete entry", () => {
    const original = entry();
    const markdown = serializeDayFile(original.date, original.timezone, [original]);
    expect(markdown).toContain(`<!-- timepoint:entry:start id="${original.id}" -->`);
    expect(markdown).toContain(`<!-- timepoint:entry:end id="${original.id}" -->`);
    expect(markdown).toContain(`## 08:15 ^${original.id}`);

    const parsed = parseDayFile(markdown, { expectedDate: "2026-07-18" });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries).toEqual([original]);
  });

  it("round-trips rich multilingual Markdown without changing Schema 1", () => {
    const contentMarkdown = [
      "# 一级标题",
      "## Secondary heading",
      "### Título español",
      "#### العنوان",
      "##### 日本語",
      "###### 한국어",
      "",
      "- bullet item",
      "1. numbered item",
      "- [ ] 未完成任务",
      "- [x] completed task",
      "",
      "[[Project Note]] and ![[diagram.png]]",
      "[normal link](https://example.com/path?q=时间)",
      "",
      "> [!note] Compact callout",
      "> 中文、English、emoji 🌙",
      "",
      "| Time | Event |",
      "| --- | --- |",
      "| 08:15 | 计划 |",
      "",
      "<!-- a safe user-authored HTML comment -->",
      "",
      "```markdown",
      '<!-- timepoint:entry:start id="documentation-example" -->',
      '<!-- timepoint:entry:end id="documentation-example" -->',
      "```",
      "",
      "`inline code` and **bold** and _italic_",
    ].join("\n");
    const original = entry({ contentMarkdown, tags: ["多语言", "roundtrip"] });

    const parsed = parseDayFile(serializeDayFile(original.date, original.timezone, [original]), {
      expectedDate: original.date,
    });

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.entries).toEqual([original]);
  });

  it("round-trips canonical entries with CRLF line endings", () => {
    const original = entry({ contentMarkdown: "段落一\n\n- item\n- 项目" });
    const crlf = serializeDayFile(original.date, original.timezone, [original]).replaceAll(
      "\n",
      "\r\n",
    );

    const parsed = parseDayFile(crlf, { expectedDate: original.date });

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries[0]).toEqual({
      ...original,
      contentMarkdown: original.contentMarkdown.replaceAll("\n", "\r\n"),
    });
  });

  it("uses the visible heading after a careful manual time edit", () => {
    const markdown = serializeDayFile("2026-07-18", "Asia/Shanghai", [entry()]).replace(
      "## 08:15 ^tp-20260718-081500-a1",
      "## 09:45 ^tp-20260718-081500-a1",
    );
    const parsed = parseDayFile(markdown, { expectedDate: "2026-07-18" });
    expect(parsed.entries[0]?.time).toBe("09:45");
    expect(parsed.entries[0]?.minuteOfDay).toBe(585);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "METADATA_TIME_MISMATCH",
    );
  });

  it("recovers from malformed hidden JSON using the readable heading and frontmatter", () => {
    const markdown = serializeDayFile("2026-07-18", "UTC", [entry({ timezone: "UTC" })]).replace(
      /<!-- timepoint\s[\s\S]*?-->/,
      "<!-- timepoint\n{ definitely-not-json }\n-->",
    );
    const parsed = parseDayFile(markdown, { expectedDate: "2026-07-18" });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      id: "tp-20260718-081500-a1",
      date: "2026-07-18",
      time: "08:15",
    });
    expect(parsed.entries[0]?.contentMarkdown).toContain("写下想法");
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("MALFORMED_METADATA");
  });

  it("reports duplicate IDs and retains only the first unambiguous entry", () => {
    const block = serializeEntry(entry());
    const markdown = `${serializeDayFile("2026-07-18", "UTC")}\n${block}\n\n${block}\n`;
    const parsed = parseDayFile(markdown, { expectedDate: "2026-07-18" });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("DUPLICATE_ID");
  });

  it("isolates broken markers instead of failing the whole day", () => {
    const broken = '<!-- timepoint:entry:start id="tp-broken" -->\n## 10:00 ^tp-broken\n';
    const markdown = `${serializeDayFile("2026-07-18", "UTC")}\n${broken}\n${serializeEntry(entry())}\n`;
    const parsed = parseDayFile(markdown, { expectedDate: "2026-07-18" });
    expect(parsed.entries.map((candidate) => candidate.id)).toEqual(["tp-20260718-081500-a1"]);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("MISSING_END_MARKER");
  });

  it("ignores marker examples inside fenced code", () => {
    const codeExample = [
      "```markdown",
      '<!-- timepoint:entry:start id="example" -->',
      '<!-- timepoint:entry:end id="example" -->',
      "```",
    ].join("\n");
    const markdown = `${serializeDayFile("2026-07-18", "UTC")}\n${codeExample}\n\n${serializeEntry(entry())}\n`;
    const parsed = parseDayFile(markdown, { expectedDate: "2026-07-18" });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("never materializes 24:00 as a stored entry", () => {
    const markdown = serializeDayFile("2026-07-18", "UTC", [entry()]).replaceAll("08:15", "24:00");
    const parsed = parseDayFile(markdown, { expectedDate: "2026-07-18" });
    expect(parsed.entries).toEqual([]);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("INVALID_TIME");
  });

  it("sorts reconstructed entries chronologically and deterministically", () => {
    const late = entry({ id: "tp-late", time: "22:00", minuteOfDay: 1320 });
    const early = entry({ id: "tp-early", time: "00:00", minuteOfDay: 0 });
    const markdown = `${serializeDayFile("2026-07-18", "UTC")}\n${serializeEntry(late)}\n\n${serializeEntry(early)}\n`;
    expect(parseDayFile(markdown).entries.map((candidate) => candidate.id)).toEqual([
      "tp-early",
      "tp-late",
    ]);
  });

  it("marks a future day schema as an error so callers treat the file as read-only", () => {
    const futureDay = serializeDayFile("2026-07-18", "UTC", [entry()]).replace(
      "timepoint-schema: 1",
      "timepoint-schema: 2",
    );
    const parsed = parseDayFile(futureDay, { expectedDate: "2026-07-18" });

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "UNSUPPORTED_SCHEMA",
      }),
    );
  });

  it("marks a future entry schema as an error while preserving a readable recovery view", () => {
    const futureEntry = serializeDayFile("2026-07-18", "UTC", [entry()])
      .replace('"schemaVersion": 1', '"schemaVersion": 2')
      .replace('"tags": []', '"futureOwnedField": "must survive",\n  "tags": []');
    const parsed = parseDayFile(futureEntry, { expectedDate: "2026-07-18" });

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "UNSUPPORTED_SCHEMA",
        entryId: "tp-20260718-081500-a1",
      }),
    );
  });

  it("marks unknown entry metadata as an error without dropping the readable entry", () => {
    const extended = serializeDayFile("2026-07-18", "UTC", [entry()]).replace(
      '"tags": [',
      '"userExtension": { "mustSurvive": true },\n  "tags": [',
    );
    const parsed = parseDayFile(extended, { expectedDate: "2026-07-18" });

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "UNKNOWN_METADATA_FIELD",
        entryId: "tp-20260718-081500-a1",
      }),
    );
    expect(parsed.rawMarkdown).toContain('"mustSurvive": true');
  });
});
