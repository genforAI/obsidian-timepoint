import { describe, expect, it } from "vitest";

import {
  MAX_ENTRY_MINUTE,
  MINUTES_PER_DAY,
  calculateElasticTimelineLayout,
  calculateRealtimeTimelineLayout,
  normalizeTimelineLayoutOptions,
  prepareLayoutEntries,
} from "../src/layout";

describe("layout input normalization", () => {
  it("uses measured height, then estimated height, then the default", () => {
    const options = normalizeTimelineLayoutOptions({
      defaultEstimatedCardHeight: 80,
      minimumCardHeight: 32,
    });
    const entries = prepareLayoutEntries(
      [
        {
          id: "measured",
          minuteOfDay: 1,
          measuredHeight: 120,
          estimatedHeight: 50,
        },
        {
          id: "estimated",
          minuteOfDay: 2,
          measuredHeight: -1,
          estimatedHeight: 55,
        },
        { id: "default", minuteOfDay: 3 },
        { id: "minimum", minuteOfDay: 4, measuredHeight: 4 },
      ],
      options,
    );

    expect(entries.map((entry) => entry.cardHeight)).toEqual([120, 55, 80, 32]);
  });

  it("orders equal timestamps by stable ID independent of input order", () => {
    const options = normalizeTimelineLayoutOptions();
    const forward = prepareLayoutEntries(
      [
        { id: "z", minuteOfDay: 300 },
        { id: "a", minuteOfDay: 300 },
        { id: "m", minuteOfDay: 200 },
      ],
      options,
    );
    const reversed = prepareLayoutEntries(
      [
        { id: "m", minuteOfDay: 200 },
        { id: "a", minuteOfDay: 300 },
        { id: "z", minuteOfDay: 300 },
      ],
      options,
    );

    expect(forward.map((entry) => entry.id)).toEqual(["m", "a", "z"]);
    expect(reversed.map((entry) => entry.id)).toEqual(["m", "a", "z"]);
  });

  it.each([[-1], [MINUTES_PER_DAY], [12.5], [Number.NaN]])(
    "rejects non-storable entry minute %s",
    (minuteOfDay) => {
      expect(() => calculateElasticTimelineLayout([{ id: "bad", minuteOfDay }])).toThrow(
        RangeError,
      );
    },
  );
});

describe("elastic timeline", () => {
  it("keeps dense measured cards ordered and non-overlapping", () => {
    const cardGap = 10;
    const result = calculateElasticTimelineLayout(
      [
        { id: "c", minuteOfDay: 602, measuredHeight: 100 },
        { id: "a", minuteOfDay: 600, measuredHeight: 100 },
        { id: "b", minuteOfDay: 601, measuredHeight: 100 },
      ],
      {
        minimumHeight: 720,
        topPadding: 20,
        bottomPadding: 20,
        cardGap,
      },
    );

    expect(result.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    for (let index = 1; index < result.entries.length; index += 1) {
      const previous = result.entries[index - 1];
      const current = result.entries[index];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      if (previous && current) {
        expect(current.cardY).toBeGreaterThanOrEqual(
          previous.cardY + previous.cardHeight + cardGap - 1e-8,
        );
      }
    }

    // A three-card collision group is balanced around its proportional target,
    // rather than leaving the first card at the target and pushing all others down.
    const averageCenter =
      result.entries.reduce((sum, entry) => sum + entry.cardY + entry.cardHeight / 2, 0) /
      result.entries.length;
    const averageMinute = (600 + 601 + 602) / 3;
    const proportionalTarget = 20 + 50 + (averageMinute / MINUTES_PER_DAY) * (720 - 40 - 100);
    expect(averageCenter).toBeCloseTo(proportionalTarget, 6);
  });

  it("fans identical timestamps from one node to separate cards", () => {
    const result = calculateElasticTimelineLayout(
      [
        { id: "c", minuteOfDay: 480, measuredHeight: 70 },
        { id: "a", minuteOfDay: 480, measuredHeight: 70 },
        { id: "b", minuteOfDay: 480, measuredHeight: 70 },
      ],
      { cardGap: 8 },
    );

    expect(new Set(result.entries.map((entry) => entry.nodeY)).size).toBe(1);
    expect(result.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(result.entries[1]?.cardY).toBeGreaterThan(
      (result.entries[0]?.cardY ?? 0) + (result.entries[0]?.cardHeight ?? 0),
    );
  });

  it("provides a monotonic piecewise mapping and an inverse click mapping", () => {
    const result = calculateElasticTimelineLayout([
      { id: "early", minuteOfDay: 120, measuredHeight: 60 },
      { id: "dense-a", minuteOfDay: 600, measuredHeight: 160 },
      { id: "dense-b", minuteOfDay: 605, measuredHeight: 140 },
      { id: "late", minuteOfDay: 1300, measuredHeight: 80 },
    ]);

    let previousY = Number.NEGATIVE_INFINITY;
    for (let minute = 0; minute <= MINUTES_PER_DAY; minute += 15) {
      const y = result.minuteToY(minute);
      expect(y).toBeGreaterThan(previousY);
      previousY = y;
    }

    for (const entry of result.entries) {
      expect(result.yToMinuteContinuous(entry.nodeY)).toBeCloseTo(entry.minuteOfDay, 8);
      expect(result.yToMinute(entry.nodeY)).toBe(entry.minuteOfDay);
    }

    expect(result.yToMinuteContinuous(result.axisTop)).toBe(0);
    expect(result.yToMinuteContinuous(result.axisBottom)).toBe(MINUTES_PER_DAY);
    expect(result.yToMinute(result.axisBottom)).toBe(MAX_ENTRY_MINUTE);
  });

  it("expands total height for a very dense day", () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `entry-${index.toString().padStart(2, "0")}`,
      minuteOfDay: 720,
      measuredHeight: 100,
    }));
    const result = calculateElasticTimelineLayout(entries, {
      minimumHeight: 500,
      topPadding: 20,
      bottomPadding: 20,
      cardGap: 10,
    });

    expect(result.totalHeight).toBeGreaterThan(2_000);
    expect(result.entries.at(-1)?.cardY).toBeGreaterThan(result.entries[0]?.cardY ?? 0);
  });

  it("supports an empty axis with explicit 00:00 and 24:00 endpoints", () => {
    const result = calculateElasticTimelineLayout([], {
      minimumHeight: 600,
      topPadding: 25,
      bottomPadding: 35,
    });

    expect(result.timeScale.points).toEqual([
      { minute: 0, y: 25 },
      { minute: MINUTES_PER_DAY, y: 565 },
    ]);
    expect(result.entries).toEqual([]);
  });
});

