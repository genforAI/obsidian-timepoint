import { describe, expect, it } from "vitest";

import { calculateElasticTimelineLayout, calculateRealtimeTimelineLayout } from "../src/layout";
import {
  avoidManualCardObstacles,
  resolveStoredCardGeometry,
} from "../src/layout/CanvasCardLayout";
import { resolveTimelineDensity } from "../src/views/timelineDensity";

function repeatMinute(minute: number, count: number): number[] {
  return Array.from({ length: count }, () => minute);
}

function assertColumnsDoNotOverlap(
  result: ReturnType<typeof calculateRealtimeTimelineLayout>,
  cardGap: number,
): void {
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
}

describe("adaptive density stress cases", () => {
  it("keeps automatic cards locally compact around 100 manual obstacles", () => {
    const manualCount = 100;
    const automaticCount = 150;
    const input = [
      ...Array.from({ length: manualCount }, (_, index) => ({
        id: `manual-${index.toString().padStart(3, "0")}`,
        minuteOfDay: 570,
        measuredHeight: 64,
        manual: true,
      })),
      ...Array.from({ length: automaticCount }, (_, index) => ({
        id: `automatic-${index.toString().padStart(3, "0")}`,
        minuteOfDay: 360 + index * 7,
        measuredHeight: 64,
      })),
    ];
    const result = calculateElasticTimelineLayout(input, {
      minimumHeight: 600,
      topPadding: 36,
      bottomPadding: 44,
      cardGap: 7,
    });
    const bounds = {
      left: 0,
      top: result.axisTop,
      width: 1_000,
      height: result.axisBottom - result.axisTop,
    };
    const manualRects = Array.from({ length: manualCount }, (_, index) =>
      resolveStoredCardGeometry(
        {
          schemaVersion: 1,
          x: 0.16 + (index % 4) * 0.22,
          y: 0.08 + (Math.floor(index / 4) % 12) * 0.075,
          width: index % 3 === 0 ? 0.32 : 0.24,
          height: index % 4 === 0 ? 168 : 96,
          updatedAt: "2026-07-21T12:00:00.000Z",
        },
        bounds,
        0.5,
      ),
    );
    const automaticRects = result.entries
      .filter((entry) => entry.id.startsWith("automatic-"))
      .map((entry) => ({ x: 0, y: entry.cardY, width: bounds.width, height: entry.cardHeight }));
    const resolved = avoidManualCardObstacles(automaticRects, manualRects, bounds, 7, 24).sort(
      (left, right) => left.y - right.y,
    );
    const maximumGap = resolved.slice(1).reduce((maximum, card, index) => {
      const previous = resolved[index];
      return Math.max(maximum, card.y - ((previous?.y ?? 0) + (previous?.height ?? 0)));
    }, 0);

    expect(maximumGap).toBeLessThanOrEqual(200);
  });

  it("keeps the 39-entry clustered fixture within four lanes at 720 px", () => {
    const minutes = [
      405,
      ...repeatMinute(450, 4),
      ...repeatMinute(455, 3),
      ...repeatMinute(465, 3),
      ...repeatMinute(470, 3),
      ...repeatMinute(475, 2),
      ...repeatMinute(480, 3),
      ...repeatMinute(485, 3),
      ...repeatMinute(495, 2),
      500,
      505,
      510,
      520,
      540,
      560,
      630,
      720,
      795,
      900,
      1_065,
      1_170,
      1_260,
      1_335,
      1_420,
    ];
    expect(minutes).toHaveLength(39);
    const density = resolveTimelineDensity(
      minutes.map((minuteOfDay) => ({ minuteOfDay })),
      "realtime",
      720,
    );
    const result = calculateRealtimeTimelineLayout(
      minutes.map((minuteOfDay, index) => ({
        id: `fixture-${index.toString().padStart(2, "0")}`,
        minuteOfDay,
        measuredHeight: 66,
      })),
      {
        minimumHeight: 1_200,
        topPadding: 36,
        bottomPadding: 44,
        cardGap: density.layoutCardGap,
        maximumColumns: density.maximumRealtimeColumns,
      },
    );

    expect(density.level).toBe("dense");
    expect(result.columnCount).toBeLessThanOrEqual(4);
    expect(
      124 +
        result.columnCount * density.minimumRealtimeColumnWidth +
        (result.columnCount - 1) * density.realtimeColumnGap +
        16,
    ).toBeLessThanOrEqual(720);
    assertColumnsDoNotOverlap(result, density.layoutCardGap);
  });

  it("packs 96 same-minute events into one lane in a 320 px leaf", () => {
    const input = Array.from({ length: 96 }, (_, index) => ({
      id: `same-${index.toString().padStart(3, "0")}`,
      minuteOfDay: 720,
      measuredHeight: 48,
    }));
    const density = resolveTimelineDensity(input, "realtime", 320, 84);
    const result = calculateRealtimeTimelineLayout(input, {
      minimumHeight: 720,
      topPadding: 36,
      bottomPadding: 44,
      cardGap: density.layoutCardGap,
      maximumColumns: density.maximumRealtimeColumns,
    });

    expect(density.maximumRealtimeColumns).toBe(1);
    expect(result.columnCount).toBe(1);
    expect(result.totalHeight).toBeGreaterThan(5_000);
    expect(new Set(result.entries.map((entry) => entry.nodeY)).size).toBe(1);
    assertColumnsDoNotOverlap(result, density.layoutCardGap);
  });

  it("remains deterministic when dense input arrives in reverse order", () => {
    const input = Array.from({ length: 180 }, (_, index) => ({
      id: `event-${index.toString().padStart(3, "0")}`,
      minuteOfDay: 420 + (index % 90),
      measuredHeight: 40 + (index % 4) * 8,
    }));
    const options = {
      minimumHeight: 1_200,
      topPadding: 36,
      bottomPadding: 44,
      cardGap: 7,
      maximumColumns: 5,
    };
    const forward = calculateRealtimeTimelineLayout(input, options);
    const reverse = calculateRealtimeTimelineLayout([...input].reverse(), options);

    expect(forward.entries).toEqual(reverse.entries);
    expect(forward.columnCount).toBe(5);
    assertColumnsDoNotOverlap(forward, options.cardGap);
  });

  it("does not compress a long but evenly distributed day", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      minuteOfDay: index * 120,
    }));

    expect(resolveTimelineDensity(entries, "elastic", 900).level).toBe("comfortable");
    expect(resolveTimelineDensity(entries, "realtime", 900).level).toBe("comfortable");
  });
});
