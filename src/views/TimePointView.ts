import {
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type TimePointPlugin from "../main";
import { getLocale, t } from "../i18n";
import type { ParsedDayFile, TimePointEntry } from "../model/types";
import {
  createEntryMutationExpectation,
  createTimePointEntry,
  locateStandaloneEditorTarget,
} from "../storage";
import type { TimelineMode } from "../settings/settings";
import { getLocalTimezone, isValidDateString, shiftDate, todayDateString } from "../utils/time";
import { TimelineRenderer } from "./TimelineRenderer";
import { locateNativeEditorTarget } from "./nativeEditorTarget";
import {
  MAX_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  normalizeTimelineZoom,
  resolveZoomedScrollTop,
  stepTimelineZoom,
  type TimelineInteractionMode,
} from "./timelineNavigation";

export const TIMEPOINT_VIEW_TYPE = "timepoint-view";

export class TimePointView extends ItemView {
  private selectedDate = todayDateString();
  private mode: TimelineMode;
  private shellEl!: HTMLElement;
  private dateTitleEl!: HTMLElement;
  private weekdayEl!: HTMLElement;
  private dateInput!: HTMLInputElement;
  private modeSelect!: HTMLSelectElement;
  private scrollEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private timelineHostEl!: HTMLElement;
  private nativeEditorLeaf: WorkspaceLeaf | null = null;
  private editingEntryId: string | null = null;
  private currentDay: ParsedDayFile | null = null;
  private timelineRenderer: TimelineRenderer;
  private createEntryPromise: Promise<void> | null = null;
  private interactionMode: TimelineInteractionMode = "select";
  private timelineZoom = 1;
  private panButton: HTMLButtonElement | null = null;
  private zoomOutButton: HTMLButtonElement | null = null;
  private zoomResetButton: HTMLButtonElement | null = null;
  private zoomInButton: HTMLButtonElement | null = null;
  private loadToken = 0;
  private opened = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly timePoint: TimePointPlugin,
  ) {
    super(leaf);
    this.mode = timePoint.settings.defaultTimelineMode;
    this.timelineRenderer = new TimelineRenderer(this.app);
    this.addChild(this.timelineRenderer);
  }

  override getViewType(): string {
    return TIMEPOINT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return `TimePoint · ${this.selectedDate}`;
  }

  override getIcon(): string {
    return "calendar-clock";
  }

  override async onOpen(): Promise<void> {
    this.opened = true;
    this.selectedDate = this.timePoint.getInitialDate();
    this.mode = this.timePoint.settings.defaultTimelineMode;
    this.buildView();
    this.refreshLeafHeader();
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (this.nativeEditorLeaf && !this.isLeafAttached(this.nativeEditorLeaf)) {
          this.nativeEditorLeaf = null;
          this.editingEntryId = null;
          this.syncEditingCardHighlight();
        }
      }),
    );
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncNativeEditorSurface()));
    await this.refresh();
  }

  override async onClose(): Promise<void> {
    this.opened = false;
    this.loadToken += 1;
    // The adjacent Markdown leaf is a real Obsidian note view and remains open
    // when the timeline closes, just like any user-opened Markdown pane.
    this.removeNativeEditorSurfaceClass();
    this.nativeEditorLeaf = null;
    this.contentEl.empty();
  }

  async setDate(date: string): Promise<void> {
    if (!isValidDateString(date)) {
      new Notice(t("notice.invalidDate", { date }));
      if (this.dateInput) this.dateInput.value = this.selectedDate;
      return;
    }
    if (date === this.selectedDate) return;
    this.selectedDate = date;
    this.timePoint.setLastOpenedDate(date);
    this.refreshLeafHeader();
    if (this.opened) await this.refresh();
  }

  getDate(): string {
    return this.selectedDate;
  }

  async refresh(): Promise<void> {
    if (!this.opened) return;
    const token = ++this.loadToken;
    this.contentEl.removeClass("timepoint-appearance-native", "timepoint-appearance-signature");
    this.contentEl.addClass(`timepoint-appearance-${this.timePoint.settings.appearanceMode}`);
    this.updateDateHeader();
    this.statusEl.removeClass("is-warning", "is-error");
    this.statusEl.setText(t("view.loading"));
    this.statusEl.show();

    try {
      const day = await this.timePoint.repository.loadDay(this.selectedDate);
      if (token !== this.loadToken) return;
      this.currentDay = day;
      this.renderDiagnostics(day);
      await this.timelineRenderer.render(
        this.timelineHostEl,
        day.entries,
        this.mode,
        this.timePoint.repository.getDayPath(this.selectedDate),
        this.timePoint.settings,
        {
          onCreateAtTime: (time) => this.openAddEditor(time),
          onCreateNow: () => this.openAddEditor(),
          onEditEntry: (entry) => this.openEntryEditor(entry),
          onOpenSource: (entry) => void this.openSource(entry),
          onOpenExport: () => this.timePoint.openExport(this.selectedDate),
          onLearn: () => new Notice(t("view.learnNotice"), 7_000),
          onDeleteEntry: (entry) => this.deleteEntry(entry),
          getEntrySourcePath: (entry) => this.timePoint.repository.getEntrySourcePath(entry),
          interactionMode: this.interactionMode,
          timelineScale: this.timelineZoom,
        },
      );
      this.syncEditingCardHighlight();
    } catch (error) {
      if (token !== this.loadToken) return;
      this.statusEl.addClass("is-error");
      this.statusEl.setText(error instanceof Error ? error.message : t("view.readFailure"));
      this.timelineHostEl.empty();
      this.currentDay = null;
    }
  }

  openAddEditor(clickedTime?: string): Promise<void> {
    if (this.createEntryPromise) return this.createEntryPromise;
    const operation = this.createAndOpenEntry(clickedTime ?? this.timePoint.getCurrentTime());
    const guardedOperation = operation.finally(() => {
      if (this.createEntryPromise === guardedOperation) this.createEntryPromise = null;
    });
    this.createEntryPromise = guardedOperation;
    return guardedOperation;
  }

  /** Stable hook used by cards and editable embedded `timepoint` blocks. */
  openEntryEditor(entry: TimePointEntry): void {
    void this.openEntryEditorInternal(entry);
  }

  private buildView(): void {
    this.contentEl.empty();
    this.contentEl.addClass("timepoint-view");
    this.contentEl.removeClass("timepoint-appearance-native", "timepoint-appearance-signature");
    this.contentEl.addClass(`timepoint-appearance-${this.timePoint.settings.appearanceMode}`);
    this.shellEl = this.contentEl.createDiv({ cls: "timepoint-shell" });
    const toolbar = this.shellEl.createDiv({ cls: "timepoint-toolbar" });

    const dateCluster = toolbar.createDiv({ cls: "timepoint-date-cluster" });
    const previous = this.iconButton(dateCluster, "chevron-left", t("view.previousDay"));
    previous.addEventListener("click", () => void this.setDate(shiftDate(this.selectedDate, -1)));

    const dateCopy = dateCluster.createDiv({ cls: "timepoint-date-copy" });
    this.dateTitleEl = dateCopy.createEl("h2", { cls: "timepoint-date-title" });
    this.weekdayEl = dateCopy.createDiv({ cls: "timepoint-weekday" });

    const next = this.iconButton(dateCluster, "chevron-right", t("view.nextDay"));
    next.addEventListener("click", () => void this.setDate(shiftDate(this.selectedDate, 1)));

    this.dateInput = dateCluster.createEl("input", {
      cls: "timepoint-date-input",
      attr: { type: "date", "aria-label": t("view.chooseDate") },
    });
    this.dateInput.addEventListener("change", () => void this.setDate(this.dateInput.value));

    const actions = toolbar.createDiv({ cls: "timepoint-action-cluster" });
    const today = actions.createEl("button", {
      cls: "timepoint-button timepoint-today-button",
      text: t("view.today"),
    });
    today.addEventListener("click", () => void this.setDate(this.timePoint.getCurrentDate()));

    this.modeSelect = actions.createEl("select", {
      cls: "timepoint-mode-select dropdown",
      attr: { "aria-label": t("view.layout") },
    });
    addOption(this.modeSelect, "elastic", t("view.elastic"));
    addOption(this.modeSelect, "realtime", t("view.realtime"));
    this.modeSelect.value = this.mode;
    this.modeSelect.addEventListener("change", () => {
      this.mode = this.modeSelect.value as TimelineMode;
      void this.refresh();
    });

    const navigation = actions.createDiv({ cls: "timepoint-navigation-tools" });
    this.panButton = this.iconButton(navigation, "hand", t("view.pan"));
    this.panButton.addClass("timepoint-pan-button");
    this.panButton.addEventListener("click", () => void this.toggleInteractionMode());

    const zoomControls = navigation.createDiv({ cls: "timepoint-zoom-controls" });
    this.zoomOutButton = this.iconButton(zoomControls, "zoom-out", t("view.zoomOut"));
    this.zoomOutButton.addEventListener(
      "click",
      () => void this.setTimelineZoom(stepTimelineZoom(this.timelineZoom, -1)),
    );
    this.zoomResetButton = zoomControls.createEl("button", {
      cls: "timepoint-icon-button timepoint-zoom-reset",
      attr: { type: "button", "aria-label": t("view.zoomReset") },
    });
    this.zoomResetButton.addEventListener("click", () => void this.setTimelineZoom(1));
    this.zoomInButton = this.iconButton(zoomControls, "zoom-in", t("view.zoomIn"));
    this.zoomInButton.addEventListener(
      "click",
      () => void this.setTimelineZoom(stepTimelineZoom(this.timelineZoom, 1)),
    );
    this.updateNavigationControls();

    const add = actions.createEl("button", { cls: "timepoint-button is-accent" });
    setIcon(add.createSpan(), "plus");
    add.createSpan({ cls: "timepoint-button-label", text: t("view.add") });
    add.setAttr("aria-label", t("view.addAria"));
    add.addEventListener("click", () => void this.openAddEditor());

    const exportButton = actions.createEl("button", {
      cls: "timepoint-button timepoint-export-button",
      attr: { type: "button", "aria-label": t("view.exportAria") },
    });
    setIcon(exportButton.createSpan(), "share");
    exportButton.createSpan({ cls: "timepoint-button-label", text: t("view.export") });
    exportButton.addEventListener("click", () => this.timePoint.openExport(this.selectedDate));

    const more = this.iconButton(actions, "ellipsis", t("view.more"));
    more.addEventListener("click", (event) => this.showActionsMenu(event));

    this.scrollEl = this.shellEl.createDiv({ cls: "timepoint-content-scroll" });
    this.statusEl = this.scrollEl.createDiv({ cls: "timepoint-view-status" });
    this.timelineHostEl = this.scrollEl.createDiv();
    this.updateDateHeader();
  }

  private iconButton(container: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "timepoint-icon-button",
      attr: { type: "button", "aria-label": label },
    });
    setIcon(button, icon);
    return button;
  }

  private async toggleInteractionMode(): Promise<void> {
    this.interactionMode = this.interactionMode === "pan" ? "select" : "pan";
    this.updateNavigationControls();
    await this.refresh();
  }

  private async setTimelineZoom(nextZoom: number): Promise<void> {
    const normalized = normalizeTimelineZoom(nextZoom);
    if (normalized === this.timelineZoom) return;
    const previousScrollTop = this.scrollEl.scrollTop;
    const previousScrollHeight = this.scrollEl.scrollHeight;
    const previousClientHeight = this.scrollEl.clientHeight;
    this.timelineZoom = normalized;
    this.updateNavigationControls();
    await this.refresh();
    await nextFrame();
    this.scrollEl.scrollTop = resolveZoomedScrollTop(
      previousScrollTop,
      previousScrollHeight,
      previousClientHeight,
      this.scrollEl.scrollHeight,
      this.scrollEl.clientHeight,
    );
  }

  private updateNavigationControls(): void {
    const panActive = this.interactionMode === "pan";
    this.panButton?.toggleClass("is-active", panActive);
    this.panButton?.setAttr("aria-pressed", String(panActive));
    this.panButton?.setAttr("aria-label", t(panActive ? "view.panActive" : "view.pan"));
    if (this.zoomResetButton) {
      this.zoomResetButton.setText(`${Math.round(this.timelineZoom * 100)}%`);
      this.zoomResetButton.setAttr("title", t("view.zoomReset"));
    }
    if (this.zoomOutButton) this.zoomOutButton.disabled = this.timelineZoom <= MIN_TIMELINE_ZOOM;
    if (this.zoomInButton) this.zoomInButton.disabled = this.timelineZoom >= MAX_TIMELINE_ZOOM;
  }

  private updateDateHeader(): void {
    const date = new Date(`${this.selectedDate}T00:00:00Z`);
    this.dateTitleEl?.setText(
      new Intl.DateTimeFormat(getLocale(), {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      }).format(date),
    );
    this.weekdayEl?.setText(
      new Intl.DateTimeFormat(getLocale(), { weekday: "long", timeZone: "UTC" }).format(date),
    );
    if (this.dateInput) this.dateInput.value = this.selectedDate;
    if (this.modeSelect) this.modeSelect.value = this.mode;
  }

  private renderDiagnostics(day: ParsedDayFile): void {
    this.statusEl.empty();
    if (day.diagnostics.length === 0) {
      this.statusEl.hide();
      return;
    }
    const errors = day.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const warnings = day.diagnostics.length - errors;
    this.statusEl.show();
    this.statusEl.addClass(errors > 0 ? "is-error" : "is-warning");
    const copy = this.statusEl.createDiv({ cls: "timepoint-diagnostic-copy" });
    copy.createEl("strong", {
      text: t("diagnostic.count", { errors, warnings }),
    });
    copy.createDiv({
      cls: "timepoint-diagnostic-summary",
      text:
        errors > 0
          ? day.canRepair
            ? t("diagnostic.repairSummary")
            : t("diagnostic.blockedSummary")
          : t("diagnostic.warningSummary"),
    });
    const details = copy.createEl("details", { cls: "timepoint-diagnostic-details" });
    details.createEl("summary", { text: t("diagnostic.details") });
    const list = details.createEl("ul");
    for (const diagnostic of day.diagnostics) {
      list.createEl("li", {
        text: `${diagnostic.code}: ${diagnostic.message}${diagnostic.sourcePath ? ` (${diagnostic.sourcePath})` : ""}`,
      });
    }
    const actions = this.statusEl.createDiv({ cls: "timepoint-diagnostic-actions" });
    if (day.storageLayout === "legacy-day" && day.canRepair) {
      this.diagnosticButton(actions, "wrench", t("diagnostic.repair"), () =>
        this.repairCurrentLegacyDay(),
      );
    }
    if (day.storageLayout === "legacy-day" && (errors === 0 || day.canRepair)) {
      this.diagnosticButton(
        actions,
        "folder-tree",
        day.canRepair ? t("diagnostic.repairMigrate") : t("diagnostic.migrate"),
        () => this.migrateCurrentDay(),
      );
    }
    if (day.storageLayout === "legacy-day") {
      this.diagnosticButton(actions, "file-text", t("diagnostic.openLegacy"), () =>
        this.openVaultFile(this.timePoint.repository.getDayPath(this.selectedDate)),
      );
    } else {
      const problemPath = day.diagnostics.find((diagnostic) => diagnostic.sourcePath)?.sourcePath;
      if (problemPath) {
        this.diagnosticButton(actions, "file-warning", t("diagnostic.openProblem"), () =>
          this.openVaultFile(problemPath),
        );
      }
    }
    this.statusEl.setAttr(
      "title",
      day.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"),
    );
  }

  private diagnosticButton(
    container: HTMLElement,
    icon: string,
    label: string,
    action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: "timepoint-button",
      attr: { type: "button" },
    });
    setIcon(button.createSpan(), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => void action());
    return button;
  }

  async repairCurrentLegacyDay(): Promise<void> {
    try {
      const before = await this.timePoint.repository.getLegacyRepairPlan(this.selectedDate);
      if (!before?.canApply) {
        new Notice(t("notice.repairUnavailable"));
        return;
      }
      await this.timePoint.repository.repairLegacyDay(this.selectedDate);
      await this.refresh();
      new Notice(t("notice.repaired", { count: before.changes.length }));
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("notice.legacyUnchanged"));
    }
  }

  async migrateCurrentDay(): Promise<void> {
    try {
      const result = await this.timePoint.repository.migrateLegacyDay(this.selectedDate);
      await this.refresh();
      new Notice(t("notice.migrated", { count: result.migratedEntries }), 7_000);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("notice.migrationStopped"));
    }
  }

  async openCurrentDayIndex(): Promise<void> {
    try {
      const file = await this.timePoint.repository.openOrCreateDayIndex(this.selectedDate);
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("notice.indexFailure"));
    }
  }

  private async openEntryEditorInternal(entry: TimePointEntry): Promise<void> {
    if (entry.date !== this.selectedDate) {
      await this.setDate(entry.date);
      if (this.selectedDate !== entry.date) return;
    }
    await this.openEntryInNativeEditor(entry);
  }

  private syncEditingCardHighlight(): void {
    for (const card of this.timelineHostEl?.querySelectorAll<HTMLElement>(
      ".timepoint-card[data-entry-id]",
    ) ?? []) {
      card.toggleClass("is-being-edited", card.dataset.entryId === this.editingEntryId);
    }
  }

  private async createAndOpenEntry(time: string): Promise<void> {
    const date = this.selectedDate;
    const entry = createTimePointEntry({
      date,
      time,
      timezone: this.configuredTimezone(),
      contentMarkdown: "",
      tags: [],
      source: "manual",
    });
    try {
      await this.timePoint.repository.addEntry(entry);
      await this.refresh();
      if (await this.openEntryInNativeEditor(entry)) {
        new Notice(t("notice.created", { time }), 5_000);
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("notice.createFailure"));
    }
  }

  private async deleteEntry(entry: TimePointEntry): Promise<void> {
    await this.timePoint.repository.deleteEntry(
      entry.date,
      entry.id,
      createEntryMutationExpectation(entry),
    );
    this.timePoint.rememberDeleted(entry);
    await this.refresh();
    const undoCommand = t("command.undoDelete");
    new Notice(t("notice.deleted", { command: undoCommand }));
  }

  private configuredTimezone(): string {
    return this.timePoint.settings.timezoneBehavior === "utc" ? "UTC" : getLocalTimezone();
  }

  private async openSource(entry: TimePointEntry): Promise<void> {
    await this.openEntryInNativeEditor(entry);
  }

  private async openEntryInNativeEditor(entry: TimePointEntry): Promise<boolean> {
    const path = this.timePoint.repository.getEntrySourcePath(entry);
    const legacyPath = this.timePoint.repository.getDayPath(entry.date);
    const isLegacyDay = path === legacyPath;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(t("notice.sourceUnavailable", { path }));
      return false;
    }

    this.editingEntryId = entry.id;
    this.syncEditingCardHighlight();
    try {
      const leaf = this.getOrCreateNativeEditorLeaf();
      await leaf.openFile(file, {
        active: true,
        state: { mode: "source", source: false },
        ...(isLegacyDay ? { eState: { subpath: `#^${entry.id}` } } : {}),
      });
      await leaf.loadIfDeferred();
      await this.app.workspace.revealLeaf(leaf);
      await nextFrame();

      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        throw new Error("Obsidian did not open the TimePoint day as a Markdown editor.");
      }
      this.syncNativeEditorSurface();

      let target: { cursorOffset: number; contentEnd: number } | null;
      if (isLegacyDay) {
        let legacyTarget = locateNativeEditorTarget(view.editor.getValue(), entry.id);
        if (!legacyTarget) {
          throw new Error(`TimePoint could not locate the editable Markdown content in ${path}.`);
        }
        if (legacyTarget.preparation) {
          const position = view.editor.offsetToPos(legacyTarget.preparation.offset);
          view.editor.replaceRange(
            legacyTarget.preparation.text,
            position,
            position,
            "timepoint-editor",
          );
          legacyTarget = locateNativeEditorTarget(view.editor.getValue(), entry.id);
          if (!legacyTarget) {
            throw new Error(`TimePoint could not prepare the empty Markdown block ${entry.id}.`);
          }
        }
        target = legacyTarget;
      } else {
        target = locateStandaloneEditorTarget(view.editor.getValue());
      }
      if (!target) {
        throw new Error(`TimePoint could not locate the editable Markdown content in ${path}.`);
      }

      const cursor = view.editor.offsetToPos(target.cursorOffset);
      const rangeEnd = view.editor.offsetToPos(Math.max(target.cursorOffset, target.contentEnd));
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      await nextFrame();
      view.editor.setCursor(cursor);
      view.editor.scrollIntoView({ from: cursor, to: rangeEnd }, true);
      view.editor.focus();
      return true;
    } catch (error) {
      this.editingEntryId = null;
      this.syncEditingCardHighlight();
      new Notice(
        error instanceof Error
          ? error.message
          : "TimePoint could not open the native Obsidian Markdown editor.",
      );
      return false;
    }
  }

  private getOrCreateNativeEditorLeaf(): WorkspaceLeaf {
    if (this.nativeEditorLeaf && this.isLeafAttached(this.nativeEditorLeaf)) {
      return this.nativeEditorLeaf;
    }

    this.nativeEditorLeaf = Platform.isMobile
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.createLeafBySplit(this.leaf, "vertical", false);
    return this.nativeEditorLeaf;
  }

  private isLeafAttached(target: WorkspaceLeaf): boolean {
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === target) attached = true;
    });
    return attached;
  }

  private syncNativeEditorSurface(): void {
    const leaf = this.nativeEditorLeaf;
    if (!leaf || !this.isLeafAttached(leaf) || !(leaf.view instanceof MarkdownView)) return;
    const filePath = leaf.view.file?.path;
    const storagePrefix = `${this.timePoint.settings.storageFolder.replace(/\/+$/u, "")}/`;
    const isLegacyTimePointDay = Boolean(
      filePath?.startsWith(storagePrefix) &&
      /\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/u.test(filePath),
    );
    leaf.view.containerEl.toggleClass("timepoint-native-editor", isLegacyTimePointDay);
    leaf.view.containerEl.toggleClass("is-legacy-day", isLegacyTimePointDay);
  }

  private removeNativeEditorSurfaceClass(): void {
    if (this.nativeEditorLeaf?.view instanceof MarkdownView) {
      this.nativeEditorLeaf.view.containerEl.removeClass("timepoint-native-editor");
      this.nativeEditorLeaf.view.containerEl.removeClass("is-legacy-day");
    }
  }

  private refreshLeafHeader(): void {
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
    leaf.updateHeader?.();
    this.containerEl
      .querySelector<HTMLElement>(".view-header-title")
      ?.setText(this.getDisplayText());
  }

  private showActionsMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t(this.interactionMode === "pan" ? "view.panActive" : "view.pan"))
        .setIcon("hand")
        .setChecked(this.interactionMode === "pan")
        .onClick(() => void this.toggleInteractionMode()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.zoomOut"))
        .setIcon("zoom-out")
        .setDisabled(this.timelineZoom <= MIN_TIMELINE_ZOOM)
        .onClick(() => void this.setTimelineZoom(stepTimelineZoom(this.timelineZoom, -1))),
    );
    menu.addItem((item) =>
      item
        .setTitle(`${t("view.zoomReset")} (${Math.round(this.timelineZoom * 100)}%)`)
        .setIcon("rotate-ccw")
        .setDisabled(this.timelineZoom === 1)
        .onClick(() => void this.setTimelineZoom(1)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("view.zoomIn"))
        .setIcon("zoom-in")
        .setDisabled(this.timelineZoom >= MAX_TIMELINE_ZOOM)
        .onClick(() => void this.setTimelineZoom(stepTimelineZoom(this.timelineZoom, 1))),
    );
    menu.addSeparator();
    if (this.currentDay?.storageLayout === "entry-files") {
      menu.addItem((item) =>
        item
          .setTitle(t("menu.openIndex"))
          .setIcon("folder-open")
          .onClick(() => void this.openCurrentDayIndex()),
      );
      menu.addItem((item) =>
        item
          .setTitle(t("menu.copyFolder"))
          .setIcon("copy")
          .onClick(
            () =>
              void this.copyText(this.timePoint.repository.getEntryFolderPath(this.selectedDate)),
          ),
      );
      menu.addSeparator();
    } else {
      if (this.currentDay?.canRepair) {
        menu.addItem((item) =>
          item
            .setTitle(t("menu.repair"))
            .setIcon("wrench")
            .onClick(() => void this.repairCurrentLegacyDay()),
        );
      }
      menu.addItem((item) =>
        item
          .setTitle(t("menu.migrate"))
          .setIcon("folder-tree")
          .onClick(() => void this.migrateCurrentDay()),
      );
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle(t("menu.export"))
        .setIcon("share")
        .onClick(() => this.timePoint.openExport(this.selectedDate)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("menu.import"))
        .setIcon("import")
        .onClick(() => this.timePoint.openImport()),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("menu.settings"))
        .setIcon("settings")
        .onClick(() => this.timePoint.openSettings()),
    );
    menu.showAtMouseEvent(event);
  }

  private async openVaultFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(t("notice.sourceUnavailable", { path }));
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private async copyText(value: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      new Notice(t("notice.folderCopied"));
    } catch {
      new Notice(t("notice.copyManual", { value }), 8_000);
    }
  }
}

function addOption(select: HTMLSelectElement, value: string, text: string): void {
  const option = select.createEl("option", { text });
  option.value = value;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}
