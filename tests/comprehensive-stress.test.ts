import { describe, expect, it } from "vitest";
import {
  avoidManualCardObstacles,
  freezeCardGeometry,
  moveCardRect,
  rectanglesOverlap,
  resizeCardRect,
  resolveStoredCardGeometry,
  type CanvasBounds,
  type CanvasRect,
} from "../src/layout/CanvasCardLayout";
import {
  calculateElasticTimelineLayout,
  calculateRealtimeTimelineLayout,
  type LayoutEntryInput,
} from "../src/layout";
import type { ResizeHandle } from "../src/model/types";
import { extractMarkdownLinks } from "../src/relations/markdownLinks";
import { validatePublicHttpsUrl } from "../src/services/ExternalSnapshotService";
import {
  createCardLayout,
  defaultDayViewState,
  parseDayViewState,
  parseStandaloneEntry,
  sanitizeDayViewState,
  serializeDayViewStateBlock,
  serializeStandaloneEntry,
  updateStandaloneCardLayoutMarkdown,
} from "../src/storage";
import { createTimePointEntry } from "../src/storage/TimePointSerializer";
import {
  advanceCanvasGesture,
  beginCanvasGesture,
  pendingClickAction,
} from "../src/views/canvasGesture";
import { LayoutHistory } from "../src/views/layoutHistory";

const HANDLES: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

describe("deterministic geometry fuzz", () => {
  it("keeps 12,000 randomized move/resize/freeze cycles finite and in bounds", () => {
    const random = mulberry32(0x71_6d_65);
    for (let index = 0; index < 12_000; index += 1) {
      const viewportWidth = pick(random, [320, 560, 720, 900, 1_200]);
      const zoom = 0.5 + random() * 2.5;
      const bounds: CanvasBounds = {
        left: viewportWidth <= 560 ? 72 : 120,
        top: 36,
        width: Math.max(180, viewportWidth - (viewportWidth <= 560 ? 88 : 152)),
        height: 720 + Math.floor(random() * 12_000),
      };
      const layout = createCardLayout({
        x: random(),
        y: random(),
        width: 0.2 + random() * 0.8,
        height: 72 + random() * 648,
        updatedAt: "2026-07-21T12:00:00.000Z",
      });
      const resolved = resolveStoredCardGeometry(layout, bounds, zoom);
      const moved = moveCardRect(
        resolved,
        (random() - 0.5) * bounds.width * 3,
        (random() - 0.5) * bounds.height * 3,
        bounds,
      );
      const resized = resizeCardRect(
        moved,
        HANDLES[index % HANDLES.length] ?? "se",
        (random() - 0.5) * bounds.width * 3,
        (random() - 0.5) * bounds.height * 3,
        bounds,
        zoom,
      );
      assertFiniteContained(resized, bounds);
      const frozen = freezeCardGeometry(resized, bounds, zoom, "2026-07-21T12:00:00.000Z");
      expect(frozen.x).toBeGreaterThanOrEqual(0);
      expect(frozen.x).toBeLessThanOrEqual(1);
      expect(frozen.y).toBeGreaterThanOrEqual(0);
      expect(frozen.y).toBeLessThanOrEqual(1);
      expect(frozen.width).toBeGreaterThanOrEqual(0.2);
      expect(frozen.width).toBeLessThanOrEqual(1);
      expect(frozen.height).toBeGreaterThanOrEqual(72);
      expect(frozen.height).toBeLessThanOrEqual(720);
      assertFiniteContained(resolveStoredCardGeometry(frozen, bounds, zoom), bounds);
    }
  });

  it("avoids randomized manual obstacles without nondeterminism or overlap", () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const random = mulberry32(seed);
      const bounds: CanvasBounds = { left: 100, top: 20, width: 900, height: 50_000 };
      const manual = Array.from({ length: 50 }, () => ({
        x: 140 + Math.floor(random() * 600),
        y: 20 + Math.floor(random() * 8_000),
        width: 160 + Math.floor(random() * 220),
        height: 72 + Math.floor(random() * 180),
      }));
      const automatic = Array.from({ length: 150 }, (_, index) => ({
        x: 150,
        y: 24 + index * 54,
        width: 720,
        height: 42 + Math.floor(random() * 48),
      }));
      const first = avoidManualCardObstacles(automatic, manual, bounds, 8, 32);
      const second = avoidManualCardObstacles(automatic, manual, bounds, 8, 32);
      expect(first).toEqual(second);
      for (let index = 0; index < first.length; index += 1) {
        const card = first[index];
        expect(card).toBeDefined();
        if (!card) continue;
        expect(manual.every((obstacle) => !rectanglesOverlap(card, obstacle, 7.999))).toBe(true);
        expect(
          first.slice(0, index).every((placed) => !rectanglesOverlap(card, placed, 7.999)),
        ).toBe(true);
      }
    }
  });
});

