import { App, Notice, Plugin } from "obsidian";
import { registerEmbeddedTimePointProcessor } from "./embedded";
import { t } from "./i18n";
import {
  fingerprintImportPlans,
  planImport,
  type ImportConflictStrategy,
  type ImportPlan,
  type ParsedImport,
} from "./import-export";
import type { TimePointEntry } from "./model/types";
import { ExportService, type ExportFormat } from "./services/ExportService";
import {
  DEFAULT_SETTINGS,
  TimePointSettingTab,
  sanitizeSettings,
  type TimePointSettings,
} from "./settings/settings";
import { DayFileRepository, createEntryMutationExpectation } from "./storage";
import { getLocalTimezone, isValidDateString, todayDateString } from "./utils/time";
import { ImportModal, type ImportPreviewSummary } from "./views/ImportModal";
import { ExportModal } from "./views/ExportModal";
import { TIMEPOINT_VIEW_TYPE, TimePointView } from "./views/TimePointView";

interface PersistedPluginData extends Partial<TimePointSettings> {
  lastOpenedDate?: string;
  readyNoticeShown?: boolean;
}

interface SettingsController {
  open?: () => void;
  openTabById?: (id: string) => void;
}

export default class TimePointPlugin extends Plugin {
  override settings: TimePointSettings = { ...DEFAULT_SETTINGS };
  repository!: DayFileRepository;
  private exportService!: ExportService;
  private lastOpenedDate = "";
  private lastDeleted: TimePointEntry | null = null;
  private refreshTimer: number | null = null;
  private readyNoticeShown = false;

  override async onload(): Promise<void> {
    const data = (await this.loadData()) as PersistedPluginData | null;
    this.settings = sanitizeSettings(data);
    this.lastOpenedDate =
      data?.lastOpenedDate && isValidDateString(data.lastOpenedDate) ? data.lastOpenedDate : "";
    this.readyNoticeShown = data?.readyNoticeShown === true;

    this.repository = new DayFileRepository(this.app.vault, {
      getStorageFolder: () => this.settings.storageFolder,
      getTimezone: () => (this.settings.timezoneBehavior === "utc" ? "UTC" : getLocalTimezone()),
      trashFile: (file) => this.app.fileManager.trashFile(file),
    });
    this.exportService = new ExportService(
      this.app.vault,
      this.repository,
      () => this.settings.exportFolder,
      (file) => this.app.fileManager.trashFile(file),
    );

    this.registerView(TIMEPOINT_VIEW_TYPE, (leaf) => new TimePointView(leaf, this));
    registerEmbeddedTimePointProcessor(this);
    this.addRibbonIcon("calendar-clock", t("ribbon.open"), () => void this.activateTimePoint());
    this.addSettingTab(new TimePointSettingTab(this.app, this));
    this.registerCommands();
    this.registerVaultRefreshEvents();
    if (!this.readyNoticeShown) {
      this.readyNoticeShown = true;
      await this.saveSettings();
      this.app.workspace.onLayoutReady(() => new Notice(t("notice.ready"), 6_000));
    }
  }

