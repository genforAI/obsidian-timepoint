/** Number of minutes represented by the complete 00:00-24:00 axis. */
export const MINUTES_PER_DAY = 24 * 60;

/** The largest minute that can be stored on an entry (23:59). */
export const MAX_ENTRY_MINUTE = MINUTES_PER_DAY - 1;

export type TimelineLayoutMode = "elastic" | "realtime";

/**
 * The layout layer deliberately consumes only the fields it needs. A caller can
 * map a TimePointEntry to this shape without coupling the pure engine to storage.
 */
export interface LayoutEntryInput {
  id: string;
  minuteOfDay: number;
  /** A height obtained from the rendered card. Preferred when valid. */
  measuredHeight?: number;
  /** A caller-provided estimate used before a card has been measured. */
  estimatedHeight?: number;
}

export interface TimelineLayoutOptions {
  /** Minimum full height, including the space above and below the time axis. */
  minimumHeight?: number;
  topPadding?: number;
  bottomPadding?: number;
  cardGap?: number;
  defaultEstimatedCardHeight?: number;
  minimumCardHeight?: number;
}

export interface NormalizedTimelineLayoutOptions {
  minimumHeight: number;
  topPadding: number;
  bottomPadding: number;
  cardGap: number;
  defaultEstimatedCardHeight: number;
  minimumCardHeight: number;
}

export interface PreparedLayoutEntry {
  id: string;
  minuteOfDay: number;
  cardHeight: number;
  /** Original input position, used only as a final tie breaker. */
  sourceIndex: number;
}

export interface LaidOutTimelineEntry {
  id: string;
  minuteOfDay: number;
  /** Stable chronological position in the result. */
  order: number;
  /** Position of the event node on the time axis. */
  nodeY: number;
  /** Top edge of the card. */
  cardY: number;
  cardHeight: number;
  /** Zero-based horizontal card column. Elastic mode always uses column zero. */
  column: number;
}

export interface TimeScalePoint {
  /** 0 and 1440 are valid axis anchors. Stored entries stop at 1439. */
  minute: number;
  y: number;
}

/**
 * A monotonic time scale. `yToMinute` is continuous and may return 1440 at the
 * bottom endpoint; `yToEntryMinute` rounds and clamps to a storable 0..1439.
 */
export interface TimelineTimeScale {
  readonly points: readonly TimeScalePoint[];
  minuteToY(minute: number): number;
  yToMinute(y: number): number;
  yToEntryMinute(y: number): number;
}

export interface TimelineLayoutResult {
  mode: TimelineLayoutMode;
  totalHeight: number;
  axisTop: number;
  axisBottom: number;
  columnCount: number;
  entries: readonly LaidOutTimelineEntry[];
  timeScale: TimelineTimeScale;
  /** Convenience alias for `timeScale.minuteToY`. */
  minuteToY(minute: number): number;
  /** Convenience click mapping, always returning a storable 0..1439 minute. */
  yToMinute(y: number): number;
  /** Continuous inverse, useful for diagnostics and interpolation. */
  yToMinuteContinuous(y: number): number;
}

const DEFAULT_OPTIONS: NormalizedTimelineLayoutOptions = {
  minimumHeight: 960,
  topPadding: 28,
  bottomPadding: 36,
  cardGap: 12,
  defaultEstimatedCardHeight: 88,
  minimumCardHeight: 32,
};

function finiteNonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function finitePositive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return value;
}

export function normalizeTimelineLayoutOptions(
  options: TimelineLayoutOptions = {},
): NormalizedTimelineLayoutOptions {
  const minimumCardHeight = finitePositive(
    options.minimumCardHeight,
    DEFAULT_OPTIONS.minimumCardHeight,
    "minimumCardHeight",
  );

  return {
    minimumHeight: finitePositive(
      options.minimumHeight,
      DEFAULT_OPTIONS.minimumHeight,
      "minimumHeight",
    ),
    topPadding: finiteNonNegative(options.topPadding, DEFAULT_OPTIONS.topPadding, "topPadding"),
    bottomPadding: finiteNonNegative(
      options.bottomPadding,
      DEFAULT_OPTIONS.bottomPadding,
      "bottomPadding",
    ),
    cardGap: finiteNonNegative(options.cardGap, DEFAULT_OPTIONS.cardGap, "cardGap"),
    defaultEstimatedCardHeight: Math.max(
      minimumCardHeight,
      finitePositive(
        options.defaultEstimatedCardHeight,
        DEFAULT_OPTIONS.defaultEstimatedCardHeight,
        "defaultEstimatedCardHeight",
      ),
    ),
    minimumCardHeight,
  };
}

