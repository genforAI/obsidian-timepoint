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
import type {
  LayoutMutation,
  ParsedDayFile,
  TimePointCardLayout,
  TimePointDayViewState,
  TimePointReferenceCardState,
  TimePointRelationCard,
  TimePointRelationGraph,
  TimePointEntry,
  TimelineViewportState,
} from "../model/types";
import {
  createEntryMutationExpectation,
  createTimePointEntry,
  locateStandaloneEditorTarget,
} from "../storage";
import type { TimelineMode } from "../settings/settings";
import { getLocalTimezone, isValidDateString, shiftDate, todayDateString } from "../utils/time";
import { TimelineRenderer } from "./TimelineRenderer";
import { LayoutHistory, inverseLayoutMutation, redoLayoutMutation } from "./layoutHistory";
import { LatestAsyncQueue } from "./latestAsyncQueue";
import { locateNativeEditorTarget } from "./nativeEditorTarget";
import {
  MAX_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  clampViewportOffset,
  isTimelineZoomWheel,
  normalizeTimelineZoom,
  resolveAnchoredScrollOffset,
  shouldRestoreStoredViewport,
  stepTimelineZoom,
  timelineZoomFromWheel,
  viewportCentreRatio,
  type TimelineInteractionMode,
} from "./timelineNavigation";

export const TIMEPOINT_VIEW_TYPE = "timepoint-view";

