import type { TimelineViewportState } from "../model/types";

export type TimelineInteractionMode = "select" | "pan";

export const MIN_TIMELINE_ZOOM = 0.5;
export const MAX_TIMELINE_ZOOM = 3;
export const TIMELINE_ZOOM_STEP = 0.25;
export const MIN_TIMELINE_VERTICAL_SCALE = 0.4;
export const MAX_TIMELINE_VERTICAL_SCALE = 4;

/**
 * A stored centre belongs to a date/mode navigation context. Reapplying it for
 * an in-place refresh (for example, toggling relations) would override the
 * renderer's exact scroll preservation and can jump the canvas into empty
 * space when its geometry changes.
 */
export function shouldRestoreStoredViewport(
  previousContextKey: string,
  nextContextKey: string,
): boolean {
  return previousContextKey !== nextContextKey;
}

/**
 * Runtime geometry mutates the in-memory state before its anchored scroll
 * frame settles. A direct zoom/density action must therefore force one write
 * even when the final centre is numerically unchanged.
 */
export function shouldPersistTimelineViewport(
  previous: TimelineViewportState,
  next: TimelineViewportState,
  force = false,
): boolean {
  return (
    force ||
    previous.zoom !== next.zoom ||
    (previous.verticalScale ?? 1) !== (next.verticalScale ?? 1) ||
    Math.abs(previous.centerX - next.centerX) >= 0.0001 ||
    Math.abs(previous.centerY - next.centerY) >= 0.0001
  );
}

export function normalizeTimelineZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, value));
}

export function stepTimelineZoom(value: number, direction: -1 | 1): number {
  const normalized = normalizeTimelineZoom(value);
  const stepped = normalized + direction * TIMELINE_ZOOM_STEP;
  return Math.round(normalizeTimelineZoom(stepped) * 100) / 100;
}

export function timelineZoomFromWheel(
  currentZoom: number,
  deltaY: number,
  deltaMode: number,
  pageExtent: number,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return normalizeTimelineZoom(currentZoom);
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, pageExtent) : 1;
  const pixelDelta = Math.min(240, Math.max(-240, deltaY * unit));
  const factor = Math.exp(-pixelDelta * 0.002);
  return Math.round(normalizeTimelineZoom(currentZoom * factor) * 1_000) / 1_000;
}

export function isTimelineZoomWheel(metaKey: boolean, ctrlKey: boolean): boolean {
  return metaKey || ctrlKey;
}

export function normalizeTimelineVerticalScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_TIMELINE_VERTICAL_SCALE, Math.max(MIN_TIMELINE_VERTICAL_SCALE, value));
}

export function timelineVerticalScaleFromWheel(
  currentScale: number,
  deltaY: number,
  deltaMode: number,
  pageExtent: number,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return normalizeTimelineVerticalScale(currentScale);
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, pageExtent) : 1;
  const pixelDelta = Math.min(240, Math.max(-240, deltaY * unit));
  const factor = Math.exp(-pixelDelta * 0.002);
  return Math.round(normalizeTimelineVerticalScale(currentScale * factor) * 1_000) / 1_000;
}

export function isTimelineVerticalScaleWheel(
  altKey: boolean,
  metaKey: boolean,
  ctrlKey: boolean,
): boolean {
  return altKey && !metaKey && !ctrlKey;
}

/** Keep the same relative viewport centre after the runtime canvas changes size. */
export function resolveZoomedScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  previousClientHeight: number,
  nextScrollHeight: number,
  nextClientHeight: number,
): number {
  const previousScrollable = Math.max(0, previousScrollHeight - previousClientHeight);
  const nextScrollable = Math.max(0, nextScrollHeight - nextClientHeight);
  if (previousScrollable === 0 || nextScrollable === 0) return 0;
  const previousCentre = Math.max(0, previousScrollTop) + previousClientHeight / 2;
  const ratio = Math.min(1, Math.max(0, previousCentre / previousScrollHeight));
  return Math.min(nextScrollable, Math.max(0, ratio * nextScrollHeight - nextClientHeight / 2));
}

/** Keep the logical point below a viewport anchor stable while zooming. */
export function resolveAnchoredScrollOffset(
  previousOffset: number,
  previousExtent: number,
  nextExtent: number,
  viewportExtent: number,
  anchorInViewport: number,
): number {
  if (previousExtent <= 0 || nextExtent <= 0 || viewportExtent <= 0) return 0;
  const anchor = Math.min(viewportExtent, Math.max(0, anchorInViewport));
  const logicalRatio = Math.min(
    1,
    Math.max(0, (Math.max(0, previousOffset) + anchor) / previousExtent),
  );
  const maximum = Math.max(0, nextExtent - viewportExtent);
  return Math.min(maximum, Math.max(0, logicalRatio * nextExtent - anchor));
}

export function viewportCentreRatio(
  offset: number,
  extent: number,
  viewportExtent: number,
): number {
  if (extent <= 0) return 0;
  return Math.min(1, Math.max(0, (Math.max(0, offset) + viewportExtent / 2) / extent));
}

/** Preserve an in-place canvas refresh without allowing an invalid offset. */
export function clampViewportOffset(
  offset: number,
  scrollExtent: number,
  viewportExtent: number,
): number {
  if (
    !Number.isFinite(offset) ||
    !Number.isFinite(scrollExtent) ||
    !Number.isFinite(viewportExtent)
  )
    return 0;
  return Math.min(Math.max(0, scrollExtent - viewportExtent), Math.max(0, offset));
}
