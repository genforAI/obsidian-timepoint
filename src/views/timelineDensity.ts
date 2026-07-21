import type { TimelineMode } from "../settings/settings";

export type TimelineDensity = "comfortable" | "compact" | "dense";

export interface TimelineDensityEntry {
  minuteOfDay: number;
}

export interface TimelineDensityProfile {
  level: TimelineDensity;
  /** Runtime-only Markdown preview cap. Null preserves the user's normal cap. */
  previewHeight: number | null;
  maximumRealtimeColumns: number;
  minimumRealtimeColumnWidth: number;
  realtimeColumnGap: number;
  layoutCardGap: number;
  minimumBadgeSpacing: number;
  peakHourEntries: number;
  maximumSameMinuteEntries: number;
}

const MINIMUM_CARD_START = 84;
const CARD_END_INSET = 16;

/**
 * Select a runtime-only preview density from the actual day distribution.
 * Source Markdown and entry metadata never participate in this decision and
 * are never rewritten when the presentation becomes compact.
 */
export function resolveTimelineDensity(
  entries: readonly TimelineDensityEntry[],
  mode: TimelineMode,
  containerWidth: number,
  cardStart = 124,
): TimelineDensityProfile {
  const normalizedMinutes = entries
    .map(({ minuteOfDay }) => minuteOfDay)
    .filter((minute) => Number.isFinite(minute))
    .sort((left, right) => left - right);
  const peakHourEntries = calculatePeakWindow(normalizedMinutes, 60);
  const maximumSameMinuteEntries = calculateMaximumSameMinute(normalizedMinutes);
  const count = normalizedMinutes.length;

  let level: TimelineDensity = "comfortable";
  if (
    (mode === "realtime" &&
      (peakHourEntries >= 10 || maximumSameMinuteEntries >= 3 || count >= 36)) ||
    (mode === "elastic" && (peakHourEntries >= 14 || count >= 48))
  ) {
    level = "dense";
  } else if (
    peakHourEntries >= (mode === "realtime" ? 5 : 8) ||
    count >= (mode === "realtime" ? 20 : 30)
  ) {
    level = "compact";
  }

  const densityValues =
    level === "dense"
      ? { previewHeight: 24, columnWidth: 132, columnGap: 8, cardGap: 7, badgeGap: 28 }
      : level === "compact"
        ? { previewHeight: 64, columnWidth: 168, columnGap: 9, cardGap: 9, badgeGap: 20 }
        : {
            previewHeight: null,
            columnWidth: 220,
            columnGap: 10,
            cardGap: 12,
            badgeGap: 0,
          };
  const usableWidth = Math.max(
    densityValues.columnWidth,
    normalizeWidth(containerWidth) - Math.max(MINIMUM_CARD_START, cardStart) - CARD_END_INSET,
  );
  const fittingColumns = Math.max(
    1,
    Math.floor(
      (usableWidth + densityValues.columnGap) /
        (densityValues.columnWidth + densityValues.columnGap),
    ),
  );

  return {
    level,
    previewHeight: densityValues.previewHeight,
    maximumRealtimeColumns: Math.min(6, fittingColumns),
    minimumRealtimeColumnWidth: densityValues.columnWidth,
    realtimeColumnGap: densityValues.columnGap,
    layoutCardGap: densityValues.cardGap,
    minimumBadgeSpacing: densityValues.badgeGap,
    peakHourEntries,
    maximumSameMinuteEntries,
  };
}

export interface TimelineBadgeCandidate {
  minuteOfDay: number;
  nodeY: number;
}

export interface RealtimeLaneGeometry {
  gap: number;
  minimumColumnWidth: number;
  requiredWidth: number;
}

/** Zoom expands both time distance and lane width, enabling two-dimensional panning on intent. */
export function resolveRealtimeLaneGeometry(
  density: TimelineDensityProfile,
  columnCount: number,
  cardStart: number,
  timelineScale: number,
): RealtimeLaneGeometry {
  const columns = Math.max(1, Math.floor(columnCount));
  const scale = Math.max(0.5, Math.min(3, timelineScale));
  const gap = density.realtimeColumnGap * Math.min(1.5, scale);
  const baseMinimumColumnWidth =
    columns > 1
      ? density.minimumRealtimeColumnWidth
      : Math.min(180, density.minimumRealtimeColumnWidth);
  const minimumColumnWidth = Math.max(112, baseMinimumColumnWidth * scale);
  return {
    gap,
    minimumColumnWidth,
    requiredWidth:
      Math.max(0, cardStart) + columns * minimumColumnWidth + (columns - 1) * gap + CARD_END_INSET,
  };
}

/**
 * Select permanent axis badges without letting nearby event labels collide.
 * Every node remains interactive and exposes its precise time through its
 * accessible label and an on-intent tooltip.
 */
export function selectVisibleTimelineBadgeMinutes(
  candidates: readonly TimelineBadgeCandidate[],
  minimumSpacing: number,
): ReadonlySet<number> {
  const spacing = Number.isFinite(minimumSpacing) ? Math.max(0, minimumSpacing) : 0;
  const unique = new Map<number, number>();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.minuteOfDay) || !Number.isFinite(candidate.nodeY)) continue;
    if (!unique.has(candidate.minuteOfDay)) unique.set(candidate.minuteOfDay, candidate.nodeY);
  }
  const ordered = [...unique].sort((left, right) => {
    if (left[1] !== right[1]) return left[1] - right[1];
    return left[0] - right[0];
  });
  if (spacing === 0) return new Set(ordered.map(([minute]) => minute));

  const visible = new Set<number>();
  let lastY = Number.NEGATIVE_INFINITY;
  for (const [minute, nodeY] of ordered) {
    if (nodeY - lastY < spacing) continue;
    visible.add(minute);
    lastY = nodeY;
  }
  return visible;
}

function calculatePeakWindow(minutes: readonly number[], windowMinutes: number): number {
  let peak = 0;
  let start = 0;
  for (let end = 0; end < minutes.length; end += 1) {
    const endMinute = minutes[end];
    if (endMinute === undefined) continue;
    while (start < end && endMinute - (minutes[start] ?? endMinute) > windowMinutes) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

function calculateMaximumSameMinute(minutes: readonly number[]): number {
  let maximum = 0;
  let run = 0;
  let previous: number | undefined;
  for (const minute of minutes) {
    run = minute === previous ? run + 1 : 1;
    previous = minute;
    maximum = Math.max(maximum, run);
  }
  return maximum;
}

function normalizeWidth(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 720;
}