interface PendingDayStatePatch {
  modes?: Partial<Record<TimelineMode, TimelineViewportState>>;
  minimapExpanded?: boolean;
  stackOrder?: string[];
  relationsEnabled?: boolean;
  referenceCards?: TimePointDayViewState["referenceCards"];
}

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
  private fitButton: HTMLButtonElement | null = null;
  private nowButton: HTMLButtonElement | null = null;
  private relationsButton: HTMLButtonElement | null = null;
  private selectedEntryId: string | null = null;
  private relationGraph: TimePointRelationGraph | null = null;
  private readonly layoutHistory = new LayoutHistory();
  private viewportContextKey = "";
  private dateInputTimer: number | null = null;
  private dayStateTimer: number | null = null;
  private wheelZoomFrame: number | null = null;
  private pendingWheelZoom: number | null = null;
  private pendingWheelAnchor: { clientX: number; clientY: number } | null = null;
  private wheelZoomRunning = false;
  private zoomAnchorFrame: number | null = null;
  private zoomAnchorVersion = 0;
  private zoomApplyChain: Promise<void> = Promise.resolve();
  private layoutCommitChain: Promise<void> = Promise.resolve();
  private pendingDayStatePatches = new Map<string, PendingDayStatePatch>();
  private loadToken = 0;
  private opened = false;
  private readonly refreshQueue: LatestAsyncQueue<number>;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly timePoint: TimePointPlugin,
  ) {
    super(leaf);
    this.mode = timePoint.settings.defaultTimelineMode;
    this.timelineRenderer = new TimelineRenderer(this.app);
    this.refreshQueue = new LatestAsyncQueue((token) => this.performRefresh(token));
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
    this.scrollEl.addEventListener("scroll", () => this.queueCurrentViewportState(), {
      passive: true,
    });
    this.scrollEl.addEventListener("wheel", (event) => this.handleZoomWheel(event), {
      capture: true,
      passive: false,
    });
    this.contentEl.addEventListener("keydown", (event) => this.handleLayoutHistoryShortcut(event));
    await this.refresh();
  }

  override async onClose(): Promise<void> {
    this.opened = false;
    this.loadToken += 1;
    await this.flushDayStatePatches();
    if (this.dayStateTimer !== null) window.clearTimeout(this.dayStateTimer);
    this.dayStateTimer = null;
    if (this.dateInputTimer !== null) window.clearTimeout(this.dateInputTimer);
    this.dateInputTimer = null;
    if (this.wheelZoomFrame !== null) window.cancelAnimationFrame(this.wheelZoomFrame);
    this.wheelZoomFrame = null;
    this.cancelPendingZoomAnchor();
    this.pendingWheelZoom = null;
    this.pendingWheelAnchor = null;
    // The adjacent Markdown leaf is a real Obsidian note view and remains open
    // when the timeline closes, just like any user-opened Markdown pane.
    this.removeNativeEditorSurfaceClass();
    this.nativeEditorLeaf = null;
    this.contentEl.empty();
  }

  async setDate(date: string): Promise<void> {
    if (this.dateInputTimer !== null) window.clearTimeout(this.dateInputTimer);
    this.dateInputTimer = null;
    if (!isValidDateString(date)) {
      new Notice(t("notice.invalidDate", { date }));
      if (this.dateInput) this.dateInput.value = this.selectedDate;
      return;
    }
    if (date === this.selectedDate) return;
    await this.flushDayStatePatches();
    this.selectedDate = date;
    this.selectedEntryId = null;
    this.viewportContextKey = "";
    this.timePoint.setLastOpenedDate(date);
    this.refreshLeafHeader();
    if (this.opened) await this.refresh();
  }

  private queueDateInputCommit(): void {
    if (this.dateInputTimer !== null) window.clearTimeout(this.dateInputTimer);
    const value = this.dateInput.value;
    this.dateInputTimer = window.setTimeout(() => {
      this.dateInputTimer = null;
      void this.setDate(value);
    }, 200);
  }

  getDate(): string {
    return this.selectedDate;
  }

  async refresh(): Promise<void> {
    if (!this.opened) return;
    const token = ++this.loadToken;
    await this.refreshQueue.request(token);
  }

  private async performRefresh(token: number): Promise<void> {
    if (!this.opened || token !== this.loadToken) return;
    const requestedViewportKey = `${this.selectedDate}:${this.mode}`;
    const preserveInPlace = this.viewportContextKey === requestedViewportKey;
    const previousScrollTop = this.scrollEl.scrollTop;
    const previousScrollLeft = this.scrollEl.scrollLeft;
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
      const viewportKey = `${this.selectedDate}:${this.mode}`;
      const restoreViewport = shouldRestoreStoredViewport(this.viewportContextKey, viewportKey);
      if (restoreViewport) {
        this.timelineZoom = day.viewState?.modes[this.mode].zoom ?? 1;
        this.updateNavigationControls();
      }
      this.relationGraph = day.viewState?.relationsEnabled
        ? await this.timePoint.buildRelationGraph(day.entries, day.viewState)
        : null;
      if (token !== this.loadToken) return;
      this.updateRelationsControl();
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
          dayViewState: day.viewState,
          selectedEntryId: this.selectedEntryId,
          layoutEditable: true,
          onSelectEntry: (entry) => this.selectEntry(entry),
          onCommitLayout: (mutation) => this.commitCardLayout(mutation),
          onStackOrderChange: (stackOrder) => this.persistStackOrder(stackOrder),
          onMinimapExpandedChange: (expanded) => this.persistMinimapState(expanded),
          ...(this.relationGraph ? { relationGraph: this.relationGraph } : {}),
          resolveResourcePath: (path) => {
            const file = this.app.vault.getFileByPath(path);
            return file ? this.app.vault.getResourcePath(file) : "";
          },
          onSelectReference: (id) => this.selectReference(id),
          onReferenceStateChange: (state) => this.persistReferenceState(state),
          onToggleReferenceExpanded: (card, state) => this.toggleReferenceExpanded(card, state),
          onOpenReference: (card) => this.openReference(card),
          onRefreshReferenceSnapshot: (card) => this.refreshReferenceSnapshot(card),
        },
      );
      if (token !== this.loadToken) return;
      if (restoreViewport) {
        await this.restoreStoredViewport(day.viewState?.modes[this.mode]);
        if (token !== this.loadToken) return;
        this.viewportContextKey = viewportKey;
      } else if (preserveInPlace) {
        // Capture before the loading banner and repository read. A concurrent
        // Vault event used to start a second render while the first canvas was
        // empty, making that render capture scrollTop=0 and jump after a drag.
        await nextFrame();
        if (token !== this.loadToken) return;
        this.scrollEl.scrollTop = clampViewportOffset(
          previousScrollTop,
          this.scrollEl.scrollHeight,
          this.scrollEl.clientHeight,
        );
        this.scrollEl.scrollLeft = clampViewportOffset(
          previousScrollLeft,
          this.scrollEl.scrollWidth,
          this.scrollEl.clientWidth,
        );
      }
      this.syncEditingCardHighlight();
      if (this.relationGraph) {
        const graph = this.relationGraph;
        void this.timePoint
          .hydrateExternalRelations(graph, day.entries)
          .then((changed) => {
            if (changed && token === this.loadToken && this.opened) void this.refresh();
          })
          .catch((error: unknown) => {
            new Notice(error instanceof Error ? error.message : t("relations.snapshotFailure"));
          });
      }
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
    this.dateInput.addEventListener("change", () => this.queueDateInputCommit());

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
      this.viewportContextKey = "";
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
    this.fitButton = this.iconButton(navigation, "scan", t("view.fitWindow"));
    this.fitButton.addClass("timepoint-fit-button");
    this.fitButton.addEventListener("click", () => void this.fitTimelineToWindow());
    this.nowButton = this.iconButton(navigation, "locate-fixed", t("view.jumpNow"));
    this.nowButton.addClass("timepoint-now-button");
    this.nowButton.addEventListener("click", () => void this.jumpToNow());
    this.relationsButton = this.iconButton(navigation, "git-fork", t("relations.show"));
    this.relationsButton.addClass("timepoint-relations-button");
    this.relationsButton.addEventListener("click", () => void this.toggleRelations());
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

  private setTimelineZoom(
    nextZoom: number,
    anchor?: { clientX: number; clientY: number },
  ): Promise<void> {
    const operation = this.zoomApplyChain.then(() => this.applyTimelineZoom(nextZoom, anchor));
    this.zoomApplyChain = operation.catch(() => undefined);
    return operation;
  }

  private async applyTimelineZoom(
    nextZoom: number,
    anchor?: { clientX: number; clientY: number },
  ): Promise<void> {
    const zoomStartedAt = performance.now();
    const normalized = normalizeTimelineZoom(nextZoom);
    if (normalized === this.timelineZoom) return;
    const previousScrollTop = this.scrollEl.scrollTop;
    const previousScrollLeft = this.scrollEl.scrollLeft;
    const previousScrollHeight = this.scrollEl.scrollHeight;
    const previousScrollWidth = this.scrollEl.scrollWidth;
    const previousClientHeight = this.scrollEl.clientHeight;
    const previousClientWidth = this.scrollEl.clientWidth;
    const scrollBounds = this.scrollEl.getBoundingClientRect();
    const anchorX = anchor
      ? Math.min(previousClientWidth, Math.max(0, anchor.clientX - scrollBounds.left))
      : previousClientWidth / 2;
    const anchorY = anchor
      ? Math.min(previousClientHeight, Math.max(0, anchor.clientY - scrollBounds.top))
      : previousClientHeight / 2;
    this.timelineZoom = normalized;
    this.updateCurrentViewportState({ zoom: normalized });
    this.updateNavigationControls();
    const reused = await this.timelineRenderer.updateTimelineScale(normalized);
    this.timelineHostEl.dataset.tpZoomReused = String(reused);
    if (!reused) await this.refresh();
    this.cancelPendingZoomAnchor();
    const anchorVersion = ++this.zoomAnchorVersion;
    this.zoomAnchorFrame = window.requestAnimationFrame(() => {
      this.zoomAnchorFrame = null;
      if (!this.opened || anchorVersion !== this.zoomAnchorVersion) return;
      this.scrollEl.scrollTop = resolveAnchoredScrollOffset(
        previousScrollTop,
        previousScrollHeight,
        this.scrollEl.scrollHeight,
        this.scrollEl.clientHeight,
        anchorY,
      );
      this.scrollEl.scrollLeft = resolveAnchoredScrollOffset(
        previousScrollLeft,
        previousScrollWidth,
        this.scrollEl.scrollWidth,
        this.scrollEl.clientWidth,
        anchorX,
      );
      this.queueCurrentViewportState();
      this.timelineHostEl.dataset.tpLastZoomMs = (
        Math.round((performance.now() - zoomStartedAt) * 10) / 10
      ).toFixed(1);
    });
  }

  private cancelPendingZoomAnchor(): void {
    this.zoomAnchorVersion += 1;
    if (this.zoomAnchorFrame !== null) window.cancelAnimationFrame(this.zoomAnchorFrame);
    this.zoomAnchorFrame = null;
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

  private selectEntry(entry: TimePointEntry | null): void {
    this.applyTimelineSelection(entry?.id ?? null, "entry");
  }

  private selectReference(id: string): void {
    this.applyTimelineSelection(id, "reference");
  }

  private applyTimelineSelection(id: string | null, kind: "entry" | "reference"): void {
    this.selectedEntryId = id;
    // Only the previously selected handful of elements receive a class write.
    // Toggling every card at drag start invalidated the full 250-card canvas.
    for (const selected of this.timelineHostEl.querySelectorAll<HTMLElement | SVGElement>(
      ".timepoint-card.is-selected, .timepoint-connector-path.is-selected, .timepoint-relation-path.is-selected",
    )) {
      selected.classList.remove("is-selected");
    }
    if (!id) return;
    const escaped = escapeSelectorValue(id);
    const cardSelector =
      kind === "entry"
        ? `.timepoint-card[data-entry-id="${escaped}"]`
        : `.timepoint-reference-card[data-reference-id="${escaped}"]`;
    this.timelineHostEl.querySelector<HTMLElement>(cardSelector)?.addClass("is-selected");
    if (kind === "entry") {
      this.timelineHostEl
        .querySelector<SVGPathElement>(`.timepoint-connector-path[data-entry-id="${escaped}"]`)
        ?.classList.add("is-selected");
    }
    for (const path of this.timelineHostEl.querySelectorAll<SVGPathElement>(
      `.timepoint-relation-path[data-from-id="${escaped}"], .timepoint-relation-path[data-to-id="${escaped}"]`,
    )) {
      path.classList.add("is-selected");
    }
  }

  private commitCardLayout(mutation: LayoutMutation): Promise<void> {
    const entry = this.currentDay?.entries.find((candidate) => candidate.id === mutation.entryId);
    // Update the renderer's shared entry immediately. A second rapid gesture
    // can use this one as its conflict-safe `before` value while writes remain
    // serialized outside the pointer/render path.
    if (entry) {
      if (mutation.after) entry.cardLayout = mutation.after;
      else delete entry.cardLayout;
    }
    const operation = this.layoutCommitChain.then(async () => {
      try {
        // Pointer-down also persists z-order. Commit it before geometry so a
        // reopened date cannot resurrect an older top card.
        await this.flushDayStatePatches();
        await this.timePoint.repository.updateCardLayout(mutation);
        this.layoutHistory.push(mutation);
        if (mutation.reason === "reset") {
          const reused = await this.timelineRenderer.refreshLayoutGeometry();
          if (!reused) await this.refresh();
        }
      } catch (error) {
        if (entry && cardLayoutsEqual(entry.cardLayout ?? null, mutation.after)) {
          if (mutation.before) entry.cardLayout = mutation.before;
          else delete entry.cardLayout;
        }
        throw error;
      }
    });
    this.layoutCommitChain = operation.catch(() => undefined);
    return operation;
  }

  private persistStackOrder(stackOrder: string[]): void {
    if (!this.currentDay?.viewState) return;
    this.currentDay.viewState = {
      ...this.currentDay.viewState,
      stackOrder: [...stackOrder],
    };
    this.queueDayStatePatch(this.selectedDate, { stackOrder: [...stackOrder] });
  }

  private persistMinimapState(expanded: boolean): void {
    if (!this.currentDay?.viewState) return;
    this.currentDay.viewState = { ...this.currentDay.viewState, minimapExpanded: expanded };
    this.queueDayStatePatch(this.selectedDate, { minimapExpanded: expanded });
  }

  private persistReferenceState(state: TimePointReferenceCardState): void {
    if (!this.currentDay?.viewState) return;
    const referenceCards = {
      ...this.currentDay.viewState.referenceCards,
      [state.id]: { ...state },
    };
    this.currentDay.viewState = { ...this.currentDay.viewState, referenceCards };
    this.queueDayStatePatch(this.selectedDate, { referenceCards });
  }

  private async toggleReferenceExpanded(
    _card: TimePointRelationCard,
    state: TimePointReferenceCardState,
  ): Promise<void> {
    const date = this.selectedDate;
    await this.flushDayStatePatches();
    await this.timePoint.repository.updateDayViewState(date, (current) => ({
      ...current,
      referenceCards: { ...current.referenceCards, [state.id]: { ...state } },
    }));
    if (date === this.selectedDate) await this.refresh();
  }

  private async toggleRelations(): Promise<void> {
    const enabled = !(this.currentDay?.viewState?.relationsEnabled ?? false);
    if (enabled) await this.timePoint.ensureExternalSnapshotConsent();
    await this.flushDayStatePatches();
    await this.timePoint.repository.updateDayViewState(this.selectedDate, (current) => ({
      ...current,
      relationsEnabled: enabled,
    }));
    await this.refresh();
  }

  private updateRelationsControl(): void {
    const enabled = this.currentDay?.viewState?.relationsEnabled === true;
    this.relationsButton?.toggleClass("is-active", enabled);
    this.relationsButton?.setAttr("aria-pressed", String(enabled));
    this.relationsButton?.setAttr("aria-label", t(enabled ? "relations.hide" : "relations.show"));
  }

  private async openReference(card: TimePointRelationCard): Promise<void> {
    if (card.kind === "day-entry" && card.targetDate) {
      await this.setDate(card.targetDate);
      this.selectedEntryId = card.targetEntryId ?? null;
      await this.refresh();
      await nextFrame();
      const target = this.selectedEntryId
        ? this.timelineHostEl.querySelector<HTMLElement>(
            `.timepoint-card[data-entry-id="${escapeSelectorValue(this.selectedEntryId)}"]`,
          )
        : null;
      target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      return;
    }
    await this.app.workspace.openLinkText(card.target, "", true);
  }

  private async refreshReferenceSnapshot(card: TimePointRelationCard): Promise<void> {
    if (!this.currentDay) return;
    try {
      const refreshed = await this.timePoint.refreshExternalSnapshot(card, this.currentDay.entries);
      if (refreshed) {
        new Notice(t("relations.snapshotRefreshed"));
        await this.refresh();
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : t("relations.snapshotFailure"));
    }
  }

  private updateCurrentViewportState(patch: Partial<TimelineViewportState>): void {
    const viewState = this.currentDay?.viewState;
    if (!viewState) return;
    const current = viewState.modes[this.mode];
    viewState.modes[this.mode] = { ...current, ...patch };
  }

  private queueCurrentViewportState(): void {
    if (!this.opened || !this.currentDay?.viewState || !this.scrollEl) return;
    const previous = this.currentDay.viewState.modes[this.mode];
    const viewport: TimelineViewportState = {
      zoom: this.timelineZoom,
      centerX: viewportCentreRatio(
        this.scrollEl.scrollLeft,
        this.scrollEl.scrollWidth,
        this.scrollEl.clientWidth,
      ),
      centerY: viewportCentreRatio(
        this.scrollEl.scrollTop,
        this.scrollEl.scrollHeight,
        this.scrollEl.clientHeight,
      ),
    };
    if (
      previous.zoom === viewport.zoom &&
      Math.abs(previous.centerX - viewport.centerX) < 0.0001 &&
      Math.abs(previous.centerY - viewport.centerY) < 0.0001
    ) {
      return;
    }
    this.currentDay.viewState.modes[this.mode] = viewport;
    this.queueDayStatePatch(this.selectedDate, { modes: { [this.mode]: viewport } });
  }

  private queueDayStatePatch(date: string, patch: PendingDayStatePatch): void {
    const previous = this.pendingDayStatePatches.get(date) ?? {};
    this.pendingDayStatePatches.set(date, {
      ...previous,
      ...patch,
      ...(previous.modes || patch.modes ? { modes: { ...previous.modes, ...patch.modes } } : {}),
      ...(patch.referenceCards ? { referenceCards: { ...patch.referenceCards } } : {}),
    });
    if (this.dayStateTimer !== null) window.clearTimeout(this.dayStateTimer);
    this.dayStateTimer = window.setTimeout(() => {
      this.dayStateTimer = null;
      void this.flushDayStatePatches();
    }, 250);
  }

  private async flushDayStatePatches(): Promise<void> {
    if (this.dayStateTimer !== null) window.clearTimeout(this.dayStateTimer);
    this.dayStateTimer = null;
    const pending = [...this.pendingDayStatePatches.entries()];
    this.pendingDayStatePatches.clear();
    for (const [date, patch] of pending) {
      try {
        await this.timePoint.repository.updateDayViewState(date, (current) => ({
          ...current,
          modes: {
            elastic: patch.modes?.elastic ?? current.modes.elastic,
            realtime: patch.modes?.realtime ?? current.modes.realtime,
          },
          minimapExpanded: patch.minimapExpanded ?? current.minimapExpanded,
          relationsEnabled: patch.relationsEnabled ?? current.relationsEnabled,
          stackOrder: patch.stackOrder ?? current.stackOrder,
          referenceCards: patch.referenceCards ?? current.referenceCards,
        }));
      } catch (error) {
        new Notice(error instanceof Error ? error.message : t("notice.viewStateFailure"));
      }
    }
  }

  private async restoreStoredViewport(viewport: TimelineViewportState | undefined): Promise<void> {
    if (!viewport) return;
    await nextFrame();
    this.scrollEl.scrollLeft = Math.max(
      0,
      viewport.centerX * this.scrollEl.scrollWidth - this.scrollEl.clientWidth / 2,
    );
    this.scrollEl.scrollTop = Math.max(
      0,
      viewport.centerY * this.scrollEl.scrollHeight - this.scrollEl.clientHeight / 2,
    );
  }

  private handleZoomWheel(event: WheelEvent): void {
    if (!isTimelineZoomWheel(event.metaKey, event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const base = this.pendingWheelZoom ?? this.timelineZoom;
    this.pendingWheelZoom = timelineZoomFromWheel(
      base,
      event.deltaY,
      event.deltaMode,
      this.scrollEl.clientHeight,
    );
    this.pendingWheelAnchor = { clientX: event.clientX, clientY: event.clientY };
    this.scheduleWheelZoomFrame();
  }

  /**
   * Keep only the latest wheel target while a geometry pass is running. A
   * high-resolution trackpad can emit several events per frame; serializing
   * every intermediate zoom made the complete canvas visibly repaint many
   * times after the fingers had already stopped.
   */
  private scheduleWheelZoomFrame(): void {
    if (this.wheelZoomFrame !== null || this.wheelZoomRunning || !this.opened) return;
    this.wheelZoomFrame = window.requestAnimationFrame(() => {
      this.wheelZoomFrame = null;
      void this.drainLatestWheelZoom();
    });
  }

  private async drainLatestWheelZoom(): Promise<void> {
    if (this.wheelZoomRunning) return;
    this.wheelZoomRunning = true;
    try {
      while (this.opened && this.pendingWheelZoom !== null) {
        const next = this.pendingWheelZoom;
        const anchor = this.pendingWheelAnchor;
        this.pendingWheelZoom = null;
        this.pendingWheelAnchor = null;
        if (!anchor || next === this.timelineZoom) continue;
        try {
          await this.setTimelineZoom(next, anchor);
        } catch (error) {
          new Notice(error instanceof Error ? error.message : t("notice.viewStateFailure"));
        }
      }
    } finally {
      this.wheelZoomRunning = false;
      if (this.pendingWheelZoom !== null) this.scheduleWheelZoomFrame();
    }
  }

  private async fitTimelineToWindow(): Promise<void> {
    const timeline = this.timelineHostEl.querySelector<HTMLElement>(".timepoint-timeline");
    if (!timeline || timeline.offsetHeight <= 0) return;
    const next = normalizeTimelineZoom(
      this.timelineZoom * ((this.scrollEl.clientHeight * 0.9) / timeline.offsetHeight),
    );
    await this.setTimelineZoom(next);
    this.cancelPendingZoomAnchor();
    this.scrollEl.scrollTop = 0;
    this.queueCurrentViewportState();
  }

  private async jumpToNow(): Promise<void> {
    const today = this.timePoint.getCurrentDate();
    if (this.selectedDate !== today) await this.setDate(today);
    await nextFrame();
    const timeline = this.timelineHostEl.querySelector<HTMLElement>(".timepoint-timeline");
    if (!timeline) return;
    const axisTop = Number.parseFloat(
      getComputedStyle(timeline).getPropertyValue("--tp-axis-top-y"),
    );
    const axisHeight = Number.parseFloat(
      getComputedStyle(timeline).getPropertyValue("--tp-axis-height"),
    );
    const [hour = 0, minute = 0] = this.timePoint.getCurrentTime().split(":").map(Number);
    const minuteOfDay = hour * 60 + minute;
    const target =
      timeline.offsetTop +
      (Number.isFinite(axisTop) ? axisTop : 0) +
      (Number.isFinite(axisHeight) ? axisHeight : timeline.offsetHeight) * (minuteOfDay / 1440);
    this.scrollEl.scrollTop = Math.max(0, target - this.scrollEl.clientHeight / 2);
    this.queueCurrentViewportState();
  }

  private handleLayoutHistoryShortcut(event: KeyboardEvent): void {
    if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    if (isEditingElement(event.target)) return;
    const timeline = this.timelineHostEl.querySelector<HTMLElement>(".timepoint-timeline");
    if (!timeline?.contains(document.activeElement) && event.target !== timeline) return;
    event.preventDefault();
    void (event.shiftKey ? this.redoCardLayout() : this.undoCardLayout());
  }

  private async undoCardLayout(): Promise<void> {
    const history = this.layoutHistory.takeUndo(this.selectedDate);
    if (!history) return;
    const current = this.currentDay?.entries.find((entry) => entry.id === history.entryId);
    if (!current) {
      this.layoutHistory.restoreFailedUndo(history);
      return;
    }
    try {
      await this.timePoint.repository.updateCardLayout(
        inverseLayoutMutation(history, current.cardLayout ?? null),
      );
      if (history.before) current.cardLayout = history.before;
      else delete current.cardLayout;
      const reused = await this.timelineRenderer.refreshLayoutGeometry();
      if (!reused) await this.refresh();
    } catch (error) {
      this.layoutHistory.restoreFailedUndo(history);
      new Notice(error instanceof Error ? error.message : t("notice.layoutFailure"));
    }
  }

  private async redoCardLayout(): Promise<void> {
    const history = this.layoutHistory.takeRedo(this.selectedDate);
    if (!history) return;
    const current = this.currentDay?.entries.find((entry) => entry.id === history.entryId);
    if (!current) {
      this.layoutHistory.restoreFailedRedo(history);
      return;
    }
    try {
      await this.timePoint.repository.updateCardLayout(
        redoLayoutMutation(history, current.cardLayout ?? null),
      );
      if (history.after) current.cardLayout = history.after;
      else delete current.cardLayout;
      const reused = await this.timelineRenderer.refreshLayoutGeometry();
      if (!reused) await this.refresh();
    } catch (error) {
      this.layoutHistory.restoreFailedRedo(history);
      new Notice(error instanceof Error ? error.message : t("notice.layoutFailure"));
    }
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
    menu.addItem((item) =>
      item
        .setTitle(
          t(this.currentDay?.viewState?.relationsEnabled ? "relations.hide" : "relations.show"),
        )
        .setIcon("git-fork")
        .setChecked(this.currentDay?.viewState?.relationsEnabled === true)
        .onClick(() => void this.toggleRelations()),
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

function isEditingElement(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function escapeSelectorValue(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}

function cardLayoutsEqual(
  left: TimePointCardLayout | null,
  right: TimePointCardLayout | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.updatedAt === right.updatedAt
  );
}
