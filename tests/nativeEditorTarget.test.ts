import { describe, expect, it } from "vitest";

import {
  createTimePointEntry,
  parseDayFile,
  serializeDayFile,
  serializeEntry,
} from "../src/storage";
import { locateNativeEditorTarget } from "../src/views/nativeEditorTarget";

const date = "2026-07-18";
const id = "tp-native-editor-test";

function entry(contentMarkdown: string) {
  return createTimePointEntry({
    id,
    date,
    time: "08:25",
    timezone: "UTC",
    contentMarkdown,
    tags: [],
    createdAt: "2026-07-18T08:25:00.000Z",
    updatedAt: "2026-07-18T08:25:00.000Z",
  });
}

function dayWith(block: string): string {
  return `${serializeDayFile(date, "UTC")}\n${block}\n`;
}

describe("native Obsidian editor target", () => {
  it("positions the cursor at user Markdown, after heading and hidden metadata", () => {
    const markdown = dayWith(serializeEntry(entry("First line\n\nSecond line")));
    const target = locateNativeEditorTarget(markdown, id);

    expect(target).not.toBeNull();
    expect(markdown.slice(target?.contentStart, target?.contentEnd)).toBe(
      "First line\n\nSecond line",
    );
    expect(target?.cursorOffset).toBe(markdown.indexOf("First line"));
    expect(target?.preparation).toBeUndefined();
  });

  it("keeps a safe blank editing line for a newly created empty entry", () => {
    const markdown = dayWith(serializeEntry(entry("")));
    const target = locateNativeEditorTarget(markdown, id);
    expect(target?.preparation).toBeUndefined();
    if (!target) throw new Error("missing editor target");

    const edited = `${markdown.slice(0, target.cursorOffset)}Native editor text${markdown.slice(
      target.cursorOffset,
    )}`;
    expect(parseDayFile(edited, { expectedDate: date }).entries[0]?.contentMarkdown).toBe(
      "Native editor text",
    );
  });

  it("repairs legacy empty blocks with only one line break before the end marker", () => {
    const current = serializeEntry(entry(""));
    const legacy = dayWith(
      current.replace(
        `-->\n\n<!-- timepoint:entry:end id="${id}" -->`,
        `-->\n<!-- timepoint:entry:end id="${id}" -->`,
      ),
    );
    const target = locateNativeEditorTarget(legacy, id);
    expect(target?.preparation?.text).toBe("\n");
    if (!target?.preparation) throw new Error("missing legacy preparation");

    const prepared = `${legacy.slice(0, target.preparation.offset)}${target.preparation.text}${legacy.slice(
      target.preparation.offset,
    )}`;
    const edited = `${prepared.slice(0, target.cursorOffset)}Recovered${prepared.slice(
      target.cursorOffset,
    )}`;
    expect(parseDayFile(edited, { expectedDate: date }).entries[0]?.contentMarkdown).toBe(
      "Recovered",
    );
  });

  it("refuses to guess when the same managed ID is duplicated", () => {
    const block = serializeEntry(entry("Body"));
    expect(locateNativeEditorTarget(dayWith(`${block}\n\n${block}`), id)).toBeNull();
  });

  it("preserves CRLF while preparing and editing an empty body", () => {
    const block = serializeEntry(entry(""), "\r\n");
    const markdown = `${serializeDayFile(date, "UTC").replaceAll("\n", "\r\n")}\r\n${block}\r\n`;
    const target = locateNativeEditorTarget(markdown, id);
    expect(target?.preparation).toBeUndefined();
    if (!target) throw new Error("missing CRLF editor target");

    const edited = `${markdown.slice(0, target.cursorOffset)}CRLF body${markdown.slice(
      target.cursorOffset,
    )}`;
    expect(parseDayFile(edited, { expectedDate: date }).entries[0]?.contentMarkdown).toBe(
      "CRLF body",
    );
    expect(edited).toContain("-->\r\nCRLF body\r\n<!-- timepoint:entry:end");
    expect(edited.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("returns no target for a missing entry ID", () => {
    const markdown = dayWith(serializeEntry(entry("Body")));
    expect(locateNativeEditorTarget(markdown, "tp-does-not-exist")).toBeNull();
  });
});
