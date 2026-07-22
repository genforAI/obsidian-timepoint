import { describe, expect, it } from "vitest";
import {
  avoidManualCardObstacles,
  findCardOverlapGroups,
  freezeCardGeometry,
  moveCardRect,
  resizeCardRect,
  resolveStoredCardGeometry,
  routeTimelineConnector,
  type CanvasBounds,
} from "../src/layout/CanvasCardLayout";
import type { ResizeHandle } from "../src/model/types";
import { createCardLayout } from "../src/storage/CardLayoutMetadata";
import {
  advanceCanvasGesture,
  beginCanvasGesture,
  LatestFrameQueue,
  pendingClickAction,
  pointerDragThreshold,
  registerCardActivation,
  shouldOpenCardOnDoubleClick,
} from "../src/views/canvasGesture";

const bounds: CanvasBounds = { left: 120, top: 36, width: 800, height: 1200 };

describe("canvas gesture state machine", () => {
  it("coalesces pointer samples into the newest frame and flushes before pointerup", () => {
    const scheduled = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    const applied: number[] = [];
    let nextFrame = 1;
    const queue = new LatestFrameQueue<number>(
      {
        request: (callback) => {
          const id = nextFrame++;
          scheduled.set(id, callback);
          return id;
        },
        cancel: (frame) => {
          cancelled.push(frame);
          scheduled.delete(frame);
        },
      },
      (value) => applied.push(value),
    );

    for (let sample = 0; sample < 10_000; sample += 1) queue.enqueue(sample);
    expect(scheduled.size).toBe(1);
    expect(applied).toEqual([]);
    queue.flush();
    expect(cancelled).toEqual([1]);
    expect(applied).toEqual([9_999]);
    expect(queue.scheduled).toBe(false);

    queue.enqueue(10_000);
    const callback = scheduled.get(2);
    expect(callback).toBeDefined();
    callback?.(performance.now());
    expect(applied).toEqual([9_999, 10_000]);
  });

  it("opens cards on a genuine double click but not in hand mode or on controls", () => {
    expect(shouldOpenCardOnDoubleClick(false, false)).toBe(true);
    expect(shouldOpenCardOnDoubleClick(true, false)).toBe(false);
    expect(shouldOpenCardOnDoubleClick(false, true)).toBe(false);
  });

  it("opens only two completed activations of the same card inside the time window", () => {
    const first = registerCardActivation(null, "tp-a", 1_000);
    expect(first.open).toBe(false);
    const other = registerCardActivation(first.next, "tp-b", 1_200);
    expect(other.open).toBe(false);
    const late = registerCardActivation(other.next, "tp-b", 1_800);
    expect(late.open).toBe(false);
    const second = registerCardActivation(late.next, "tp-b", 2_100);
    expect(second).toEqual({ open: true, next: null });
    expect(registerCardActivation(second.next, "tp-b", 2_200).open).toBe(false);
  });

  it("keeps clicks below the mouse/coarse thresholds", () => {
    expect(pointerDragThreshold("mouse")).toBe(6);
    expect(pointerDragThreshold("touch")).toBe(10);
    const mouse = beginCanvasGesture({
      pointerId: 1,
      pointerType: "mouse",
      x: 100,
      y: 100,
      target: "axis",
    });
    expect(advanceCanvasGesture(mouse, 104, 103)).toEqual(mouse);
    expect(pendingClickAction(mouse)).toBe("axis-create");
    expect(advanceCanvasGesture(mouse, 107, 100)).toMatchObject({ kind: "panning" });
  });

  it("coordinates card move, resize, hand override, and cancellation-safe pending state", () => {
    const card = beginCanvasGesture({
      pointerId: 2,
      pointerType: "mouse",
      x: 0,
      y: 0,
      target: "card",
      entryId: "tp-a",
    });
    expect(advanceCanvasGesture(card, 12, 0)).toMatchObject({ kind: "moving", entryId: "tp-a" });
    expect(advanceCanvasGesture(card, 12, 0, true)).toMatchObject({ kind: "panning" });
    const resize = beginCanvasGesture({
      pointerId: 3,
      pointerType: "pen",
      x: 0,
      y: 0,
      target: "resize",
      entryId: "tp-a",
      handle: "se",
    });
    expect(advanceCanvasGesture(resize, 8, 5)).toEqual(resize);
    expect(advanceCanvasGesture(resize, 12, 5)).toMatchObject({
      kind: "resizing",
      handle: "se",
    });
    expect(pendingClickAction(resize)).toBe("select-card");
  });
});

