import { App, Notice, Plugin, TFile, TFolder, requestUrl } from "obsidian";
import { registerEmbeddedTimePointProcessor } from "./embedded";
import { t } from "./i18n";
import {
  fingerprintImportPlans,
  planImport,
  type ImportConflictStrategy,
  type ImportPlan,
  type ParsedImport,
} from "./import-export";
import type {
  TimePointDayViewState,
  TimePointEntry,
  TimePointRelationGraph,
  TimePointRelationCard,
} from "./model/types";
import { RelationService } from "./relations";
import { ExternalSnapshotService, sha256Hex } from "./services/ExternalSnapshotService";
import { ExportService, type ExportFormat } from "./services/ExportService";
import {
  PortableArchiveService,
  type PortableArchivePreview,
} from "./services/PortableArchiveService";
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
import {
  ExternalSnapshotConsentModal,
  type SnapshotConsentDecision,
} from "./views/ExternalSnapshotConsentModal";

interface PersistedPluginData extends Partial<TimePointSettings> {
  lastOpenedDate?: string;
  readyNoticeShown?: boolean;
  externalSnapshotConsent?: SnapshotConsentDecision;
}

interface SettingsController {
  open?: () => void;
  openTabById?: (id: string) => void;
}

export default class TimePointPlugin extends Plugin {
  override settings: TimePointSettings = { ...DEFAULT_SETTINGS };
  repository!: DayFileRepository;
  private exportService!: ExportService;
  private portableArchiveService!: PortableArchiveService;
  private relationService!: RelationService;
  private snapshotService!: ExternalSnapshotService;
  private lastOpenedDate = "";
  private lastDeleted: TimePointEntry | null = null;
  private refreshTimer: number | null = null;
  private readyNoticeShown = false;
  externalSnapshotConsent: SnapshotConsentDecision = "dismissed";
  private readonly snapshotAttempts = new Map<string, number>();

