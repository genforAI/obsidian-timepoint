import {
  MINUTES_PER_DAY,
  type LaidOutTimelineEntry,
  type LayoutEntryInput,
  type PreparedLayoutEntry,
  type TimelineLayoutOptions,
  type TimelineLayoutResult,
  type TimeScalePoint,
  createLinearTimeScale,
  createPiecewiseTimeScale,
  makeTimelineLayoutResult,
  normalizeTimelineLayoutOptions,
  prepareLayoutEntries,
} from "./layoutTypes";

interface WorkingElasticEntry extends PreparedLayoutEntry {
  idealCenterY: number;
  cardY: number;
  collidedWithPrevious: boolean;
}

const POSITION_EPSILON = 1e-7;

function forwardCollisionPass(
  entries: readonly PreparedLayoutEntry[],
  baseHeight: number,
  topPadding: number,
  bottomPadding: number,
  maximumCardHeight: number,
  cardGap: number,
): WorkingElasticEntry[] {
  const centerTravel = Math.max(0, baseHeight - topPadding - bottomPadding - maximumCardHeight);
  let previousBottom = topPadding - cardGap;

  return entries.map((entry) => {
    const idealCenterY =
      topPadding + maximumCardHeight / 2 + (entry.minuteOfDay / MINUTES_PER_DAY) * centerTravel;
    const idealCardY = idealCenterY - entry.cardHeight / 2;
    const earliestCardY = previousBottom + cardGap;
    const cardY = Math.max(idealCardY, earliestCardY, topPadding);
    const collidedWithPrevious = cardY > idealCardY + POSITION_EPSILON;
    previousBottom = cardY + entry.cardHeight;

    return {
      ...entry,
      idealCenterY,
      cardY,
      collidedWithPrevious,
    };
  });
}

/**
 * Forward collision resolution pushes a dense run downward. This pass shifts
 * each such run back toward the average of its ideal positions while preserving
 * every gap and the top boundary. It makes density expansion visually balanced
 * around the represented time instead of accumulating only below it.
 */
function backwardBalanceDenseGroups(
  entries: WorkingElasticEntry[],
  topPadding: number,
  cardGap: number,
): void {
  let index = 1;
  while (index < entries.length) {
    const entry = entries[index];
    if (entry === undefined || !entry.collidedWithPrevious) {
      index += 1;
      continue;
    }

    const groupStart = index - 1;
    let groupEnd = index;
    while (groupEnd + 1 < entries.length) {
      const next = entries[groupEnd + 1];
      if (next === undefined || !next.collidedWithPrevious) break;
      groupEnd += 1;
    }

    let displacementTotal = 0;
    let memberCount = 0;
    for (let memberIndex = groupStart; memberIndex <= groupEnd; memberIndex += 1) {
      const member = entries[memberIndex];
      if (member === undefined) continue;
      displacementTotal += member.cardY + member.cardHeight / 2 - member.idealCenterY;
      memberCount += 1;
    }

    const first = entries[groupStart];
    if (first !== undefined && memberCount > 0) {
      const previous = entries[groupStart - 1];
      const lowerBoundary = previous ? previous.cardY + previous.cardHeight + cardGap : topPadding;
      const availableUpwardSpace = Math.max(0, first.cardY - lowerBoundary);
      const averageDisplacement = Math.max(0, displacementTotal / memberCount);
      const shift = Math.min(availableUpwardSpace, averageDisplacement);

      if (shift > 0) {
        for (let memberIndex = groupStart; memberIndex <= groupEnd; memberIndex += 1) {
          const member = entries[memberIndex];
          if (member !== undefined) member.cardY -= shift;
        }
      }
    }

    index = groupEnd + 1;
  }
}

function createElasticScalePoints(
  entries: readonly WorkingElasticEntry[],
  axisTop: number,
  axisBottom: number,
): TimeScalePoint[] {
  const points: TimeScalePoint[] = [{ minute: 0, y: axisTop }];

  let index = 0;
  while (index < entries.length) {
    const first = entries[index];
    if (first === undefined) break;
    const minute = first.minuteOfDay;
    let centerTotal = 0;
    let count = 0;
    while (index < entries.length) {
      const entry = entries[index];
      if (entry === undefined || entry.minuteOfDay !== minute) break;
      centerTotal += entry.cardY + entry.cardHeight / 2;
      count += 1;
      index += 1;
    }

    // Minute zero already has the canonical 00:00 endpoint. Same-time entries
    // intentionally share one node and connect out to their separate cards.
    if (minute > 0 && count > 0) {
      points.push({ minute, y: centerTotal / count });
    }
  }

  points.push({ minute: MINUTES_PER_DAY, y: axisBottom });
  return points;
}

/** Compute a deterministic, collision-free elastic daily timeline. */
export function calculateElasticTimelineLayout(
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

  if (entries.length === 0) {
    const axisTop = options.topPadding;
    const axisBottom = Math.max(axisTop + 1, baseHeight - options.bottomPadding);
    const timeScale = createLinearTimeScale(axisTop, axisBottom);
    return makeTimelineLayoutResult({
      mode: "elastic",
      totalHeight: baseHeight,
      axisTop,
      axisBottom,
      columnCount: 1,
      entries: [],
      timeScale,
    });
  }

  const workingEntries = forwardCollisionPass(
    entries,
    baseHeight,
    options.topPadding,
    options.bottomPadding,
    maximumCardHeight,
    options.cardGap,
  );
  backwardBalanceDenseGroups(workingEntries, options.topPadding, options.cardGap);

  const finalBottom = workingEntries.reduce(
    (maximum, entry) => Math.max(maximum, entry.cardY + entry.cardHeight),
    options.topPadding,
  );
  const totalHeight = Math.max(baseHeight, finalBottom + options.bottomPadding);
  const axisTop = options.topPadding;
  const axisBottom = totalHeight - options.bottomPadding;
  const timeScale = createPiecewiseTimeScale(
    createElasticScalePoints(workingEntries, axisTop, axisBottom),
  );

  const laidOutEntries: LaidOutTimelineEntry[] = workingEntries.map((entry, order) => ({
    id: entry.id,
    minuteOfDay: entry.minuteOfDay,
    order,
    nodeY: timeScale.minuteToY(entry.minuteOfDay),
    cardY: entry.cardY,
    cardHeight: entry.cardHeight,
    column: 0,
  }));

  return makeTimelineLayoutResult({
    mode: "elastic",
    totalHeight,
    axisTop,
    axisBottom,
    columnCount: 1,
    entries: laidOutEntries,
    timeScale,
  });
}

export const layoutElasticTimeline = calculateElasticTimelineLayout;
