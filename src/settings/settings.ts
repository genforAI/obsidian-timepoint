import { App, Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import { t } from "../i18n";
import type TimePointPlugin from "../main";
import type { TimelineMode } from "../model/types";
import type { CardDisplayMode } from "../views/cardDisplay";

export type { TimelineMode } from "../model/types";
export type { CardDisplayMode } from "../views/cardDisplay";
export type TimeFormat = "24h" | "12h";
export type DateBehavior = "today" | "last-opened";
export type TimezoneBehavior = "local" | "utc";
export type ImportConflictStrategy = "skip" | "replace" | "new-id";
export type AppearanceMode = "native" | "signature";

export interface TimePointSettings {
  storageFolder: string;
  exportFolder: string;
  appearanceMode: AppearanceMode;
  defaultTimelineMode: TimelineMode;
  defaultDateBehavior: DateBehavior;
  timeFormat: TimeFormat;
  timezoneBehavior: TimezoneBehavior;
  firstDayOfWeek: "monday" | "sunday" | "saturday";
  minimumCardGap: number;
  timelineBaseHeight: number;
  realtimeHeight: number;
  showTimeLabels: boolean;
  showConnectors: boolean;
  cardDisplayMode: CardDisplayMode;
  smartCollapseHeight: number;
  cardPreviewHeight: number;
  snapMinutes: number;
  importConflictStrategy: ImportConflictStrategy;
}

export const DEFAULT_SETTINGS: TimePointSettings = {
  storageFolder: "TimePoint/Days",
  exportFolder: "TimePoint/Exports",
  appearanceMode: "native",
  defaultTimelineMode: "elastic",
  defaultDateBehavior: "today",
  timeFormat: "24h",
  timezoneBehavior: "local",
  firstDayOfWeek: "monday",
  minimumCardGap: 12,
  timelineBaseHeight: 960,
  realtimeHeight: 1200,
  showTimeLabels: true,
  showConnectors: true,
  cardDisplayMode: "smart",
  smartCollapseHeight: 320,
  cardPreviewHeight: 180,
  snapMinutes: 5,
  importConflictStrategy: "skip",
};

type PersistedSettingsInput = Partial<TimePointSettings> & {
  /** v0.1 compatibility. Unlimited cards now migrate to the safe smart preview. */
  showFullNote?: unknown;
};

export function sanitizeSettings(raw: PersistedSettingsInput | null): TimePointSettings {
  const input = raw ?? {};
  return {
    storageFolder: normalizeFolder(input.storageFolder, DEFAULT_SETTINGS.storageFolder),
    exportFolder: normalizeFolder(input.exportFolder, DEFAULT_SETTINGS.exportFolder),
    appearanceMode: oneOf(input.appearanceMode, ["native", "signature"])
      ? input.appearanceMode
      : DEFAULT_SETTINGS.appearanceMode,
    defaultTimelineMode: oneOf(input.defaultTimelineMode, ["elastic", "realtime"])
      ? input.defaultTimelineMode
      : DEFAULT_SETTINGS.defaultTimelineMode,
    defaultDateBehavior: oneOf(input.defaultDateBehavior, ["today", "last-opened"])
      ? input.defaultDateBehavior
      : DEFAULT_SETTINGS.defaultDateBehavior,
    timeFormat: oneOf(input.timeFormat, ["24h", "12h"])
      ? input.timeFormat
      : DEFAULT_SETTINGS.timeFormat,
    timezoneBehavior: oneOf(input.timezoneBehavior, ["local", "utc"])
      ? input.timezoneBehavior
      : DEFAULT_SETTINGS.timezoneBehavior,
    firstDayOfWeek: oneOf(input.firstDayOfWeek, ["monday", "sunday", "saturday"])
      ? input.firstDayOfWeek
      : DEFAULT_SETTINGS.firstDayOfWeek,
    minimumCardGap: clampNumber(input.minimumCardGap, 4, 48, 12),
    timelineBaseHeight: clampNumber(input.timelineBaseHeight, 600, 3000, 960),
    realtimeHeight: clampNumber(input.realtimeHeight, 720, 3600, 1200),
    showTimeLabels:
      typeof input.showTimeLabels === "boolean"
        ? input.showTimeLabels
        : DEFAULT_SETTINGS.showTimeLabels,
    showConnectors:
      typeof input.showConnectors === "boolean"
        ? input.showConnectors
        : DEFAULT_SETTINGS.showConnectors,
    cardDisplayMode: normalizeCardDisplayMode(input),
    smartCollapseHeight: clampNumber(input.smartCollapseHeight, 160, 720, 320),
    cardPreviewHeight: clampNumber(input.cardPreviewHeight, 80, 600, 180),
    snapMinutes: normalizeSnap(input.snapMinutes),
    importConflictStrategy: oneOf(input.importConflictStrategy, ["skip", "replace", "new-id"])
      ? input.importConflictStrategy
      : DEFAULT_SETTINGS.importConflictStrategy,
  };
}

function normalizeFolder(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const segments = value
    .trim()
    .replace(/\\/gu, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return fallback;
  }
  return normalizePath(segments.join("/"));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function normalizeSnap(value: unknown): number {
  return [1, 5, 10, 15, 30].includes(Number(value)) ? Number(value) : 5;
}

function normalizeCardDisplayMode(input: PersistedSettingsInput): CardDisplayMode {
  if (oneOf(input.cardDisplayMode, ["smart", "preview"])) {
    return input.cardDisplayMode;
  }
  // v0.1/v0.2 could persist an unlimited `full` mode. v0.3 deliberately
  // removes unbounded timeline cards; the Markdown remains complete in the
  // native Obsidian editor and only its timeline preview is clipped.
  if ((input as { cardDisplayMode?: unknown }).cardDisplayMode === "full") return "smart";
  if (typeof input.showFullNote === "boolean") return "smart";
  return DEFAULT_SETTINGS.cardDisplayMode;
}

function oneOf<const T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.some((option) => option === value);
}

export class TimePointSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly timePoint: TimePointPlugin,
  ) {
    super(app, timePoint);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("timepoint-settings");
    containerEl.removeClass("timepoint-appearance-native", "timepoint-appearance-signature");
    containerEl.addClass(`timepoint-appearance-${this.timePoint.settings.appearanceMode}`);

    new Setting(containerEl).setName(t("settings.title")).setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description timepoint-settings-intro",
      text: t("settings.intro"),
    });

    this.addHeading(t("settings.general"));
    new Setting(containerEl)
      .setName(t("settings.open"))
      .setDesc(t("settings.openDesc"))
      .addButton((button) =>
        button.setButtonText(t("settings.open")).onClick(() => {
          void this.timePoint.activateTimePoint();
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.appearance"))
      .setDesc(t("settings.appearanceDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("native", t("settings.native"))
          .addOption("signature", t("settings.signature"))
          .setValue(this.timePoint.settings.appearanceMode)
          .onChange(async (value) => {
            this.timePoint.settings.appearanceMode = value as AppearanceMode;
            await this.timePoint.saveSettings();
            this.update();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.storageFolder"))
      .setDesc(t("settings.storageFolderDesc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.storageFolder)
          .setValue(this.timePoint.settings.storageFolder)
          .onChange(async (value) => {
            const normalized = normalizeFolder(value, DEFAULT_SETTINGS.storageFolder);
            this.timePoint.settings.storageFolder = normalized;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.defaultDate"))
      .setDesc(t("settings.defaultDateDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("today", t("settings.today"))
          .addOption("last-opened", t("settings.lastOpened"))
          .setValue(this.timePoint.settings.defaultDateBehavior)
          .onChange(async (value) => {
            this.timePoint.settings.defaultDateBehavior = value as DateBehavior;
            await this.timePoint.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.timeFormat"))
      .setDesc(t("settings.timeFormatDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("24h", "24-hour")
          .addOption("12h", "12-hour")
          .setValue(this.timePoint.settings.timeFormat)
          .onChange(async (value) => {
            this.timePoint.settings.timeFormat = value as TimeFormat;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.timezone"))
      .setDesc(t("settings.timezoneDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("local", t("settings.localTimezone"))
          .addOption("utc", t("settings.utc"))
          .setValue(this.timePoint.settings.timezoneBehavior)
          .onChange(async (value) => {
            this.timePoint.settings.timezoneBehavior = value as TimezoneBehavior;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.firstDay"))
      .setDesc(t("settings.firstDayDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("monday", t("settings.monday"))
          .addOption("sunday", t("settings.sunday"))
          .addOption("saturday", t("settings.saturday"))
          .setValue(this.timePoint.settings.firstDayOfWeek)
          .onChange(async (value) => {
            this.timePoint.settings.firstDayOfWeek = value as TimePointSettings["firstDayOfWeek"];
            await this.timePoint.saveSettings();
          }),
      );

    this.addHeading(t("settings.timeline"));
    new Setting(containerEl)
      .setName(t("settings.defaultLayout"))
      .setDesc(t("settings.defaultLayoutDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("elastic", t("view.elastic"))
          .addOption("realtime", t("view.realtime"))
          .setValue(this.timePoint.settings.defaultTimelineMode)
          .onChange(async (value) => {
            this.timePoint.settings.defaultTimelineMode = value as TimelineMode;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.minimumGap"))
      .setDesc(t("settings.minimumGapValue", { value: this.timePoint.settings.minimumCardGap }))
      .addSlider((slider) =>
        slider
          .setLimits(4, 32, 2)
          .setValue(this.timePoint.settings.minimumCardGap)
          .onChange(async (value) => {
            this.timePoint.settings.minimumCardGap = value;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.elasticHeight"))
      .setDesc(t("settings.elasticHeightDesc"))
      .addText((text) =>
        text
          .setValue(String(this.timePoint.settings.timelineBaseHeight))
          .setPlaceholder("960")
          .onChange(async (value) => {
            this.timePoint.settings.timelineBaseHeight = clampNumber(
              valueAsNumber(value),
              600,
              3000,
              960,
            );
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.realtimeHeight"))
      .setDesc(t("settings.realtimeHeightDesc"))
      .addText((text) =>
        text
          .setValue(String(this.timePoint.settings.realtimeHeight))
          .setPlaceholder("1200")
          .onChange(async (value) => {
            this.timePoint.settings.realtimeHeight = clampNumber(
              valueAsNumber(value),
              720,
              3600,
              1200,
            );
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.snapping"))
      .setDesc(t("settings.snappingDesc"))
      .addDropdown((dropdown) => {
        for (const value of [1, 5, 10, 15, 30]) dropdown.addOption(String(value), `${value} min`);
        dropdown.setValue(String(this.timePoint.settings.snapMinutes)).onChange(async (value) => {
          this.timePoint.settings.snapMinutes = normalizeSnap(Number(value));
          await this.timePoint.saveSettings();
        });
      });

    new Setting(containerEl).setName(t("settings.showLabels")).addToggle((toggle) =>
      toggle.setValue(this.timePoint.settings.showTimeLabels).onChange(async (value) => {
        this.timePoint.settings.showTimeLabels = value;
        await this.timePoint.saveSettings();
        this.timePoint.refreshViews();
      }),
    );

    new Setting(containerEl).setName(t("settings.showConnectors")).addToggle((toggle) =>
      toggle.setValue(this.timePoint.settings.showConnectors).onChange(async (value) => {
        this.timePoint.settings.showConnectors = value;
        await this.timePoint.saveSettings();
        this.timePoint.refreshViews();
      }),
    );

    this.addHeading(t("settings.notes"));
    new Setting(containerEl)
      .setName(t("settings.preview"))
      .setDesc(t("settings.previewDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("smart", t("settings.comfortable"))
          .addOption("preview", t("settings.compact"))
          .setValue(this.timePoint.settings.cardDisplayMode)
          .onChange(async (value) => {
            this.timePoint.settings.cardDisplayMode = value as CardDisplayMode;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.comfortableHeight"))
      .setDesc(
        t("settings.comfortableHeightValue", {
          value: this.timePoint.settings.smartCollapseHeight,
        }),
      )
      .addSlider((slider) =>
        slider
          .setLimits(160, 720, 20)
          .setValue(this.timePoint.settings.smartCollapseHeight)
          .onChange(async (value) => {
            this.timePoint.settings.smartCollapseHeight = value;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.compactHeight"))
      .setDesc(
        t("settings.compactHeightValue", { value: this.timePoint.settings.cardPreviewHeight }),
      )
      .addSlider((slider) =>
        slider
          .setLimits(80, 400, 20)
          .setValue(this.timePoint.settings.cardPreviewHeight)
          .onChange(async (value) => {
            this.timePoint.settings.cardPreviewHeight = value;
            await this.timePoint.saveSettings();
            this.timePoint.refreshViews();
          }),
      );

    this.addHeading(t("settings.importExport"));
    new Setting(containerEl)
      .setName(t("settings.exportFolder"))
      .setDesc(t("settings.exportFolderDesc"))
      .addText((text) =>
        text
          .setValue(this.timePoint.settings.exportFolder)
          .setPlaceholder(DEFAULT_SETTINGS.exportFolder)
          .onChange(async (value) => {
            this.timePoint.settings.exportFolder = normalizeFolder(
              value,
              DEFAULT_SETTINGS.exportFolder,
            );
            await this.timePoint.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.conflicts"))
      .setDesc(t("settings.conflictsDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("skip", t("import.skip"))
          .addOption("replace", t("import.replace"))
          .addOption("new-id", t("import.newId"))
          .setValue(this.timePoint.settings.importConflictStrategy)
          .onChange(async (value) => {
            this.timePoint.settings.importConflictStrategy = value as ImportConflictStrategy;
            await this.timePoint.saveSettings();
          }),
      );

    this.addHeading(t("settings.data"));
    const localCard = containerEl.createDiv({ cls: "timepoint-local-card" });
    localCard.createEl("strong", { text: t("settings.localFirst") });
    localCard.createEl("p", {
      text: t("settings.localFirstDesc"),
    });

    new Setting(containerEl)
      .setName(t("settings.validate"))
      .setDesc(t("settings.validateDesc"))
      .addButton((button) =>
        button.setButtonText(t("settings.validateButton")).onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await this.timePoint.validateData();
            new Notice(result);
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl)
      .setName(t("settings.rebuild"))
      .setDesc(t("settings.rebuildDesc"))
      .addButton((button) =>
        button.setButtonText(t("settings.rebuildButton")).onClick(() => {
          this.timePoint.refreshViews();
          new Notice(t("notice.viewsRefreshed"));
        }),
      );
  }

  private addHeading(text: string): void {
    new Setting(this.containerEl).setName(text).setHeading();
  }
}

function valueAsNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