  override onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
  }

  async saveSettings(): Promise<void> {
    this.settings = sanitizeSettings(this.settings);
    await this.saveData({
      ...this.settings,
      lastOpenedDate: this.lastOpenedDate,
      readyNoticeShown: this.readyNoticeShown,
    });
  }

  getInitialDate(): string {
    return this.settings.defaultDateBehavior === "last-opened" && this.lastOpenedDate
      ? this.lastOpenedDate
      : this.getCurrentDate();
  }

  getCurrentDate(now = new Date()): string {
    return this.settings.timezoneBehavior === "utc"
      ? now.toISOString().slice(0, 10)
      : todayDateString(now);
  }

  getCurrentTime(now = new Date()): string {
    return this.settings.timezoneBehavior === "utc"
      ? now.toISOString().slice(11, 16)
      : `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  setLastOpenedDate(date: string): void {
    if (!isValidDateString(date) || date === this.lastOpenedDate) return;
    this.lastOpenedDate = date;
    void this.saveSettings();
  }

  async activateTimePoint(date?: string): Promise<TimePointView> {
    let leaf = this.app.workspace.getLeavesOfType(TIMEPOINT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: TIMEPOINT_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof TimePointView)) {
      throw new Error("Obsidian could not initialize the TimePoint view.");
    }
    if (date) await view.setDate(date);
    return view;
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TIMEPOINT_VIEW_TYPE)) {
      if (leaf.view instanceof TimePointView) void leaf.view.refresh();
    }
  }

  rememberDeleted(entry: TimePointEntry): void {
    this.lastDeleted = { ...entry, tags: [...entry.tags] };
  }

  async exportDay(date: string, format: ExportFormat): Promise<void> {
    try {
      const path = await this.exportService.exportDay(date, format);
      new Notice(`Exported TimePoint day to ${path}`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "TimePoint export failed safely.");
    }
  }

  openExport(initialDate = this.getCurrentDate()): void {
    new ExportModal(this.app, {
      initialDate,
      appearanceMode: this.settings.appearanceMode,
      preview: (request) => this.exportService.preview(request),
      commit: (request, expectedFingerprint) =>
        this.exportService.export(request, expectedFingerprint),
      openPath: async (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (!file) throw new Error(`Export file is unavailable: ${path}`);
        await this.app.workspace.getLeaf("tab").openFile(file);
      },
    }).open();
  }

  openImport(): void {
    new ImportModal(this.app, {
      appearanceMode: this.settings.appearanceMode,
      defaultStrategy: this.settings.importConflictStrategy,
      preview: async (parsed, strategy) => this.planImportedEntries(parsed, strategy, false),
      commit: async (parsed, strategy, expectedPlanFingerprint) =>
        this.planImportedEntries(parsed, strategy, true, expectedPlanFingerprint),
    }).open();
  }

  openSettings(): void {
    const setting = (this.app as App & { setting?: SettingsController }).setting;
    if (!setting?.open || !setting.openTabById) {
      const communityPlugins = "Community plugins";
      new Notice(`Open Obsidian settings → ${communityPlugins} → this plugin.`);
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  async validateData(): Promise<string> {
    const prefix = `${this.settings.storageFolder.replace(/\/+$/u, "")}/`;
    const dates = new Set(
      this.app.vault
        .getMarkdownFiles()
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => dateFromStoragePath(file.path))
        .filter((date): date is string => date !== null),
    );
    if (dates.size === 0) return t("validation.none");

    let errors = 0;
    let warnings = 0;
    await Promise.all(
      [...dates].map(async (date) => {
        const day = await this.repository.loadDay(date);
        errors += day.diagnostics.filter((item) => item.severity === "error").length;
        warnings += day.diagnostics.filter((item) => item.severity === "warning").length;
      }),
    );
    return t("validation.result", { days: dates.size, errors, warnings });
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-timeline",
      name: t("command.open"),
      callback: () => void this.activateTimePoint(),
    });
    this.addCommand({
      id: "add-entry-now",
      name: t("command.addNow"),
      callback: async () => {
        const currentDate = this.getCurrentDate();
        const view = await this.activateTimePoint(currentDate);
        if (view.getDate() !== currentDate) {
          new Notice("Kept the unsaved timeline draft; current-time creation was cancelled.");
          return;
        }
        await view.openAddEditor();
      },
    });
    this.addCommand({
      id: "add-entry-open-day",
      name: t("command.addOpenDay"),
      callback: async () => {
        const view = await this.activateTimePoint();
        await view.openAddEditor();
      },
    });
    this.addCommand({
      id: "export-timeline-data",
      name: t("command.export"),
      callback: async () => {
        const view = await this.activateTimePoint();
        this.openExport(view.getDate());
      },
    });
    this.addCommand({
      id: "import-timeline-data",
      name: t("command.import"),
      callback: () => this.openImport(),
    });
    this.addCommand({
      id: "open-day-index",
      name: t("command.openIndex"),
      callback: async () => {
        const view = await this.activateTimePoint();
        await view.openCurrentDayIndex();
      },
    });
    this.addCommand({
      id: "migrate-day",
      name: t("command.migrate"),
      callback: async () => {
        const view = await this.activateTimePoint();
        await view.migrateCurrentDay();
      },
    });
    this.addCommand({
      id: "repair-legacy-day",
      name: t("command.repair"),
      callback: async () => {
        const view = await this.activateTimePoint();
        await view.repairCurrentLegacyDay();
      },
    });
    this.addCommand({
      id: "undo-last-delete",
      name: t("command.undoDelete"),
      checkCallback: (checking) => {
        if (!this.lastDeleted) return false;
        if (!checking) void this.restoreLastDeleted();
        return true;
      },
    });
    this.addCommand({
      id: "open-settings",
      name: t("command.openSettings"),
      callback: () => this.openSettings(),
    });
  }

  private registerVaultRefreshEvents(): void {
    const consider = (path: string): void => {
      const prefix = `${this.settings.storageFolder.replace(/\/+$/u, "")}/`;
      if (path.startsWith(prefix) && dateFromStoragePath(path)) {
        this.scheduleRefresh();
      }
    };
    this.registerEvent(this.app.vault.on("create", (file) => consider(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => consider(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => consider(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        consider(oldPath);
        consider(file.path);
      }),
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshViews();
    }, 120);
  }

  private async restoreLastDeleted(): Promise<void> {
    const entry = this.lastDeleted;
    if (!entry) return;
    try {
      await this.repository.addEntry(entry);
      this.lastDeleted = null;
      this.refreshViews();
      new Notice("Restored the deleted event.");
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "Could not restore the deleted TimePoint.",
      );
    }
  }

  private async planImportedEntries(
    parsed: ParsedImport,
    strategy: ImportConflictStrategy,
    commit: boolean,
    expectedPlanFingerprint?: string,
  ): Promise<ImportPreviewSummary> {
    if (!parsed.ok || parsed.issues.length > 0) {
      throw new Error("Import contains validation issues and was not applied.");
    }
    const byDate = groupByDate(parsed.entries);
    const plans: ImportPlan[] = [];
    for (const [date, incoming] of byDate) {
      const existingDay = await this.repository.loadDay(date);
      const unsafe = existingDay.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (unsafe) {
        throw new Error(`Import blocked for ${date}: ${unsafe.message}`);
      }
      plans.push(planImport(incoming, existingDay.entries, strategy));
    }

    const planFingerprint = fingerprintImportPlans(plans);

    if (commit) {
      if (!expectedPlanFingerprint || expectedPlanFingerprint !== planFingerprint) {
        throw new Error(
          "The vault changed after the import preview. Nothing was imported; refresh the preview and review the updated conflicts.",
        );
      }
      for (const plan of plans) await this.applyImportPlanToVault(plan);
      this.refreshViews();
    }

    return {
      entryCount: parsed.entries.length,
      conflictCount: sum(plans, "conflictCount"),
      insertCount: sum(plans, "insertCount"),
      replaceCount: sum(plans, "replaceCount"),
      skipCount: sum(plans, "skipCount"),
      rejectCount: sum(plans, "rejectCount"),
      dates: [...byDate.keys()].sort(),
      planFingerprint,
    };
  }

  private async applyImportPlanToVault(plan: ImportPlan): Promise<void> {
    for (const action of plan.actions) {
      if (action.kind === "insert" || action.kind === "rename-and-insert") {
        await this.repository.addEntry(action.entry);
      } else if (action.kind === "replace") {
        await this.repository.updateEntry(
          action.entry,
          createEntryMutationExpectation(action.replacedEntry),
        );
      }
    }
  }
}

function groupByDate(entries: readonly TimePointEntry[]): Map<string, TimePointEntry[]> {
  const groups = new Map<string, TimePointEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.date) ?? [];
    group.push(entry);
    groups.set(entry.date, group);
  }
  return groups;
}

function sum(plans: readonly ImportPlan[], key: keyof ImportPlan): number {
  return plans.reduce((total, plan) => {
    const value = plan[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function dateFromStoragePath(path: string): string | null {
  const match = /\/(\d{4}-\d{2}-\d{2})(?:\.md|\/[^/]+\.md)$/u.exec(path);
  const date = match?.[1];
  return date && isValidDateString(date) ? date : null;
}
