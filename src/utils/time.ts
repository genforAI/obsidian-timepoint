export const MINUTES_PER_DAY = 24 * 60;
export const LAST_STORED_MINUTE = MINUTES_PER_DAY - 1;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const STORED_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isValidDateString(value: string): boolean;
export function isValidDateString(value: unknown): value is string;
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

/** True only for persistable wall-clock values from 00:00 through 23:59. */
export function isValidStoredTime(value: string): boolean;
export function isValidStoredTime(value: unknown): value is string;
export function isValidStoredTime(value: unknown): value is string {
  return typeof value === "string" && STORED_TIME_PATTERN.test(value);
}

/** True for timeline labels/coordinates, including the non-persistable 24:00 endpoint. */
export function isValidAxisTime(value: unknown): value is string {
  return value === "24:00" || isValidStoredTime(value);
}

export function timeToMinuteOfDay(time: string): number {
  if (!isValidStoredTime(time)) {
    throw new RangeError(`Invalid stored time: ${time}. Expected 00:00 through 23:59.`);
  }
  const [hoursText, minutesText] = time.split(":");
  return Number(hoursText) * 60 + Number(minutesText);
}

export function axisTimeToMinute(time: string): number {
  if (time === "24:00") return MINUTES_PER_DAY;
  return timeToMinuteOfDay(time);
}

export function minuteOfDayToTime(minute: number): string {
  if (!Number.isInteger(minute) || minute < 0 || minute > LAST_STORED_MINUTE) {
    throw new RangeError(
      `Invalid stored minute: ${minute}. Expected an integer from 0 through 1439.`,
    );
  }
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

export function axisMinuteToTime(minute: number): string {
  if (minute === MINUTES_PER_DAY) return "24:00";
  return minuteOfDayToTime(minute);
}

export function clampAxisMinute(minute: number): number {
  if (!Number.isFinite(minute)) return 0;
  return Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(minute)));
}

export function snapAxisMinute(minute: number, interval: number): number {
  if (!Number.isInteger(interval) || interval <= 0 || interval > MINUTES_PER_DAY) {
    throw new RangeError("Snap interval must be an integer from 1 through 1440.");
  }
  return clampAxisMinute(Math.round(clampAxisMinute(minute) / interval) * interval);
}

export function todayDateString(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function currentTimeString(now: Date = new Date()): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

export function shiftDate(date: string, amountInDays: number): string {
  if (!isValidDateString(date)) throw new RangeError(`Invalid date: ${date}.`);
  if (!Number.isInteger(amountInDays)) throw new RangeError("Day offset must be an integer.");

  const [yearText, monthText, dayText] = date.split("-");
  const candidate = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  candidate.setUTCDate(candidate.getUTCDate() + amountInDays);
  return `${candidate.getUTCFullYear()}-${pad2(candidate.getUTCMonth() + 1)}-${pad2(candidate.getUTCDate())}`;
}

export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function formatDisplayTime(time: string, format: "24h" | "12h"): string {
  if (time === "24:00") return format === "24h" ? time : "12:00 AM";
  const minute = timeToMinuteOfDay(time);
  if (format === "24h") return time;
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  const suffix = hours < 12 ? "AM" : "PM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${pad2(minutes)} ${suffix}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
