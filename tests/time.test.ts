import { describe, expect, it } from "vitest";
import {
  MINUTES_PER_DAY,
  axisMinuteToTime,
  axisTimeToMinute,
  clampAxisMinute,
  formatDisplayTime,
  isValidAxisTime,
  isValidDateString,
  isValidStoredTime,
  minuteOfDayToTime,
  shiftDate,
  snapAxisMinute,
  timeToMinuteOfDay,
} from "../src/utils/time";

describe("date and stored-time invariants", () => {
  it("validates real calendar dates", () => {
    expect(isValidDateString("2024-02-29")).toBe(true);
    expect(isValidDateString("2026-02-29")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("26-07-18")).toBe(false);
  });

  it("keeps 24:00 axis-only", () => {
    expect(isValidStoredTime("00:00")).toBe(true);
    expect(isValidStoredTime("23:59")).toBe(true);
    expect(isValidStoredTime("24:00")).toBe(false);
    expect(isValidAxisTime("24:00")).toBe(true);
    expect(axisTimeToMinute("24:00")).toBe(MINUTES_PER_DAY);
    expect(axisMinuteToTime(MINUTES_PER_DAY)).toBe("24:00");
    expect(() => timeToMinuteOfDay("24:00")).toThrow(RangeError);
  });

  it("round-trips every persistable minute", () => {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
      expect(timeToMinuteOfDay(minuteOfDayToTime(minute))).toBe(minute);
    }
  });

  it("clamps and snaps click coordinates safely", () => {
    expect(clampAxisMinute(-40)).toBe(0);
    expect(clampAxisMinute(2000)).toBe(1440);
    expect(snapAxisMinute(1439, 5)).toBe(1440);
    expect(snapAxisMinute(62, 5)).toBe(60);
    expect(() => snapAxisMinute(10, 0)).toThrow(RangeError);
  });

  it("shifts dates without DST or local-midnight drift", () => {
    expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("formats display labels without changing stored values", () => {
    expect(formatDisplayTime("00:00", "12h")).toBe("12:00 AM");
    expect(formatDisplayTime("12:30", "12h")).toBe("12:30 PM");
    expect(formatDisplayTime("23:59", "24h")).toBe("23:59");
  });
});
