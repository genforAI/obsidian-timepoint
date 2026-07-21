import type { TimePointEntry } from "../model/types";
import { hasReservedTimePointMarkerOutsideFence } from "../storage/TimePointSerializer";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

export function isValidTime(value: string): boolean {
  const match = TIME_PATTERN.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function minuteOfDay(value: string): number {
  if (!isValidTime(value)) {
    throw new Error(`Invalid TimePoint time: ${value}`);
  }
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export function isValidEntryId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function isValidTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

export function syntheticTimestamp(date: string, time: string): string {
  return `${date}T${time}:00.000Z`;
}

export function validateEntry(entry: TimePointEntry): string[] {
  const reasons: string[] = [];
  if (!isValidEntryId(entry.id)) reasons.push("invalid ID");
  if (!isValidDate(entry.date)) reasons.push("invalid date");
  if (!isValidTime(entry.time)) reasons.push("invalid time");
  if (isValidTime(entry.time) && entry.minuteOfDay !== minuteOfDay(entry.time)) {
    reasons.push("minuteOfDay does not match time");
  }
  if (typeof entry.contentMarkdown !== "string") {
    reasons.push("contentMarkdown must be a string");
  } else if (hasReservedTimePointMarkerOutsideFence(entry.contentMarkdown)) {
    reasons.push("contentMarkdown contains a reserved TimePoint boundary marker");
  }
  if (
    !Array.isArray(entry.tags) ||
    entry.tags.some((tag) => typeof tag !== "string" || tag.includes("-->"))
  ) {
    reasons.push("tags must be strings without an HTML comment terminator");
  }
  if (entry.timezone !== undefined && !isSafeOptionalText(entry.timezone)) {
    reasons.push("timezone must be one line of at most 256 characters");
  }
  if (entry.source !== undefined && !isSafeOptionalText(entry.source)) {
    reasons.push("source must be one line of at most 256 characters");
  }
  if (!isValidTimestamp(entry.createdAt)) reasons.push("invalid createdAt timestamp");
  if (!isValidTimestamp(entry.updatedAt)) reasons.push("invalid updatedAt timestamp");
  return reasons;
}

function isSafeOptionalText(value: string): boolean {
  return value.length <= 256 && !/[\r\n]/u.test(value) && !value.includes("-->");
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
