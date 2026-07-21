export type TimelineInteractionMode = "select" | "pan";

export const MIN_TIMELINE_ZOOM = 0.5;
export const MAX_TIMELINE_ZOOM = 3;
export const TIMELINE_ZOOM_STEP = 0.25;

export function normalizeTimelineZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, value));
}

export function stepTimelineZoom(value: number, direction: -1 | 1): number {
  const normalized = normalizeTimelineZoom(value);
  const stepped = normalized + direction * TIMELINE_ZOOM_STEP;
  return Math.round(normalizeTimelineZoom(stepped) * 100) / 100;
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