describe("large mixed timeline layouts", () => {
  it("keeps 1,000 automatic/manual events deterministic, ordered, and collision-free", () => {
    const random = mulberry32(0x0b_51_d1_a7);
    const input: LayoutEntryInput[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `stress-${index.toString().padStart(4, "0")}`,
      minuteOfDay: Math.floor(random() * 1_440),
      measuredHeight: 36 + Math.floor(random() * 180),
      manual: index % 4 === 0,
    }));
    const options = {
      minimumHeight: 1_200,
      topPadding: 36,
      bottomPadding: 44,
      cardGap: 7,
      maximumColumns: 5,
    };
    const realtime = calculateRealtimeTimelineLayout(input, options);
    const realtimeReverse = calculateRealtimeTimelineLayout([...input].reverse(), options);
    const elastic = calculateElasticTimelineLayout(input, options);
    const elasticReverse = calculateElasticTimelineLayout([...input].reverse(), options);

    expect(realtime.entries).toEqual(realtimeReverse.entries);
    expect(elastic.entries).toEqual(elasticReverse.entries);
    expect(realtime.entries).toHaveLength(1_000);
    expect(elastic.entries).toHaveLength(1_000);
    assertChronological(realtime.entries);
    assertChronological(elastic.entries);

    const manualIds = new Set(input.filter((entry) => entry.manual).map((entry) => entry.id));
    for (let column = 0; column < realtime.columnCount; column += 1) {
      assertNoVerticalOverlap(
        realtime.entries.filter((entry) => entry.column === column && !manualIds.has(entry.id)),
        options.cardGap,
      );
    }
    assertNoVerticalOverlap(
      elastic.entries.filter((entry) => !manualIds.has(entry.id)),
      options.cardGap,
    );

    for (const result of [realtime, elastic]) {
      for (let minute = 0; minute < 1_440; minute += 1) {
        expect(result.yToMinute(result.minuteToY(minute))).toBe(minute);
      }
    }
  });
});

