import {
  MINUTES_PER_DAY,
  type LaidOutTimelineEntry,
  type LayoutEntryInput,
  type PreparedLayoutEntry,
  type TimelineLayoutOptions,
  type TimelineLayoutResult,
  createLinearTimeScale,
  makeTimelineLayoutResult,
  normalizeTimelineLayoutOptions,
  prepareLayoutEntries,
} from "./layoutTypes";

interface RealtimeCandidate extends PreparedLayoutEntry {
  order: number;
  nodeY: number;
  cardY: number;
  column: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function compareCandidatesByCardPosition(
  left: RealtimeCandidate,
  right: RealtimeCandidate,
): number {
  if (left.cardY !== right.cardY) return left.cardY - right.cardY;
  if (left.minuteOfDay !== right.minuteOfDay) {
    return left.minuteOfDay - right.minuteOfDay;
  }
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return left.sourceIndex - right.sourceIndex;
}

/**
 * Assign intervals to the first available horizontal column. Candidates are
 * considered from top to bottom, so tracking the last bottom in each column is
 * sufficient and produces stable, deterministic interval colouring.
 */
function assignCollisionColumns(
  candidates: RealtimeCandidate[],
  cardGap: number,
  maximumColumns: number,
): number {
  const lastBottomByColumn: number[] = [];
  const byCardPosition = [...candidates].sort(compareCandidatesByCardPosition);

  for (const candidate of byCardPosition) {
    let selectedColumn = 0;
    while (selectedColumn < lastBottomByColumn.length) {
      const lastBottom = lastBottomByColumn[selectedColumn];
      if (lastBottom === undefined || candidate.cardY >= lastBottom + cardGap) {
        break;
      }
      selectedColumn += 1;
    }
    if (selectedColumn >= maximumColumns) {
      selectedColumn = 0;
      for (let column = 1; column < lastBottomByColumn.length; column += 1) {
        if ((lastBottomByColumn[column] ?? 0) < (lastBottomByColumn[selectedColumn] ?? 0)) {
          selectedColumn = column;
        }
      }
      candidate.cardY = Math.max(
        candidate.cardY,
        (lastBottomByColumn[selectedColumn] ?? candidate.cardY - cardGap) + cardGap,
      );
    }
    candidate.column = selectedColumn;
    lastBottomByColumn[selectedColumn] = candidate.cardY + candidate.cardHeight;
  }

  return Math.max(1, lastBottomByColumn.length);
}

/**
 * Compute a real-time timeline. Node positions remain exactly proportional to
 * time; only cards are clamped at the ends and split into collision columns.
 */
export function calculateRealtimeTimelineLayout(
  inputEntries: readonly LayoutEntryInput[],
  inputOptions: TimelineLayoutOptions = {},
): TimelineLayoutResult {
  const options = normalizeTimelineLayoutOptions(inputOptions);
  const entries = prepareLayoutEntries(inputEntries, options);
  const maximumCardHeight = entries.reduce(
    (maximum, entry) => Math.max(maximum, entry.cardHeight),
    options.minimumCardHeight,
  );
  const baseHeight = Math.max(
    options.minimumHeight,
    options.topPadding + options.bottomPadding + maximumCardHeight,
  );
  const axisTop = options.topPadding;
  const axisBottom = baseHeight - options.bottomPadding;
  const timeScale = createLinearTimeScale(axisTop, axisBottom);

  const candidates: RealtimeCandidate[] = entries.map((entry, order) => {
    const nodeY = axisTop + (entry.minuteOfDay / MINUTES_PER_DAY) * (axisBottom - axisTop);
    const maximumCardY = axisBottom - entry.cardHeight;
    return {
      ...entry,
      order,
      nodeY,
      cardY: clamp(nodeY - entry.cardHeight / 2, axisTop, maximumCardY),
      column: 0,
    };
  });

  const columnCount = assignCollisionColumns(candidates, options.cardGap, options.maximumColumns);
  const packedBottom = candidates.reduce(
    (maximum, entry) => Math.max(maximum, entry.cardY + entry.cardHeight),
    axisBottom,
  );
  const totalHeight = Math.max(baseHeight, packedBottom + options.bottomPadding);
  const laidOutEntries: LaidOutTimelineEntry[] = candidates.map((entry) => ({
    id: entry.id,
    minuteOfDay: entry.minuteOfDay,
    order: entry.order,
    nodeY: entry.nodeY,
    cardY: entry.cardY,
    cardHeight: entry.cardHeight,
    column: entry.column,
  }));

  return makeTimelineLayoutResult({
    mode: "realtime",
    totalHeight,
    axisTop,
    axisBottom,
    columnCount,
    entries: laidOutEntries,
    timeScale,
  });
}

export const layoutRealtimeTimeline = calculateRealtimeTimelineLayout;