describe("real-time timeline", () => {
  it("keeps node positions exactly proportional to time", () => {
    const result = calculateRealtimeTimelineLayout(
      [
        { id: "midnight", minuteOfDay: 0 },
        { id: "noon", minuteOfDay: 720 },
        { id: "last", minuteOfDay: MAX_ENTRY_MINUTE },
      ],
      { minimumHeight: 1_000, topPadding: 20, bottomPadding: 20 },
    );
    const axisHeight = result.axisBottom - result.axisTop;

    for (const entry of result.entries) {
      expect((entry.nodeY - result.axisTop) / axisHeight).toBeCloseTo(
        entry.minuteOfDay / MINUTES_PER_DAY,
        12,
      );
    }
  });

  it("assigns colliding cards to deterministic horizontal columns", () => {
    const input = [
      { id: "c", minuteOfDay: 600, measuredHeight: 120 },
      { id: "a", minuteOfDay: 600, measuredHeight: 120 },
      { id: "b", minuteOfDay: 600, measuredHeight: 120 },
      { id: "later", minuteOfDay: 1_000, measuredHeight: 60 },
    ];
    const first = calculateRealtimeTimelineLayout(input, { cardGap: 10 });
    const second = calculateRealtimeTimelineLayout([...input].reverse(), {
      cardGap: 10,
    });

    expect(first.entries.map(({ id, column }) => ({ id, column }))).toEqual(
      second.entries.map(({ id, column }) => ({ id, column })),
    );
    expect(first.entries.slice(0, 3).map((entry) => entry.column)).toEqual([0, 1, 2]);
    expect(first.columnCount).toBe(3);
  });

  it("never overlaps cards assigned to the same column", () => {
    const cardGap = 9;
    const result = calculateRealtimeTimelineLayout(
      Array.from({ length: 30 }, (_, index) => ({
        id: `item-${index.toString().padStart(2, "0")}`,
        minuteOfDay: 1_200 + index * 2,
        measuredHeight: 72 + (index % 3) * 20,
      })),
      { cardGap },
    );

    for (let column = 0; column < result.columnCount; column += 1) {
      const entries = result.entries
        .filter((entry) => entry.column === column)
        .sort((left, right) => left.cardY - right.cardY);
      for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        if (previous && current) {
          expect(current.cardY).toBeGreaterThanOrEqual(
            previous.cardY + previous.cardHeight + cardGap - 1e-8,
          );
        }
      }
    }
  });

  it("packs a dense cluster into a bounded number of preview lanes", () => {
    const cardGap = 7;
    const result = calculateRealtimeTimelineLayout(
      Array.from({ length: 24 }, (_, index) => ({
        id: `dense-${index.toString().padStart(2, "0")}`,
        minuteOfDay: 450 + index * 2,
        measuredHeight: 64,
      })),
      {
        minimumHeight: 1_200,
        topPadding: 36,
        bottomPadding: 44,
        cardGap,
        maximumColumns: 4,
      },
    );

    expect(result.columnCount).toBe(4);
    expect(Math.max(...result.entries.map((entry) => entry.column))).toBe(3);
    for (let column = 0; column < result.columnCount; column += 1) {
      const entries = result.entries
        .filter((entry) => entry.column === column)
        .sort((left, right) => left.cardY - right.cardY);
      for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        expect(current?.cardY).toBeGreaterThanOrEqual(
          (previous?.cardY ?? 0) + (previous?.cardHeight ?? 0) + cardGap - 1e-8,
        );
      }
    }
  });

  it("extends preview space without changing the proportional 24-hour axis", () => {
    const result = calculateRealtimeTimelineLayout(
      Array.from({ length: 18 }, (_, index) => ({
        id: `late-${index.toString().padStart(2, "0")}`,
        minuteOfDay: 1_430,
        measuredHeight: 72,
      })),
      {
        minimumHeight: 720,
        topPadding: 20,
        bottomPadding: 20,
        cardGap: 8,
        maximumColumns: 2,
      },
    );

    expect(result.axisBottom).toBe(700);
    expect(result.totalHeight).toBeGreaterThan(720);
    expect(result.entries.every((entry) => entry.nodeY < result.axisBottom)).toBe(true);
  });
});