describe("combined storage and state stress", () => {
  it("preserves Unicode Markdown and business metadata through 256 layout mutations", () => {
    for (let index = 0; index < 256; index += 1) {
      const time = `${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`;
      const content = [
        `# 压力记录 ${index} 🧪`,
        "",
        "中英混排 café — مرحبا — हिन्दी — 👨‍👩‍👧‍👦",
        "",
        `| index | value |\n| ---: | --- |\n| ${index} | ${"长文本".repeat(index % 17)} |`,
        "",
        "```ts\nconst safe = true;\n```",
        "",
        "---",
        "正文中的分隔线必须保留。",
      ].join("\n");
      const entry = createTimePointEntry({
        id: `tp-unicode-${index.toString().padStart(3, "0")}`,
        date: "2026-07-21",
        time,
        contentMarkdown: content,
        tags: ["压力", `case-${index}`],
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      });
      const original = serializeStandaloneEntry(entry);
      const changed = updateStandaloneCardLayoutMarkdown(
        original,
        createCardLayout({
          x: (index % 17) / 16,
          y: (index % 29) / 28,
          width: 0.2 + (index % 9) * 0.1,
          height: 72 + (index % 19) * 34,
          updatedAt: "2026-07-21T12:00:00.000Z",
        }),
      );
      const parsed = parseStandaloneEntry(changed).entry;
      expect(parsed).toMatchObject({
        id: entry.id,
        date: entry.date,
        time: entry.time,
        contentMarkdown: content,
        tags: entry.tags,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
      expect(updateStandaloneCardLayoutMarkdown(changed, null)).toBe(original);
    }
  });

  it("caps and sanitizes adversarial daily state without mutating the input", () => {
    const input = defaultDayViewState();
    input.stackOrder = [
      ...Array.from({ length: 700 }, (_, index) => `tp-${index.toString().padStart(3, "0")}`),
      "tp-001",
      "unsafe id",
    ];
    input.modes.elastic = { zoom: 99, centerX: -4, centerY: 8 };
    for (let index = 0; index < 80; index += 1) {
      const id = `ref-note-${index.toString().padStart(3, "0")}`;
      input.referenceCards[id] = {
        id,
        kind: "local-note",
        target: `Notes/${index}.md`,
        x: index % 2 ? -5 : 5,
        y: index % 3 ? -5 : 5,
        width: index % 2 ? 0.01 : 9,
        height: index % 2 ? 1 : 9_000,
        expanded: index % 2 === 0,
      };
    }
    const before = JSON.stringify(input);
    const safe = sanitizeDayViewState(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(safe?.stackOrder).toHaveLength(500);
    expect(Object.keys(safe?.referenceCards ?? {})).toHaveLength(50);
    expect(safe?.modes.elastic).toEqual({
      zoom: 3,
      centerX: 0,
      centerY: 1,
      verticalScale: 1,
    });
    for (const card of Object.values(safe?.referenceCards ?? {})) {
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x).toBeLessThanOrEqual(1);
      expect(card.width).toBeGreaterThanOrEqual(0.2);
      expect(card.width).toBeLessThanOrEqual(1);
      expect(card.height).toBeGreaterThanOrEqual(72);
      expect(card.height).toBeLessThanOrEqual(720);
    }
    expect(
      parseDayViewState(serializeDayViewStateBlock(safe ?? defaultDayViewState())).state,
    ).toEqual(safe);
  });
});

describe("interaction, relationship, and URL boundary stress", () => {
  it("exercises every gesture target on both sides of mouse and coarse thresholds", () => {
    const targets = ["axis", "blank", "card", "resize", "minimap"] as const;
    for (const pointerType of ["mouse", "touch", "pen"] as const) {
      for (const target of targets) {
        const threshold = pointerType === "mouse" ? 6 : 10;
        const pending = beginCanvasGesture({
          pointerId: 7,
          pointerType,
          x: 100,
          y: 100,
          target,
          ...(target === "card" || target === "resize" ? { entryId: "tp-a" } : {}),
          ...(target === "resize" ? { handle: "nw" as const } : {}),
        });
        expect(pending).toMatchObject({ kind: "pending", threshold });
        expect(advanceCanvasGesture(pending, 100 + threshold - 0.01, 100)).toEqual(pending);
        expect(advanceCanvasGesture(pending, 100 + threshold, 100).kind).not.toBe("pending");
        expect(pendingClickAction(pending, true)).toBe("none");
      }
    }
  });

  it("keeps the newest 100 layout operations after 1,000 mixed-day writes", () => {
    const history = new LayoutHistory(100);
    for (let index = 0; index < 1_000; index += 1) {
      history.push({
        date: index % 2 === 0 ? "2026-07-20" : "2026-07-21",
        entryId: `tp-${index}`,
        before: null,
        after: createCardLayout({ x: 0.5, y: 0.5, width: 0.4, height: 120 }),
        reason: "move",
      });
    }
    let undoCount = 0;
    while (history.takeUndo("2026-07-21")) undoCount += 1;
    expect(undoCount).toBe(50);
    expect(history.canUndo).toBe(true);
    for (let index = 0; index < 50; index += 1)
      expect(history.takeUndo("2026-07-20")).not.toBeNull();
    expect(history.canUndo).toBe(false);
  });

  it("extracts and deduplicates 1,000 visible links while ignoring 1,000 fenced links", () => {
    const visible = Array.from(
      { length: 1_000 },
      (_, index) =>
        `[site ${index}](https://Host.example.com/path/${index}?utm_source=stress&n=${index}#part)`,
    );
    const ignored = Array.from(
      { length: 1_000 },
      (_, index) => `[ignored](https://ignored-${index}.example.com/)`,
    );
    const markdown = `${visible.join("\n")}\n\n\`\`\`markdown\n${ignored.join("\n")}\n\`\`\``;
    const links = extractMarkdownLinks(markdown);
    expect(links).toHaveLength(1_000);
    expect(links[0]?.target).toBe("https://host.example.com/path/0?n=0");
    expect(links.at(-1)?.target).toBe("https://host.example.com/path/999?n=999");
  });

  it("blocks alternate IP spellings and reserved/local host variants", () => {
    for (const url of [
      "https://127.1/",
      "https://0177.0.0.1/",
      "https://0x7f000001/",
      "https://2130706433/",
      "https://[::ffff:127.0.0.1]/",
      "https://localhost./",
      "https://device.LOCAL./",
      "https://internal/",
      "https://service.invalid/",
      "https://user:secret@example.com/",
    ]) {
      expect(validatePublicHttpsUrl(url).ok, url).toBe(false);
    }
    expect(validatePublicHttpsUrl("https://public.example.com/path").ok).toBe(true);
  });
});

function assertFiniteContained(rect: CanvasRect, bounds: CanvasBounds): void {
  for (const value of [rect.x, rect.y, rect.width, rect.height])
    expect(Number.isFinite(value)).toBe(true);
  expect(rect.x).toBeGreaterThanOrEqual(bounds.left);
  expect(rect.y).toBeGreaterThanOrEqual(bounds.top);
  expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.left + bounds.width + 1e-8);
  expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.top + bounds.height + 1e-8);
}

function assertChronological(entries: readonly { minuteOfDay: number; id: string }[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    expect(previous).toBeDefined();
    expect(current).toBeDefined();
    if (!previous || !current) continue;
    expect(
      current.minuteOfDay > previous.minuteOfDay ||
        (current.minuteOfDay === previous.minuteOfDay && current.id >= previous.id),
    ).toBe(true);
  }
}

function assertNoVerticalOverlap(
  entries: readonly { cardY: number; cardHeight: number }[],
  gap: number,
): void {
  const sorted = [...entries].sort((left, right) => left.cardY - right.cardY);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    expect(current?.cardY).toBeGreaterThanOrEqual(
      (previous?.cardY ?? 0) + (previous?.cardHeight ?? 0) + gap - 1e-8,
    );
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("Cannot pick from an empty array.");
  return value;
}
