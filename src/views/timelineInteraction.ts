import { LAST_STORED_MINUTE, minuteOfDayToTime, snapAxisMinute } from "../utils/time";

export const DEFAULT_AXIS_HIT_RADIUS = 22;

export interface TimelinePointerTime {
  minuteOfDay: number;
  time: string;
}

/** Only the deliberately generous strip around the day axis creates entries. */
export function isWithinTimelineAxisHitArea(
  pointerX: number,
  axisX: number,
  hitRadius = DEFAULT_AXIS_HIT_RADIUS,
): boolean {
  if (![pointerX, axisX, hitRadius].every(Number.isFinite) || hitRadius < 0) return false;
  return Math.abs(pointerX - axisX) <= hitRadius;
}

/**
 * Map a visual Y coordinate through the active layout's inverse scale, then
 * snap it to a persistable wall-clock minute. The 24:00 endpoint becomes
 * 23:59 because 24:00 is an axis label, never a stored entry time.
 */
export function mapTimelineYToStoredTime(
  visualY: number,
  axisTop: number,
  axisBottom: number,
  yToEntryMinute: (y: number) => number,
  snapMinutes: number,
): TimelinePointerTime | null {
  if (
    ![visualY, axisTop, axisBottom].every(Number.isFinite) ||
    axisBottom < axisTop ||
    visualY < axisTop ||
    visualY > axisBottom
  ) {
    return null;
  }

  const rawMinute = yToEntryMinute(visualY);
  if (!Number.isFinite(rawMinute)) return null;
  const minuteOfDay = Math.min(LAST_STORED_MINUTE, snapAxisMinute(rawMinute, snapMinutes));
  return { minuteOfDay, time: minuteOfDayToTime(minuteOfDay) };
}
