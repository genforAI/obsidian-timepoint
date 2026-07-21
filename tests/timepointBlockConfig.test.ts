import { describe, expect, it } from "vitest";
import {
  parseTimePointBlockConfig,
  pathsAffectEmbeddedDay,
} from "../src/embedded/TimePointBlockConfig";

const TODAY = "2026-07-18";

describe("parseTimePointBlockConfig", () => {
  it("uses safe defaults for an empty block", () => {
    expect(parseTimePointBlockConfig("", { today: TODAY })).toEqual({
      ok: true,
      config: {
        date: TODAY,
        dateSource: "today",
        mode: "elastic",
        editable: false,
      },
      issues: [],
    });
  });

  it("resolves today deterministically and accepts CRLF", () => {
    expect(
      parseTimePointBlockConfig("date: today\r\nmode: realtime\r\neditable: true\r\n", {
        today: TODAY,
      }),
    ).toEqual({
      ok: true,
      config: {
        date: TODAY,
        dateSource: "today",
        mode: "realtime",
        editable: true,
      },
      issues: [],
    });
  });

  it("accepts an explicit real ISO calendar date", () => {
    const result = parseTimePointBlockConfig(
      "# A read-only historical timeline\ndate: 2024-02-29\nmode: elastic\neditable: false",
      { today: TODAY },
    );
    expect(result).toEqual({
      ok: true,
      config: {
        date: "2024-02-29",
        dateSource: "explicit",
        mode: "elastic",
        editable: false,
      },
      issues: [],
    });
  });

  it("rejects impossible dates rather than normalizing them", () => {
    const result = parseTimePointBlockConfig("date: 2026-02-30", { today: TODAY });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "INVALID_DATE", line: 1, key: "date" }),
      ]);
    }
  });

  it("reports unknown, duplicate, and invalid values together", () => {
    const result = parseTimePointBlockConfig(
      ["date: 2026-07-18", "date: today", "mode: compact", "editable: yes", "height: 900"].join(
        "\n",
      ),
      { today: TODAY },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => [issue.code, issue.line, issue.key])).toEqual([
        ["DUPLICATE_KEY", 2, "date"],
        ["UNKNOWN_KEY", 5, "height"],
        ["INVALID_MODE", 3, "mode"],
        ["INVALID_EDITABLE", 4, "editable"],
      ]);
      expect(result.issues.every((issue) => issue.message.length > 20)).toBe(true);
    }
  });

  it("rejects malformed lines and empty declared values", () => {
    const malformed = parseTimePointBlockConfig("mode elastic", { today: TODAY });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.issues[0]?.code).toBe("INVALID_SYNTAX");

    const empty = parseTimePointBlockConfig("editable:", { today: TODAY });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.issues[0]?.code).toBe("INVALID_EDITABLE");
  });

  it("is case-sensitive so unsupported spellings cannot be silently accepted", () => {
    const result = parseTimePointBlockConfig("Date: today\nmode: Elastic\neditable: TRUE", {
      today: TODAY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual([
        "UNKNOWN_KEY",
        "INVALID_MODE",
        "INVALID_EDITABLE",
      ]);
    }
  });
});

describe("pathsAffectEmbeddedDay", () => {
  const dayPath = "TimePoint/Days/2026/07/2026-07-18.md";

  it("refreshes only for the exact day path", () => {
    expect(pathsAffectEmbeddedDay(dayPath, [dayPath])).toBe(true);
    expect(
      pathsAffectEmbeddedDay(dayPath, ["TimePoint/Days/2026/07/2026-07-18/0815--tp-entry.md"]),
    ).toBe(true);
    expect(pathsAffectEmbeddedDay(dayPath, ["Archive/old.md", dayPath])).toBe(true);
    expect(pathsAffectEmbeddedDay(dayPath, ["TimePoint/Days/2026/07/2026-07-19.md"])).toBe(false);
    expect(pathsAffectEmbeddedDay(dayPath, [`${dayPath}.backup`])).toBe(false);
  });
});
