import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  normalizePath: (value: string) => value.replace(/\/{2,}/gu, "/"),
  Notice: class Notice {},
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
}));

import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings/settings";

describe("settings sanitization", () => {
  it("retains valid user choices and normalizes folder separators", () => {
    const settings = sanitizeSettings({
      storageFolder: " Journal\\TimePoint//Days/ ",
      appearanceMode: "signature",
      defaultTimelineMode: "realtime",
      minimumCardGap: 20,
      showConnectors: false,
      importConflictStrategy: "new-id",
    });

    expect(settings).toMatchObject({
      storageFolder: "Journal/TimePoint/Days",
      appearanceMode: "signature",
      defaultTimelineMode: "realtime",
      minimumCardGap: 20,
      showConnectors: false,
      importConflictStrategy: "new-id",
    });
  });

  it("migrates missing or invalid appearance settings to native mode", () => {
    expect(sanitizeSettings(null).appearanceMode).toBe("native");
    expect(sanitizeSettings({ appearanceMode: "purple" as "native" }).appearanceMode).toBe(
      "native",
    );
    expect(sanitizeSettings({ appearanceMode: "signature" }).appearanceMode).toBe("signature");
  });

  it("rejects traversal, invalid enums, and out-of-range numeric state", () => {
    const settings = sanitizeSettings({
      storageFolder: "TimePoint/../Outside",
      defaultTimelineMode: "broken" as "elastic",
      snapMinutes: 7,
      timelineBaseHeight: -50,
      showTimeLabels: "yes" as unknown as boolean,
    });

    expect(settings.storageFolder).toBe(DEFAULT_SETTINGS.storageFolder);
    expect(settings.defaultTimelineMode).toBe(DEFAULT_SETTINGS.defaultTimelineMode);
    expect(settings.snapMinutes).toBe(DEFAULT_SETTINGS.snapMinutes);
    expect(settings.timelineBaseHeight).toBe(600);
    expect(settings.showTimeLabels).toBe(DEFAULT_SETTINGS.showTimeLabels);
  });

  it("migrates the v0.1 showFullNote setting without losing its intent", () => {
    expect(sanitizeSettings({ showFullNote: true }).cardDisplayMode).toBe("smart");
    expect(sanitizeSettings({ showFullNote: false }).cardDisplayMode).toBe("smart");
  });

  it("migrates the removed unlimited v0.2 card mode to a bounded preview", () => {
    expect(
      sanitizeSettings({ cardDisplayMode: "full" } as unknown as Parameters<
        typeof sanitizeSettings
      >[0]).cardDisplayMode,
    ).toBe("smart");
  });

  it("prefers an explicit v0.2 card mode and sanitizes display heights", () => {
    const settings = sanitizeSettings({
      cardDisplayMode: "preview",
      showFullNote: true,
      smartCollapseHeight: 9_000,
      cardPreviewHeight: 20,
    });

    expect(settings.cardDisplayMode).toBe("preview");
    expect(settings.smartCollapseHeight).toBe(720);
    expect(settings.cardPreviewHeight).toBe(80);
    expect(settings).not.toHaveProperty("showFullNote");
  });
});