describe("manual card geometry", () => {
  it("round-trips normalized geometry and preserves wide preferences when clamped", () => {
    const layout = createCardLayout({ x: 0.8, y: 0.4, width: 0.45, height: 180 });
    const rect = resolveStoredCardGeometry(layout, bounds, 1);
    expect(freezeCardGeometry(rect, bounds, 1)).toMatchObject({
      x: 0.775,
      y: 0.4,
      width: 0.45,
      height: 180,
    });
    const narrow = resolveStoredCardGeometry(layout, { ...bounds, width: 200 }, 1);
    expect(narrow.x).toBeGreaterThanOrEqual(bounds.left);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(bounds.left + 200);
    expect(layout.width).toBe(0.45);
  });

  it("supports all eight resize handles within the limits", () => {
    const start = { x: 300, y: 300, width: 360, height: 180 };
    const handles: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
    for (const handle of handles) {
      const rect = resizeCardRect(start, handle, 2000, 2000, bounds, 1);
      expect(rect.x).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.y).toBeGreaterThanOrEqual(bounds.top);
      expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.left + bounds.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.top + bounds.height);
      expect(rect.width).toBeGreaterThanOrEqual(160);
      expect(rect.height).toBeGreaterThan(0);
    }
    expect(moveCardRect(start, -1000, -1000, bounds)).toMatchObject({
      x: bounds.left,
      y: bounds.top,
    });
  });

  it("keeps stored wide preferences safe across responsive widths and 50–300% zoom", () => {
    const layout = createCardLayout({ x: 0.93, y: 0.91, width: 0.82, height: 700 });
    for (const viewportWidth of [320, 560, 720, 900, 1200]) {
      const responsiveBounds: CanvasBounds = {
        left: viewportWidth <= 560 ? 72 : 120,
        top: 36,
        width: Math.max(180, viewportWidth - (viewportWidth <= 560 ? 88 : 152)),
        height: 2400,
      };
      for (const zoom of [0.5, 1, 3]) {
        const rect = resolveStoredCardGeometry(layout, responsiveBounds, zoom);
        expect(rect.x).toBeGreaterThanOrEqual(responsiveBounds.left);
        expect(rect.y).toBeGreaterThanOrEqual(responsiveBounds.top);
        expect(rect.x + rect.width).toBeLessThanOrEqual(
          responsiveBounds.left + responsiveBounds.width,
        );
        expect(rect.y + rect.height).toBeLessThanOrEqual(
          responsiveBounds.top + responsiveBounds.height,
        );
        const normalized = freezeCardGeometry(rect, responsiveBounds, zoom);
        expect(normalized.x).toBeGreaterThanOrEqual(0);
        expect(normalized.x).toBeLessThanOrEqual(1);
        expect(normalized.y).toBeGreaterThanOrEqual(0);
        expect(normalized.y).toBeLessThanOrEqual(1);
        expect(normalized.width).toBeGreaterThanOrEqual(0.2);
        expect(normalized.width).toBeLessThanOrEqual(1);
        expect(normalized.height).toBeGreaterThanOrEqual(72);
        expect(normalized.height).toBeLessThanOrEqual(720);
      }
      // Resolving in a narrow leaf never mutates the persisted wide preference object.
      expect(layout).toMatchObject({ x: 0.93, y: 0.91, width: 0.82, height: 700 });
    }
  });

  it("lets manual cards overlap while moving automatic cards around them deterministically", () => {
    const manual = [{ x: 200, y: 100, width: 400, height: 150 }];
    const automatic = [
      { x: 220, y: 120, width: 380, height: 100 },
      { x: 220, y: 160, width: 380, height: 100 },
    ];
    const first = avoidManualCardObstacles(automatic, manual, bounds, 12);
    const second = avoidManualCardObstacles(automatic, manual, bounds, 12);
    expect(first).toEqual(second);
    expect(first[0]?.y).toBeGreaterThanOrEqual(262);
    expect(first[1]?.y).toBeGreaterThan((first[0]?.y ?? 0) + (first[0]?.height ?? 0));
  });

  it("turns substantial manual overlap into deterministic, accessible card groups", () => {
    const groups = findCardOverlapGroups([
      { id: "tp-c", rect: { x: 400, y: 100, width: 200, height: 120 } },
      { id: "tp-a", rect: { x: 100, y: 100, width: 200, height: 120 } },
      { id: "tp-b", rect: { x: 120, y: 110, width: 180, height: 100 } },
      { id: "tp-edge", rect: { x: 590, y: 100, width: 200, height: 120 } },
    ]);
    expect(groups).toEqual([["tp-a", "tp-b"]]);
  });

  it("groups the partial vertical collision produced by a short resized card", () => {
    const groups = findCardOverlapGroups([
      { id: "selected", rect: { x: 100, y: 100, width: 700, height: 90 } },
      { id: "long-note", rect: { x: 100, y: 170, width: 700, height: 180 } },
      { id: "next-card", rect: { x: 100, y: 360, width: 700, height: 90 } },
    ]);
    expect(groups).toEqual([["long-note", "selected"]]);
  });

  it("routes same input deterministically through the connector corridor", () => {
    const input = {
      startX: 90,
      startY: 200,
      corridorX: 110,
      endX: 300,
      endY: 240,
      obstacles: [{ x: 180, y: 220, width: 80, height: 80 }],
    };
    expect(routeTimelineConnector(input)).toBe(routeTimelineConnector(input));
    expect(routeTimelineConnector(input)).toMatch(/^M 90 200 C /u);
    expect(routeTimelineConnector(input)).toContain("L 110");
  });

  it("keeps 250 automatic cards clear of 100 manual cards within the frame budget", () => {
    const manual = Array.from({ length: 100 }, (_, index) => ({
      x: 180 + (index % 4) * 170,
      y: 40 + Math.floor(index / 4) * 92,
      width: 150,
      height: 72,
    }));
    const automatic = Array.from({ length: 250 }, (_, index) => ({
      x: 180 + (index % 5) * 130,
      y: 45 + index * 18,
      width: 120,
      height: 64,
    }));
    const samples: number[] = [];
    let result = automatic;
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const started = performance.now();
      result = avoidManualCardObstacles(automatic, manual, bounds, 8);
      for (const rect of result) {
        routeTimelineConnector({
          startX: 90,
          startY: rect.y + rect.height / 2,
          corridorX: 110,
          endX: rect.x,
          endY: rect.y + rect.height / 2,
          obstacles: manual,
        });
      }
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;

    expect(result).toHaveLength(250);
    expect(
      result.every((card) =>
        manual.every((obstacle) => {
          const horizontallySeparate =
            card.x + card.width + 8 <= obstacle.x || obstacle.x + obstacle.width + 8 <= card.x;
          const verticallySeparate =
            card.y + card.height + 8 <= obstacle.y || obstacle.y + obstacle.height + 8 <= card.y;
          return horizontallySeparate || verticallySeparate;
        }),
      ),
    ).toBe(true);
    expect(p95).toBeLessThan(32);
  });
});
