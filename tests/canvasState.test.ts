import { describe, expect, it } from "vitest";
import {
  createCardLayout,
  parseCardLayoutFrontmatter,
  sanitizeCardLayout,
} from "../src/storage/CardLayoutMetadata";
import {
  defaultDayViewState,
  parseDayViewState,
  serializeDayViewStateBlock,
  updateViewportState,
  upsertDayViewState,
} from "../src/storage/DayViewState";
import {
  parseStandaloneEntry,
  serializeStandaloneEntry,
  updateStandaloneCardLayoutMarkdown,
  updateStandaloneSnapshotIdsMarkdown,
} from "../src/storage/StandaloneEntryFile";
import { createTimePointEntry } from "../src/storage/TimePointSerializer";
import { LayoutHistory, inverseLayoutMutation } from "../src/views/layoutHistory";

const event = createTimePointEntry({
  id: "tp-layout-test",
  date: "2026-07-21",
  time: "08:15",
  contentMarkdown: "正文\n\n![[image.png]]",
  tags: ["safe"],
  createdAt: "2026-07-21T08:15:00.000Z",
  updatedAt: "2026-07-21T08:15:00.000Z",
});

describe("card layout metadata", () => {
  it("round-trips the optional Schema 1 extension", () => {
    const layout = createCardLayout({
      x: 0.333333333,
      y: 0.75,
      width: 0.45,
      height: 180,
      updatedAt: "2026-07-21T12:00:00.000Z",
    });
    const parsed = parseStandaloneEntry(serializeStandaloneEntry({ ...event, cardLayout: layout }));
    expect(parsed.entry?.cardLayout).toEqual({ ...layout, x: 0.333333 });
  });

  it("clamps finite raw values but ignores incomplete and unsafe groups", () => {
    expect(
      sanitizeCardLayout({
        schemaVersion: 1,
        x: -4,
        y: 8,
        width: 0.01,
        height: 5000,
        updatedAt: "2026-07-21T12:00:00.000Z",
      }),
    ).toMatchObject({ x: 0, y: 1, width: 0.2, height: 720 });
    const incomplete = parseCardLayoutFrontmatter({
      "timepoint-card-schema": 1,
      "timepoint-card-x": 0.5,
    });
    expect(incomplete.layout).toBeUndefined();
    expect(incomplete.warning).toEqual(expect.any(String));
    expect(
      sanitizeCardLayout({
        schemaVersion: 2,
        x: 0.5,
        y: 0.5,
        width: 0.5,
        height: 100,
        updatedAt: "bad",
      }),
    ).toBeNull();
  });

  it("changes only layout frontmatter and preserves all business bytes", () => {
    const original = serializeStandaloneEntry(event).replace(
      'source: "manual"',
      'source: "manual"\naliases:\n  - Important',
    );
    const body = original.slice(original.indexOf("---\n\n") + 4);
    const businessLines = original
      .split("\n")
      .filter((line) => /^(?:id|date|time|createdAt|updatedAt|tags|source):/u.test(line));
    const next = updateStandaloneCardLayoutMarkdown(
      original,
      createCardLayout({ x: 0.6, y: 0.4, width: 0.5, height: 200 }),
    );
    expect(next.slice(next.indexOf("---\n\n") + 4)).toBe(body);
    expect(
      next
        .split("\n")
        .filter((line) => /^(?:id|date|time|createdAt|updatedAt|tags|source):/u.test(line)),
    ).toEqual(businessLines);
    expect(next).toContain("aliases:\n  - Important");
    expect(updateStandaloneCardLayoutMarkdown(next, null)).toBe(original);
  });

  it("updates snapshot associations without touching body or business timestamps", () => {
    const original = serializeStandaloneEntry(event);
    const id = "a".repeat(64);
    const associated = updateStandaloneSnapshotIdsMarkdown(original, [id, id]);
    expect(associated).toContain(`timepoint-link-snapshots: ["${id}"]`);
    expect(parseStandaloneEntry(associated).entry?.linkSnapshotIds).toEqual([id]);
    expect(updateStandaloneSnapshotIdsMarkdown(associated, [])).toBe(original);
  });
});

describe("day view state", () => {
  it("round-trips viewport, stack and relation state", () => {
    const state = updateViewportState(defaultDayViewState(), "elastic", {
      zoom: 2.25,
      centerX: 0.2,
      centerY: 0.8,
      verticalScale: 2.4,
    });
    state.stackOrder = ["tp-a", "tp-b"];
    state.relationsEnabled = true;
    const markdown = `# Day\n\n${serializeDayViewStateBlock(state)}\n`;
    expect(parseDayViewState(markdown)).toMatchObject({ status: "valid", state });
  });

  it("preserves a future block and refuses to treat it as current state", () => {
    const future = '<!-- timepoint:view-state\n{"schemaVersion":99,"future":true}\n-->';
    const parsed = parseDayViewState(`# Day\n\n${future}\n`);
    expect(parsed.status).toBe("future");
    expect(parsed.rawBlock).toBe(`${future}\n`);
    expect(parsed.state).toEqual(defaultDayViewState());
  });

  it("updates one managed block without rewriting surrounding Markdown", () => {
    const original = "# User heading\n\nKeep this paragraph.\n";
    const withState = upsertDayViewState(original, defaultDayViewState());
    const changed = updateViewportState(defaultDayViewState(), "realtime", {
      zoom: 3,
      centerX: 1,
      centerY: 1,
    });
    const updated = upsertDayViewState(withState, changed);
    expect(updated).toContain(original.trimEnd());
    expect(updated.match(/timepoint:view-state/gu)).toHaveLength(1);
    expect(parseDayViewState(updated).state.modes.realtime.zoom).toBe(3);
  });
});

describe("layout history", () => {
  it("tracks per-day undo/redo without changing business data", () => {
    const layout = createCardLayout({ x: 0.4, y: 0.3, width: 0.5, height: 160 });
    const history = new LayoutHistory();
    const committed = history.push({
      date: event.date,
      entryId: event.id,
      before: null,
      after: layout,
      reason: "move",
    });
    expect(history.takeUndo("2026-07-20")).toBeNull();
    expect(inverseLayoutMutation(history.takeUndo(event.date) ?? committed)).toMatchObject({
      entryId: event.id,
      before: layout,
      after: null,
    });
    expect(history.takeRedo(event.date)).toMatchObject({ entryId: event.id, after: layout });
  });
});