  override async onload(): Promise<void> {
    const data = (await this.loadData()) as PersistedPluginData | null;
    this.settings = sanitizeSettings(data);
    this.lastOpenedDate =
      data?.lastOpenedDate && isValidDateString(data.lastOpenedDate) ? data.lastOpenedDate : "";
    this.readyNoticeShown = data?.readyNoticeShown === true;
    this.externalSnapshotConsent =
      data?.externalSnapshotConsent === "granted" || data?.externalSnapshotConsent === "declined"
        ? data.externalSnapshotConsent
        : "dismissed";

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
      (target, sourcePath) => this.app.metadataCache.getFirstLinkpathDest(target, sourcePath),
    );
    this.portableArchiveService = new PortableArchiveService(
      this.app.vault,
      this.repository,
      () => this.settings.storageFolder,
      (file) => this.app.fileManager.trashFile(file),
    );
    this.relationService = new RelationService(this.app, this.repository);
    this.snapshotService = new ExternalSnapshotService({
      vault: this.app.vault,
      request: (request) => requestUrl(request),
    });

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
      externalSnapshotConsent: this.externalSnapshotConsent,
    });
  }

  async buildRelationGraph(
    entries: readonly TimePointEntry[],
    state: TimePointDayViewState,
  ): Promise<TimePointRelationGraph> {
    const graph = await this.relationService.buildDayGraph(entries, state);
    await Promise.all(
      graph.cards
        .filter((card) => card.kind === "external-url")
        .map(async (card) => {
          const id = await sha256Hex(card.target);
          const snapshot = await this.snapshotService.readSnapshot(id);
          if (!snapshot) return;
          card.snapshotId = snapshot.id;
          card.title = snapshot.title;
          card.description = snapshot.description;
          if (snapshot.previewPath) card.previewPath = snapshot.previewPath;
        }),
    );
    return graph;
  }

  async ensureExternalSnapshotConsent(): Promise<boolean> {
    if (this.externalSnapshotConsent === "granted") return true;
    if (this.externalSnapshotConsent === "declined") return false;
    const decision = await new Promise<SnapshotConsentDecision>((resolve) => {
      new ExternalSnapshotConsentModal(this.app, this.settings.appearanceMode, resolve).open();
    });
    if (decision === "granted" || decision === "declined") {
      this.externalSnapshotConsent = decision;
      await this.saveSettings();
    }
    return decision === "granted";
  }

  async setExternalSnapshotConsent(decision: SnapshotConsentDecision): Promise<void> {
    this.externalSnapshotConsent = decision;
    if (decision === "granted") this.snapshotAttempts.clear();
    await this.saveSettings();
  }

  /** Hydrate URL cards after the local graph is already visible. */
  async hydrateExternalRelations(
    graph: TimePointRelationGraph,
    entries: readonly TimePointEntry[],
  ): Promise<boolean> {
    const externalCards = graph.cards.filter((card) => card.kind === "external-url");
    const associations = new Map(entries.map((entry) => [entry.id, new Set<string>()]));
    let changed = false;
    await Promise.all(
      externalCards.map(async (card) => {
        const lastAttempt = this.snapshotAttempts.get(card.target) ?? 0;
        const allowNetwork =
          this.externalSnapshotConsent === "granted" && Date.now() - lastAttempt >= 60_000;
        if (allowNetwork) this.snapshotAttempts.set(card.target, Date.now());
        const result = await this.snapshotService.getOrCreate(
          card.target,
          card.sourceEntryIds,
          allowNetwork,
        );
        if (!result.snapshot) return;
        if (card.snapshotId !== result.snapshot.id) changed = true;
        card.snapshotId = result.snapshot.id;
        card.title = result.snapshot.title;
        card.description = result.snapshot.description;
        if (result.snapshot.previewPath) card.previewPath = result.snapshot.previewPath;
        for (const entryId of card.sourceEntryIds) {
          associations.get(entryId)?.add(result.snapshot.id);
        }
      }),
    );
    await Promise.all(
      entries.map(async (entry) => {
        const desired = [...(associations.get(entry.id) ?? [])].sort();
        if (JSON.stringify(desired) === JSON.stringify([...(entry.linkSnapshotIds ?? [])].sort())) {
          return;
        }
        await this.repository.updateLinkSnapshotIds(entry, desired);
        changed = true;
      }),
    );
    return changed;
  }

  async refreshExternalSnapshot(
    card: TimePointRelationCard,
    entries: readonly TimePointEntry[],
  ): Promise<boolean> {
    if (card.kind !== "external-url" || !(await this.ensureExternalSnapshotConsent())) return false;
    this.snapshotAttempts.delete(card.target);
    const result = await this.snapshotService.getOrCreate(
      card.target,
      card.sourceEntryIds,
      true,
      true,
    );
    if (result.status !== "fetched" || !result.snapshot) {
      throw new Error(result.reason ?? t("relations.snapshotFailure"));
    }
    await Promise.all(
      entries
        .filter((entry) => card.sourceEntryIds.includes(entry.id))
        .map((entry) =>
          this.repository.updateLinkSnapshotIds(entry, [
            ...(entry.linkSnapshotIds ?? []),
            result.snapshot?.id ?? "",
          ]),
        ),
    );
    return true;
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

  /** Coalesce an explicit UI mutation with the matching Vault modify event. */
  requestRefresh(): void {
    this.scheduleRefresh();
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
      previewPortable: async (file) =>
        this.portablePreviewSummary(await this.portableArchiveService.preview(file)),
      commitPortable: async (file, expectedPlanFingerprint) => {
        const result = await this.portableArchiveService.import(file, expectedPlanFingerprint);
        this.refreshViews();
        return this.portablePreviewSummary(result);
      },
    }).open();
  }

  private portablePreviewSummary(preview: PortableArchivePreview): ImportPreviewSummary {
    return {
      entryCount: preview.entryCount,
      attachmentCount: preview.attachmentCount,
      conflictCount: preview.conflicts.length,
      insertCount: preview.canImport ? preview.entryCount : 0,
      replaceCount: 0,
      skipCount: 0,
      rejectCount: preview.canImport
        ? 0
        : Math.max(1, preview.errors.length + preview.conflicts.length),
      dates: preview.dates,
      planFingerprint: preview.planFingerprint,
    };
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
    const storageFolder = this.settings.storageFolder.replace(/\/+$/u, "");
    const root = this.app.vault.getFolderByPath(storageFolder);
    if (!root) return t("validation.none");
    const dates = new Set(
      markdownFilesInFolder(root)
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
      const snapshotsPrefix = "TimePoint/Snapshots/";
      if (
        (path.startsWith(prefix) && dateFromStoragePath(path)) ||
        path.startsWith(snapshotsPrefix)
      ) {
        this.scheduleRefresh();
      }
    };
    this.registerEvent(this.app.vault.on("create", (file) => consider(file.path)));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        void this.repository
          .classifyManagedViewStateChange(file)
          .then((change) => {
            if (change === "none") consider(file.path);
          })
          .catch(() => consider(file.path));
      }),
    );
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

function markdownFilesInFolder(root: TFolder): TFile[] {
  const files: TFile[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const folder = pending.pop();
    if (!folder) continue;
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension.toLowerCase() === "md") files.push(child);
      else if (child instanceof TFolder) pending.push(child);
    }
  }
  return files;
}
