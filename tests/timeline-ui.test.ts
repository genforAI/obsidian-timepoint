import { describe, expect, it } from "vitest";

import {
  buildStableBlockReference,
  cardHeightChangeNeedsReflow,
  clampTimelineScrollTop,
  resolveCardDisplay,
  resolveTimelineCardMeasuredHeight,
  timelineMeasurementIsUsable,
  timelineMeasurementNeedsReflow,
} from "../src/views/cardDisplay";
import {
  DEFAULT_AXIS_HIT_RADIUS,
  isWithinTimelineAxisHitArea,
  mapTimelineYToStoredTime,
} from "../src/views/timelineInteraction";

describe("smart card display", () => {
  it("shows short smart notes fully and collapses long smart notes", () => {
    expect(
      resolveCardDisplay({
        mode: "smart",
        naturalHeight: 180,
        smartCollapseHeight: 320,
        previewHeight: 160,
      }),
    ).toEqual({ clipped: false, maxHeight: null });

    expect(
      resolveCardDisplay({
        mode: "smart",
        naturalHeight: 640,
        smartCollapseHeight: 320,
        previewHeight: 160,
      }),
    ).toEqual({ clipped: true, maxHeight: 320 });
  });

  it("uses a hard compact limit with no per-card expansion override", () => {
    expect(
      resolveCardDisplay({
        mode: "preview",
        naturalHeight: 2_000,
        smartCollapseHeight: 320,
        previewHeight: 160,
      }),
    ).toEqual({ clipped: true, maxHeight: 160 });
  });

  it("triggers layout reflow only for a material measured-height change", () => {
    expect(cardHeightChangeNeedsReflow(200, 202.9)).toBe(false);
    expect(cardHeightChangeNeedsReflow(200, 204)).toBe(true);
    expect(cardHeightChangeNeedsReflow(Number.NaN, 200)).toBe(true);
  });

  it("preserves the reflow budget while hidden and recovers when visible", () => {
    expect(
      timelineMeasurementNeedsReflow({
        previousContainerWidth: 0,
        containerWidth: 0,
        cards: [{ expectedHeight: 96, measuredHeight: 0 }],
      }),
    ).toBe(false);
    expect(
      timelineMeasurementIsUsable({
        containerWidth: 900,
        cards: [{ expectedHeight: 96, measuredHeight: 0 }],
      }),
    ).toBe(false);
    expect(
      timelineMeasurementNeedsReflow({
        previousContainerWidth: 0,
        containerWidth: 900,
        cards: [{ expectedHeight: 96, measuredHeight: 640 }],
      }),
    ).toBe(true);
    expect(
      timelineMeasurementNeedsReflow({
        previousContainerWidth: 900,
        containerWidth: 900,
        cards: [{ expectedHeight: 200, measuredHeight: 202 }],
      }),
    ).toBe(false);
    expect(
      timelineMeasurementNeedsReflow({
        previousContainerWidth: 900,
        containerWidth: 720,
        cards: [{ expectedHeight: 200, measuredHeight: 260 }],
      }),
    ).toBe(true);
  });

  it("restores scroll without exceeding the rebuilt timeline", () => {
    expect(clampTimelineScrollTop(640, 2_000, 800)).toBe(640);
    expect(clampTimelineScrollTop(1_800, 2_000, 800)).toBe(1_200);
    expect(clampTimelineScrollTop(-20, 2_000, 800)).toBe(0);
    expect(clampTimelineScrollTop(Number.NaN, 2_000, 800)).toBe(0);
  });

  it("reserves a card's larger scroll box when Markdown escapes its border box", () => {
    expect(resolveTimelineCardMeasuredHeight(78, 112)).toBe(112);
    expect(resolveTimelineCardMeasuredHeight(112, 78)).toBe(112);
    expect(resolveTimelineCardMeasuredHeight(78, 78, 134)).toBe(134);
    expect(resolveTimelineCardMeasuredHeight(0, 0)).toBeUndefined();
    expect(resolveTimelineCardMeasuredHeight(Number.NaN, 96)).toBe(96);
  });

  it("copies an ID-addressed reference so same-time cards remain distinct", () => {
    const source = "TimePoint/Days/2026/07/2026-07-18.md";
    expect(buildStableBlockReference(source, "tp-same-time-a")).toBe(
      "[[TimePoint/Days/2026/07/2026-07-18#^tp-same-time-a]]",
    );
    expect(buildStableBlockReference(source, "tp-same-time-b")).not.toBe(
      buildStableBlockReference(source, "tp-same-time-a"),
    );
  });
});

describe("timeline axis interaction", () => {
  it("accepts the inclusive 22 px axis strip and rejects distant canvas clicks", () => {
    expect(isWithinTimelineAxisHitArea(62, 84)).toBe(true);
    expect(isWithinTimelineAxisHitArea(106, 84, DEFAULT_AXIS_HIT_RADIUS)).toBe(true);
    expect(isWithinTimelineAxisHitArea(107, 84)).toBe(false);
    expect(isWithinTimelineAxisHitArea(260, 84)).toBe(false);
  });

  it("uses the supplied inverse mapping and snaps to a stored time", () => {
    const mapped = mapTimelineYToStoredTime(250, 20, 500, (y) => y * 2 + 1, 5);
    expect(mapped).toEqual({ minuteOfDay: 500, time: "08:20" });
  });

  it("rejects points beyond the active axis and maps 24:00 safely to 23:59", () => {
    expect(mapTimelineYToStoredTime(10, 20, 500, () => 30, 5)).toBeNull();
    expect(mapTimelineYToStoredTime(501, 20, 500, () => 30, 5)).toBeNull();
    expect(mapTimelineYToStoredTime(500, 20, 500, () => 1_440, 30)).toEqual({
      minuteOfDay: 1_439,
      time: "23:59",
    });
  });
});