export function resolveCardHeight(
  entry: LayoutEntryInput,
  options: NormalizedTimelineLayoutOptions,
): number {
  const candidate =
    entry.measuredHeight !== undefined &&
    Number.isFinite(entry.measuredHeight) &&
    entry.measuredHeight > 0
      ? entry.measuredHeight
      : entry.estimatedHeight !== undefined &&
          Number.isFinite(entry.estimatedHeight) &&
          entry.estimatedHeight > 0
        ? entry.estimatedHeight
        : options.defaultEstimatedCardHeight;

  return Math.max(options.minimumCardHeight, candidate);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Validate, measure, and deterministically order entries. */
export function prepareLayoutEntries(
  entries: readonly LayoutEntryInput[],
  options: NormalizedTimelineLayoutOptions,
): PreparedLayoutEntry[] {
  return entries
    .map((entry, sourceIndex): PreparedLayoutEntry => {
      if (entry.id.length === 0) {
        throw new RangeError("Layout entry IDs must not be empty");
      }
      if (
        !Number.isInteger(entry.minuteOfDay) ||
        entry.minuteOfDay < 0 ||
        entry.minuteOfDay > MAX_ENTRY_MINUTE
      ) {
        throw new RangeError(
          `Entry ${entry.id} minuteOfDay must be an integer from 0 to ${MAX_ENTRY_MINUTE}`,
        );
      }

      return {
        id: entry.id,
        minuteOfDay: entry.minuteOfDay,
        cardHeight: resolveCardHeight(entry, options),
        sourceIndex,
      };
    })
    .sort((left, right) => {
      const minuteDifference = left.minuteOfDay - right.minuteOfDay;
      if (minuteDifference !== 0) return minuteDifference;
      const idDifference = compareCodeUnits(left.id, right.id);
      if (idDifference !== 0) return idDifference;
      return left.sourceIndex - right.sourceIndex;
    });
}

function interpolate(
  input: number,
  inputStart: number,
  inputEnd: number,
  outputStart: number,
  outputEnd: number,
): number {
  if (inputEnd === inputStart) return outputStart;
  const progress = (input - inputStart) / (inputEnd - inputStart);
  return outputStart + progress * (outputEnd - outputStart);
}

function findSegmentByMinute(points: readonly TimeScalePoint[], minute: number): number {
  let low = 0;
  let high = points.length - 2;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const left = points[middle];
    const right = points[middle + 1];
    if (left === undefined || right === undefined) break;
    if (minute < left.minute) high = middle - 1;
    else if (minute > right.minute) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(points.length - 2, low));
}

function findSegmentByY(points: readonly TimeScalePoint[], y: number): number {
  let low = 0;
  let high = points.length - 2;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const top = points[middle];
    const bottom = points[middle + 1];
    if (top === undefined || bottom === undefined) break;
    if (y < top.y) high = middle - 1;
    else if (y > bottom.y) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(points.length - 2, low));
}

/** Create a strictly monotonic piecewise-linear time scale. */
export function createPiecewiseTimeScale(
  inputPoints: readonly TimeScalePoint[],
): TimelineTimeScale {
  if (inputPoints.length < 2) {
    throw new RangeError("A time scale requires at least two points");
  }

  const points = inputPoints.map((point) => ({ ...point }));
  const first = points[0];
  const last = points[points.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    first.minute !== 0 ||
    last.minute !== MINUTES_PER_DAY
  ) {
    throw new RangeError("A TimePoint scale must span minute 0 through minute 1440");
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined || !Number.isFinite(point.minute) || !Number.isFinite(point.y)) {
      throw new RangeError("Time scale points must be finite");
    }
    if (index === 0) continue;
    const previous = points[index - 1];
    if (previous === undefined || point.minute <= previous.minute || point.y <= previous.y) {
      throw new RangeError("Time scale minutes and positions must be strictly increasing");
    }
  }

  const frozenPoints = Object.freeze(points.map((point) => Object.freeze(point)));

  const minuteToY = (rawMinute: number): number => {
    if (!Number.isFinite(rawMinute)) {
      throw new RangeError("minute must be finite");
    }
    const minute = Math.max(0, Math.min(MINUTES_PER_DAY, rawMinute));
    const segmentIndex = findSegmentByMinute(frozenPoints, minute);
    const left = frozenPoints[segmentIndex];
    const right = frozenPoints[segmentIndex + 1];
    if (left === undefined || right === undefined) return first.y;
    return interpolate(minute, left.minute, right.minute, left.y, right.y);
  };

  const yToMinute = (rawY: number): number => {
    if (!Number.isFinite(rawY)) {
      throw new RangeError("y must be finite");
    }
    const y = Math.max(first.y, Math.min(last.y, rawY));
    const segmentIndex = findSegmentByY(frozenPoints, y);
    const top = frozenPoints[segmentIndex];
    const bottom = frozenPoints[segmentIndex + 1];
    if (top === undefined || bottom === undefined) return 0;
    return interpolate(y, top.y, bottom.y, top.minute, bottom.minute);
  };

  return Object.freeze({
    points: frozenPoints,
    minuteToY,
    yToMinute,
    yToEntryMinute: (y: number): number =>
      Math.max(0, Math.min(MAX_ENTRY_MINUTE, Math.round(yToMinute(y)))),
  });
}

export function createLinearTimeScale(axisTop: number, axisBottom: number): TimelineTimeScale {
  return createPiecewiseTimeScale([
    { minute: 0, y: axisTop },
    { minute: MINUTES_PER_DAY, y: axisBottom },
  ]);
}

export function makeTimelineLayoutResult(
  result: Omit<TimelineLayoutResult, "minuteToY" | "yToMinute" | "yToMinuteContinuous">,
): TimelineLayoutResult {
  return {
    ...result,
    minuteToY: (minute) => result.timeScale.minuteToY(minute),
    yToMinute: (y) => result.timeScale.yToEntryMinute(y),
    yToMinuteContinuous: (y) => result.timeScale.yToMinute(y),
  };
}
