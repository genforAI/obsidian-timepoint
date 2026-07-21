import { describe, expect, it } from "vitest";

import {
  buildStableBlockReference,
  cardHeightChangeNeedsReflow,
  clampTimelineScrollTop,
  resolveInitialTimelineScrollTop,
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
import {
  resolveRealtimeLaneGeometry,
  resolveTimelineDensity,
  selectVisibleTimelineBadgeMinutes,
} from "../src/views/timelineDensity";
import {
  normalizeTimelineZoom,
  resolveZoomedScrollTop,
  stepTimelineZoom,
} from "../src/views/timelineNavigation";

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

  it("applies a stricter runtime density cap without changing normal limits", () => {
    expect(
      resolveCardDisplay({
        mode: "smart",
        naturalHeight: 640,
        smartCollapseHeight: 320,
        previewHeight: 160,
        densityLimit: 24,
      }),
    ).toEqual({ clipped: true, maxHeight: 24 });
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

  it("opens a fresh real-time view near its first event while preserving time context", () => {
    expect(resolveInitialTimelineScrollTop("realtime", 640, 2_000, 800)).toBe(544);
    expect(resolveInitialTimelineScrollTop("realtime", 60, 2_000, 800)).toBe(0);
    expect(resolveInitialTimelineScrollTop("elastic", 640, 2_000, 800)).toBe(0);
    expect(resolveInitialTimelineScrollTop("realtime", undefined, 2_000, 800)).toBe(0);
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

describe("adaptive timeline density", () => {
  it("keeps ordinary days comfortable", () => {
    const profile = resolveTimelineDensity(
      [60, 360, 720, 1_080].map((minuteOfDay) => ({ minuteOfDay })),
      "realtime",
      900,
    );

    expect(profile.level).toBe("comfortable");
    expect(profile.previewHeight).toBeNull();
  });

  it("compresses a dense hour and limits lanes to the available width", () => {
    const profile = resolveTimelineDensity(
      Array.from({ length: 24 }, (_, index) => ({ minuteOfDay: 450 + index * 2 })),
      "realtime",
      720,
    );

    expect(profile.level).toBe("dense");
    expect(profile.previewHeight).toBe(24);
    expect(profile.peakHourEntries).toBe(24);
    expect(profile.maximumRealtimeColumns).toBe(4);
  });

  it("falls back to one packed lane in a very narrow leaf", () => {
    const profile = resolveTimelineDensity(
      Array.from({ length: 12 }, (_, index) => ({ minuteOfDay: 480 + index })),
      "realtime",
      320,
      84,
    );

    expect(profile.level).toBe("dense");
    expect(profile.maximumRealtimeColumns).toBe(1);
  });

  it("keeps default dense lanes fitted but makes zoomed lanes pannable", () => {
    const profile = resolveTimelineDensity(
      Array.from({ length: 24 }, (_, index) => ({ minuteOfDay: 450 + index * 2 })),
      "realtime",
      720,
    );
    const defaultGeometry = resolveRealtimeLaneGeometry(profile, 4, 124, 1);
    const zoomedGeometry = resolveRealtimeLaneGeometry(profile, 4, 124, 2);

    expect(defaultGeometry.requiredWidth).toBeLessThanOrEqual(720);
    expect(zoomedGeometry.requiredWidth).toBeGreaterThan(720);
    expect(zoomedGeometry.minimumColumnWidth).toBe(defaultGeometry.minimumColumnWidth * 2);
  });

  it("thins permanent dense badges while keeping every precise time available on its node", () => {
    const visible = selectVisibleTimelineBadgeMinutes(
      [
        { minuteOfDay: 450, nodeY: 100 },
        { minuteOfDay: 455, nodeY: 104 },
        { minuteOfDay: 465, nodeY: 112 },
        { minuteOfDay: 480, nodeY: 132 },
        { minuteOfDay: 480, nodeY: 132 },
      ],
      20,
    );

    expect([...visible]).toEqual([450, 480]);
    expect([...selectVisibleTimelineBadgeMinutes([{ minuteOfDay: 455, nodeY: 104 }], 0)]).toEqual([
      455,
    ]);
  });
});

describe("timeline pan and zoom", () => {
  it("clamps and steps the runtime zoom without persisting it", () => {
    expect(normalizeTimelineZoom(Number.NaN)).toBe(1);
    expect(normalizeTimelineZoom(0.1)).toBe(0.5);
    expect(normalizeTimelineZoom(4)).toBe(3);
    expect(stepTimelineZoom(1, 1)).toBe(1.25);
    expect(stepTimelineZoom(0.5, -1)).toBe(0.5);
  });

  it("keeps the relative viewport centre stable after zoom", () => {
    expect(resolveZoomedScrollTop(600, 2_000, 800, 4_000, 800)).toBe(1_600);
    expect(resolveZoomedScrollTop(0, 600, 800, 1_200, 800)).toBe(0);
    expect(resolveZoomedScrollTop(900, 1_200, 300, 600, 300)).toBe(300);
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
