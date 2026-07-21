import { App, Component, MarkdownRenderer, Menu, Modal, Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import {
  calculateTimelineLayout,
  type LaidOutTimelineEntry,
  type TimelineLayoutResult,
} from "../layout";
import type { TimePointEntry } from "../model/types";
import type { TimePointSettings, TimelineMode } from "../settings/settings";
import { serializeStandaloneEntry } from "../storage";
import {
  axisMinuteToTime,
  currentTimeString,
  formatDisplayTime,
  todayDateString,
} from "../utils/time";
import {
  buildStableBlockReference,
  clampTimelineScrollTop,
  resolveInitialTimelineScrollTop,
  resolveCardDisplay,
  resolveTimelineCardMeasuredHeight,
  timelineMeasurementIsUsable,
  timelineMeasurementNeedsReflow,
  type CardDisplayDecision,
} from "./cardDisplay";
import {
  DEFAULT_AXIS_HIT_RADIUS,
  isWithinTimelineAxisHitArea,
  mapTimelineYToStoredTime,
} from "./timelineInteraction";
import { resolveTimelineDensity, type TimelineDensityProfile } from "./timelineDensity";

export interface TimelineRendererCallbacks {
  /** Defaults to true. False keeps review actions but suppresses all mutations. */
  editable?: boolean;
  /** Day-file path used by stable block references when render source differs. */
  blockReferencePath?: string;
  /** Resolve the real note behind each card in entry-file storage. */
  getEntrySourcePath?: (entry: TimePointEntry) => string;
  onCreateAtTime: (time: string) => void | Promise<void>;
  onCreateNow: () => void | Promise<void>;
  onEditEntry: (entry: TimePointEntry) => void;
  onOpenSource: (entry: TimePointEntry) => void;
  onOpenExport?: () => void;
  onLearn?: () => void;
  /** The callback performs the conflict-aware mutation after local confirmation. */
  onDeleteEntry?: (entry: TimePointEntry) => Promise<void> | void;
}

interface RenderSnapshot {
  container: HTMLElement;
  entries: readonly TimePointEntry[];
  mode: TimelineMode;
  sourcePath: string;
  settings: TimePointSettings;
  callbacks: TimelineRendererCallbacks;
}

interface CardRuntimeState {
  entry: TimePointEntry;
  card: HTMLElement;
  markdown: HTMLElement;
  overflowHint: HTMLElement;
  display: CardDisplayDecision;
}

export class TimelineRenderer extends Component {
  private markdownComponents: Component[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private renderToken = 0;
  private snapshot: RenderSnapshot | null = null;
  private resizeTimer: number | null = null;
  private automaticReflowsRemaining = 3;
  private lastContainerWidth = 0;

  constructor(private readonly app: App) {
    super();
  }

  override onunload(): void {
    this.cleanupRenderState();
    this.snapshot = null;
  }

  async render(
    container: HTMLElement,
    entries: readonly TimePointEntry[],
    mode: TimelineMode,
    sourcePath: string,
    settings: TimePointSettings,
    callbacks: TimelineRendererCallbacks,
  ): Promise<void> {
    const preserveScroll = Boolean(
      this.snapshot?.container === container &&
      this.snapshot.sourcePath === sourcePath &&
      this.snapshot.mode === mode,
    );
    this.snapshot = { container, entries, mode, sourcePath, settings, callbacks };
    this.automaticReflowsRemaining = 3;
    await this.renderSnapshot(preserveScroll);
  }

  private async renderSnapshot(preserveScroll = true): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const scrollContainer = findTimelineScrollContainer(snapshot.container);
    const previousScrollTop = preserveScroll ? scrollContainer?.scrollTop : undefined;
    const previousScrollLeft = preserveScroll ? scrollContainer?.scrollLeft : undefined;
    const token = ++this.renderToken;
    this.cleanupRenderState(false);
    const { container, entries, mode, sourcePath, settings, callbacks } = snapshot;
    const editable = callbacks.editable !== false;
    container.empty();

    const timeline = container.createDiv({
      cls: `timepoint-timeline is-${mode}`,
      attr: {
        role: "region",
        "data-mode-label": mode === "elastic" ? t("view.elasticSpacing") : t("view.exactSpacing"),
        "aria-label": `${mode === "elastic" ? "Elastic" : "Real-time"} daily timeline.${editable ? " Click near the day axis to add an event." : " Read-only."}`,
      },
    });
    const density = resolveTimelineDensity(
      entries,
      mode,
      container.clientWidth,
      parseCssPixels(timeline, "--tp-card-start", 124),
    );
    timeline.addClass(`is-density-${density.level}`);
    timeline.setAttr("data-density", density.level);
    const cardLayer = timeline.createDiv({ cls: "timepoint-card-layer" });
    const cards = new Map<string, HTMLElement>();
    const cardStates = new Map<string, CardRuntimeState>();
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));

    const markdownJobs = entries.map(async (entry) => {
      const card = cardLayer.createDiv({
        cls: `timepoint-card is-${settings.cardDisplayMode}-mode`,
        attr: {
          tabindex: "0",
          "data-entry-id": entry.id,
          "aria-label": `TimePoint at ${entry.time}.${editable ? " Double-click to edit in Obsidian." : ""}`,
          ...(editable ? { title: "Double-click to edit this note in Obsidian" } : {}),
        },
      });
      cards.set(entry.id, card);

      const header = card.createDiv({ cls: "timepoint-card-header" });
      const time = header.createDiv({ cls: "timepoint-card-time" });
      setIcon(time.createSpan(), "clock-3");
      time.createSpan({ text: formatDisplayTime(entry.time, settings.timeFormat) });

      const actions = header.createDiv({ cls: "timepoint-card-actions" });
      if (editable) {
        const editButton = actions.createEl("button", {
          cls: "timepoint-card-action timepoint-card-action-edit",
          attr: {
            type: "button",
            "aria-label": `Edit TimePoint at ${entry.time} in Obsidian`,
            title: "Edit in Obsidian",
          },
        });
        setIcon(editButton, "pencil");
        editButton.addEventListener("click", (event) => {
          event.stopPropagation();
          callbacks.onEditEntry(entry);
        });
      }
      const moreButton = actions.createEl("button", {
        cls: "timepoint-card-action timepoint-card-action-more",
        attr: { type: "button", "aria-label": `More actions for TimePoint at ${entry.time}` },
      });
      setIcon(moreButton, "ellipsis");

      if (editable) {
        card.addEventListener("dblclick", (event) => {
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target.closest("a, button, input, textarea, select")
          ) {
            return;
          }
          callbacks.onEditEntry(entry);
        });
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && event.target === card) {
            event.preventDefault();
            callbacks.onEditEntry(entry);
          }
        });
      }

      const markdown = card.createDiv({ cls: "timepoint-markdown markdown-rendered" });
      const entrySourcePath = callbacks.getEntrySourcePath?.(entry) ?? sourcePath;
      const component = new Component();
      component.load();
      this.markdownComponents.push(component);
      try {
        await MarkdownRenderer.render(
          this.app,
          entry.contentMarkdown,
          markdown,
          entrySourcePath,
          component,
        );
      } catch (error) {
        component.unload();
        const componentIndex = this.markdownComponents.indexOf(component);
        if (componentIndex >= 0) this.markdownComponents.splice(componentIndex, 1);
        markdown.empty();
        markdown.addClass("is-error");
        markdown.createEl("p", {
          text:
            error instanceof Error
              ? `This note could not render: ${error.message}`
              : "This note could not render. Its Markdown is unchanged.",
        });
      }
      const state: CardRuntimeState = {
        entry,
        card,
        markdown,
        overflowHint: this.createOverflowHint(card, editable),
        display: { clipped: false, maxHeight: null },
      };
      cardStates.set(entry.id, state);
      this.refreshCardDisplay(state, settings, density);
      moreButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.showCardActions(event, entry, entrySourcePath, callbacks, settings.appearanceMode);
      });
    });

    await Promise.all(markdownJobs);
    await nextFrame();
    if (token !== this.renderToken) return;

    let layout = this.calculateLayout(entries, cards, mode, settings, density);
    // Real-time lane widths can change natural Markdown height and therefore a
    // smart/preview decision. Two bounded measurement passes converge both.
    for (let pass = 0; pass < 2; pass += 1) {
      this.applyRealtimeColumns(timeline, cardLayer, cards, layout, density);
      await nextFrame();
      if (token !== this.renderToken) return;
      for (const state of cardStates.values()) this.refreshCardDisplay(state, settings, density);
      layout = this.calculateLayout(entries, cards, mode, settings, density);
    }
    this.applyRealtimeColumns(timeline, cardLayer, cards, layout, density);
    timeline.style.setProperty("--tp-timeline-height", `${Math.ceil(layout.totalHeight)}px`);
    timeline.style.setProperty("--tp-axis-top-y", `${layout.axisTop}px`);
    timeline.style.setProperty(
      "--tp-axis-height",
      `${Math.max(1, layout.axisBottom - layout.axisTop)}px`,
    );

    this.renderAxisLabels(timeline, layout, settings);
    this.positionCardsAndNodes(timeline, cardLayer, cards, entryById, layout, settings, callbacks);

    if (entries.length === 0) this.renderEmptyState(timeline, callbacks, editable);

    if (editable) this.installAxisInteraction(timeline, layout, settings, callbacks);

    await nextFrame();
    if (token !== this.renderToken) return;
    if (scrollContainer) {
      const targetScrollTop =
        previousScrollTop === undefined
          ? resolveInitialTimelineScrollTop(
              mode,
              layout.entries[0]?.nodeY,
              scrollContainer.scrollHeight,
              scrollContainer.clientHeight,
            )
          : clampTimelineScrollTop(
              previousScrollTop,
              scrollContainer.scrollHeight,
              scrollContainer.clientHeight,
            );
      const targetScrollLeft =
        previousScrollLeft === undefined
          ? 0
          : clampTimelineScrollTop(
              previousScrollLeft,
              scrollContainer.scrollWidth,
              scrollContainer.clientWidth,
            );
      scrollContainer.scrollTop = targetScrollTop;
      scrollContainer.scrollLeft = targetScrollLeft;
      // Reapply after the first painted frame. Obsidian can restore a stale
      // scroll anchor while a mode switch replaces a much wider card layer.
      await nextFrame();
      if (token !== this.renderToken) return;
      scrollContainer.scrollTop = targetScrollTop;
      scrollContainer.scrollLeft = targetScrollLeft;
    }
    this.installResizeObserver(container, cards, layout, token);
  }

  private calculateLayout(
    entries: readonly TimePointEntry[],
    cards: ReadonlyMap<string, HTMLElement>,
    mode: TimelineMode,
    settings: TimePointSettings,
    density: TimelineDensityProfile,
  ): TimelineLayoutResult {
    return calculateTimelineLayout(
      mode,
      entries.map((entry) => ({
        id: entry.id,
        minuteOfDay: entry.minuteOfDay,
        measuredHeight: this.measureCardHeight(cards.get(entry.id), true),
        estimatedHeight: 96,
      })),
      {
        minimumHeight: mode === "elastic" ? settings.timelineBaseHeight : settings.realtimeHeight,
        topPadding: 36,
        bottomPadding: 44,
        cardGap: Math.min(settings.minimumCardGap, density.layoutCardGap),
        defaultEstimatedCardHeight: 96,
        maximumColumns: mode === "realtime" ? density.maximumRealtimeColumns : undefined,
      },
    );
  }

  private renderAxisLabels(
    timeline: HTMLElement,
    layout: TimelineLayoutResult,
    settings: TimePointSettings,
  ): void {
    if (!settings.showTimeLabels) return;
    for (const minute of [0, 360, 720, 1080, 1440]) {
      const label = timeline.createDiv({ cls: "timepoint-time-label" });
      label.style.setProperty("--tp-y", `${layout.timeScale.minuteToY(minute)}px`);
      label.setText(formatDisplayTime(axisMinuteToTime(minute), settings.timeFormat));
    }
  }

  private positionCardsAndNodes(
    timeline: HTMLElement,
    cardLayer: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    entryById: ReadonlyMap<string, TimePointEntry>,
    layout: TimelineLayoutResult,
    settings: TimePointSettings,
    callbacks: TimelineRendererCallbacks,
  ): void {
    const nodeByMinute = new Map<number, HTMLButtonElement>();
    const entriesByMinute = new Map<number, TimePointEntry[]>();
    for (const positioned of layout.entries) {
      const entry = entryById.get(positioned.id);
      if (!entry) continue;
      const entries = entriesByMinute.get(positioned.minuteOfDay) ?? [];
      entries.push(entry);
      entriesByMinute.set(positioned.minuteOfDay, entries);
    }

    const now = new Date();
    const currentTime =
      settings.timezoneBehavior === "utc"
        ? now.toISOString().slice(11, 16)
        : currentTimeString(now);
    const currentDate =
      settings.timezoneBehavior === "utc" ? now.toISOString().slice(0, 10) : todayDateString(now);
    for (const positioned of layout.entries) {
      const entry = entryById.get(positioned.id);
      const card = cards.get(positioned.id);
      if (!entry || !card) continue;
      card.style.setProperty("--tp-card-y", `${positioned.cardY}px`);

      let node = nodeByMinute.get(positioned.minuteOfDay);
      if (!node) {
        const entriesAtMinute = entriesByMinute.get(positioned.minuteOfDay) ?? [entry];
        node = timeline.createEl("button", {
          cls: `timepoint-node${entry.date === currentDate && entry.time === currentTime ? " is-current" : ""}`,
          attr: {
            type: "button",
            "data-minute": String(positioned.minuteOfDay),
            "aria-label": `${entriesAtMinute.length} TimePoint${entriesAtMinute.length === 1 ? "" : "s"} at ${entry.time}`,
          },
        });
        node.style.setProperty("--tp-y", `${positioned.nodeY}px`);
        node.disabled = callbacks.editable === false;
        node.toggleClass("is-readonly", callbacks.editable === false);
        node.addEventListener("click", (event) => {
          event.stopPropagation();
          if (callbacks.editable === false) return;
          if (entriesAtMinute.length === 1) {
            callbacks.onEditEntry(entry);
            return;
          }
          const menu = new Menu();
          for (const sameTimeEntry of entriesAtMinute) {
            menu.addItem((item) =>
              item
                .setTitle(entryMenuTitle(sameTimeEntry))
                .setIcon("pencil")
                .onClick(() => callbacks.onEditEntry(sameTimeEntry)),
            );
          }
          menu.showAtMouseEvent(event);
        });
        nodeByMinute.set(positioned.minuteOfDay, node);

        const badge = timeline.createDiv({ cls: "timepoint-time-badge" });
        badge.style.setProperty("--tp-y", `${positioned.nodeY}px`);
        badge.createSpan({ text: formatDisplayTime(entry.time, settings.timeFormat) });
      }

      if (settings.showConnectors) {
        this.renderConnector(timeline, cardLayer, node, card, positioned);
      }
    }
  }

  private renderConnector(
    timeline: HTMLElement,
    cardLayer: HTMLElement,
    node: HTMLElement,
    card: HTMLElement,
    positioned: LaidOutTimelineEntry,
  ): void {
    const startX = node.offsetLeft + node.offsetWidth / 2 + 4;
    const startY = positioned.nodeY;
    const endX = cardLayer.offsetLeft + card.offsetLeft - 5;
    const endY = positioned.cardY + Math.min(25, positioned.cardHeight / 2);
    const deltaX = Math.max(1, endX - startX);
    const deltaY = endY - startY;
    const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const angle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
    const connector = timeline.createDiv({ cls: "timepoint-connector" });
    connector.style.setProperty("--tp-connector-left", `${startX}px`);
    connector.style.setProperty("--tp-connector-top", `${startY}px`);
    connector.style.setProperty("--tp-connector-width", `${length}px`);
    connector.style.setProperty("--tp-connector-angle", `${angle}deg`);
  }

  private renderEmptyState(
    timeline: HTMLElement,
    callbacks: TimelineRendererCallbacks,
    editable: boolean,
  ): void {
    const empty = timeline.createDiv({ cls: "timepoint-empty" });
    empty.createEl("h3", {
      text: editable ? t("view.emptyTitle") : t("view.emptyReadonlyTitle"),
    });
    empty.createEl("p", {
      text: editable ? t("view.emptyBody") : t("view.emptyReadonlyBody"),
    });
    if (!editable) return;
    const actions = empty.createDiv({ cls: "timepoint-empty-actions" });
    const button = actions.createEl("button", {
      cls: "timepoint-button is-accent",
      text: t("view.emptyAdd"),
    });
    setIcon(button.createSpan({ prepend: true }), "plus");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void Promise.resolve()
        .then(() => callbacks.onCreateNow())
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : t("notice.createFailure"));
        });
    });
    if (callbacks.onLearn) {
      const learn = actions.createEl("button", {
        cls: "timepoint-button",
        text: t("view.emptyLearn"),
      });
      learn.addEventListener("click", (event) => {
        event.stopPropagation();
        callbacks.onLearn?.();
      });
    }
    if (callbacks.onOpenExport) {
      const exportButton = actions.createEl("button", {
        cls: "timepoint-button",
        text: t("view.emptyExport"),
      });
      exportButton.addEventListener("click", (event) => {
        event.stopPropagation();
        callbacks.onOpenExport?.();
      });
    }
  }

  private applyRealtimeColumns(
    timeline: HTMLElement,
    cardLayer: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    layout: TimelineLayoutResult,
    density: TimelineDensityProfile,
  ): void {
    if (layout.mode !== "realtime") {
      timeline.style.removeProperty("--tp-timeline-min-width");
      for (const card of cards.values()) {
        card.style.removeProperty("--tp-column-x");
        card.style.removeProperty("--tp-column-width");
      }
      return;
    }

    const columnCount = Math.max(1, layout.columnCount);
    const gap = density.realtimeColumnGap;
    const cardStart = cardLayer.offsetLeft || parseCssPixels(timeline, "--tp-card-start", 124);
    const viewportWidth = timeline.parentElement?.clientWidth ?? timeline.clientWidth;
    const minimumColumnWidth =
      columnCount > 1
        ? density.minimumRealtimeColumnWidth
        : Math.min(180, density.minimumRealtimeColumnWidth);
    const requiredWidth =
      cardStart + columnCount * minimumColumnWidth + (columnCount - 1) * gap + 16;
    if (requiredWidth > viewportWidth) {
      timeline.style.setProperty("--tp-timeline-min-width", `${requiredWidth}px`);
    } else {
      timeline.style.removeProperty("--tp-timeline-min-width");
    }
    const usableWidth = Math.max(minimumColumnWidth, timeline.clientWidth - cardStart - 16);
    const columnWidth = Math.max(
      minimumColumnWidth,
      (usableWidth - (columnCount - 1) * gap) / columnCount,
    );

    for (const positioned of layout.entries) {
      const card = cards.get(positioned.id);
      if (!card) continue;
      card.style.setProperty("--tp-column-x", `${positioned.column * (columnWidth + gap)}px`);
      card.style.setProperty("--tp-column-width", `${columnWidth}px`);
    }
  }

  private installResizeObserver(
    container: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    layout: TimelineLayoutResult,
    token: number,
  ): void {
    if (typeof ResizeObserver === "undefined") return;
    const expectedHeights = new Map(layout.entries.map((entry) => [entry.id, entry.cardHeight]));
    this.lastContainerWidth = container.clientWidth;
    this.resizeObserver = new ResizeObserver(() => {
      if (token !== this.renderToken) return;
      const measurement = {
        previousContainerWidth: this.lastContainerWidth,
        containerWidth: container.clientWidth,
        cards: [...cards].map(([id, card]) => ({
          expectedHeight: expectedHeights.get(id),
          measuredHeight: this.measureCardHeight(card) ?? 0,
        })),
      };
      if (!timelineMeasurementIsUsable(measurement)) return;
      const containerWidthChanged =
        Math.abs(measurement.containerWidth - measurement.previousContainerWidth) > 2;
      const needsReflow = timelineMeasurementNeedsReflow(measurement);
      if (!needsReflow) {
        // A stable observer delivery ends the previous convergence burst. A
        // later resize/theme/content change receives a fresh bounded run.
        this.automaticReflowsRemaining = 3;
        return;
      }
      if (containerWidthChanged) this.automaticReflowsRemaining = 3;
      if (this.automaticReflowsRemaining <= 0) return;
      this.scheduleAutomaticReflow(container, cards, expectedHeights);
    });
    this.resizeObserver.observe(container);
    for (const card of cards.values()) this.resizeObserver.observe(card);
  }

  private scheduleAutomaticReflow(
    container: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    expectedHeights: ReadonlyMap<string, number>,
  ): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      if (this.automaticReflowsRemaining <= 0) return;
      if (
        !timelineMeasurementNeedsReflow({
          previousContainerWidth: this.lastContainerWidth,
          containerWidth: container.clientWidth,
          cards: [...cards].map(([id, card]) => ({
            expectedHeight: expectedHeights.get(id),
            measuredHeight: this.measureCardHeight(card) ?? 0,
          })),
        })
      ) {
        return;
      }
      this.automaticReflowsRemaining -= 1;
      void this.renderSnapshot();
    }, 80);
  }

  /**
   * Measure both the painted border box and its scroll box. When Markdown
   * extends the latter (notably task lists under some Obsidian themes), grow
   * the card itself so its background, focus ring, and layout reservation all
   * describe the same visible region.
   */
  private measureCardHeight(card: HTMLElement | undefined, stabilize = false): number | undefined {
    if (!card) return undefined;
    const cardBounds = card.getBoundingClientRect();
    const borderBoxHeight = cardBounds.height;
    const borderThickness = Math.max(0, borderBoxHeight - card.clientHeight);
    const cardStyle = window.getComputedStyle(card);
    const bottomInset =
      parseFiniteCssPixels(cardStyle.paddingBottom) +
      parseFiniteCssPixels(cardStyle.borderBottomWidth);
    let paintedContentHeight: number | undefined;
    const clipped = card.hasClass("is-clipped");
    if (!clipped) {
      const markdown = card.querySelector<HTMLElement>(":scope > .timepoint-markdown");
      if (markdown) {
        let paintedBottom = markdown.getBoundingClientRect().bottom;
        for (const element of markdown.querySelectorAll<HTMLElement>("*")) {
          const bounds = element.getBoundingClientRect();
          if (bounds.height > 0 && Number.isFinite(bounds.bottom)) {
            paintedBottom = Math.max(paintedBottom, bounds.bottom);
          }
        }
        paintedContentHeight = paintedBottom - cardBounds.top + bottomInset;
      }
    }
    const measuredHeight = resolveTimelineCardMeasuredHeight(
      borderBoxHeight,
      clipped ? borderBoxHeight : card.scrollHeight + borderThickness,
      paintedContentHeight,
    );
    if (stabilize && measuredHeight !== undefined && measuredHeight > borderBoxHeight + 2) {
      card.style.minHeight = `${Math.ceil(measuredHeight)}px`;
      return Math.max(measuredHeight, card.getBoundingClientRect().height);
    }
    return measuredHeight;
  }

  private applyCardDisplay(
    card: HTMLElement,
    markdown: HTMLElement,
    overflowHint: HTMLElement,
    display: CardDisplayDecision,
  ): void {
    card.toggleClass("is-clipped", display.clipped);
    if (display.clipped) card.style.removeProperty("min-height");
    if (display.maxHeight === null) {
      markdown.style.removeProperty("max-height");
    } else {
      markdown.style.maxHeight = `${display.maxHeight}px`;
    }
    overflowHint.hidden = !display.clipped;
  }

  private refreshCardDisplay(
    state: CardRuntimeState,
    settings: TimePointSettings,
    density: TimelineDensityProfile,
  ): void {
    state.display = resolveCardDisplay({
      mode: settings.cardDisplayMode,
      naturalHeight: state.markdown.scrollHeight,
      smartCollapseHeight: settings.smartCollapseHeight,
      previewHeight: settings.cardPreviewHeight,
      densityLimit: density.previewHeight,
    });
    this.applyCardDisplay(state.card, state.markdown, state.overflowHint, state.display);
  }

  private createOverflowHint(card: HTMLElement, editable: boolean): HTMLElement {
    const hint = card.createDiv({ cls: "timepoint-card-overflow" });
    setIcon(hint.createSpan({ cls: "timepoint-card-overflow-icon" }), "maximize-2");
    hint.createSpan({
      text: editable ? t("view.previewEnds") : t("view.previewEnds").split("·")[0]?.trim(),
    });
    hint.hidden = true;
    return hint;
  }

  private showCardActions(
    event: MouseEvent,
    entry: TimePointEntry,
    sourcePath: string,
    callbacks: TimelineRendererCallbacks,
    appearanceMode: TimePointSettings["appearanceMode"],
  ): void {
    const menu = new Menu();
    if (callbacks.editable !== false) {
      menu.addItem((item) =>
        item
          .setTitle(t("menu.openNote"))
          .setIcon("pencil")
          .onClick(() => callbacks.onEditEntry(entry)),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle(t("menu.openSource"))
        .setIcon("file-text")
        .onClick(() => callbacks.onOpenSource(entry)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("menu.copyLink"))
        .setIcon("copy")
        .onClick(() => void this.copyNoteLink(sourcePath, entry)),
    );
    menu.addItem((item) =>
      item
        .setTitle(t("menu.copyMarkdown"))
        .setIcon("clipboard-copy")
        .onClick(
          () => void this.copyText(serializeStandaloneEntry(entry), t("clipboard.markdownCopied")),
        ),
    );
    if (callbacks.editable !== false) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(t("menu.delete"))
          .setIcon("trash")
          .setDisabled(!callbacks.onDeleteEntry)
          .onClick(() => {
            if (callbacks.onDeleteEntry) {
              new CardDeleteConfirmationModal(
                this.app,
                entry,
                callbacks.onDeleteEntry,
                appearanceMode,
              ).open();
            }
          }),
      );
    }
    menu.showAtMouseEvent(event);
  }

  private async copyNoteLink(sourcePath: string, entry: TimePointEntry): Promise<void> {
    const dayFile = /\/\d{4}-\d{2}-\d{2}\.md$/u.test(sourcePath);
    const reference = dayFile
      ? buildStableBlockReference(sourcePath, entry.id)
      : `[[${sourcePath.replace(/\.md$/iu, "")}]]`;
    await this.copyText(reference, t("clipboard.linkCopied"));
  }

  private async copyText(value: string, successMessage: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      new Notice(successMessage);
    } catch {
      new Notice(t("clipboard.unavailable"), 8_000);
    }
  }

  private installAxisInteraction(
    timeline: HTMLElement,
    layout: TimelineLayoutResult,
    settings: TimePointSettings,
    callbacks: TimelineRendererCallbacks,
  ): void {
    const ghostNode = timeline.createDiv({ cls: "timepoint-ghost-node" });
    const ghostLabel = timeline.createDiv({ cls: "timepoint-ghost-time" });
    ghostNode.hidden = true;
    ghostLabel.hidden = true;
    let highlightedNode: HTMLElement | null = null;
    let createPending = false;

    const clearHighlightedNode = (): void => {
      highlightedNode?.removeClass("is-create-target");
      highlightedNode = null;
    };

    const hideGhost = (): void => {
      ghostNode.hidden = true;
      ghostLabel.hidden = true;
      clearHighlightedNode();
      timeline.removeClass("is-axis-hot");
    };

    const mapPointer = (event: MouseEvent | PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".timepoint-card, .timepoint-node, button, input, textarea, select")
      ) {
        return null;
      }
      const rect = timeline.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const visualY = event.clientY - rect.top;
      const axisX = parseCssPixels(timeline, "--tp-axis-x", 84);
      if (!isWithinTimelineAxisHitArea(pointerX, axisX, DEFAULT_AXIS_HIT_RADIUS)) return null;
      return mapTimelineYToStoredTime(
        visualY,
        layout.axisTop,
        layout.axisBottom,
        (y) => layout.timeScale.yToEntryMinute(y),
        settings.snapMinutes,
      );
    };

    timeline.addEventListener("pointermove", (event) => {
      const pointerTime = mapPointer(event);
      if (!pointerTime) {
        hideGhost();
        return;
      }
      const snappedY = layout.timeScale.minuteToY(pointerTime.minuteOfDay);
      clearHighlightedNode();
      highlightedNode = timeline.querySelector<HTMLElement>(
        `.timepoint-node[data-minute="${pointerTime.minuteOfDay}"]`,
      );
      if (highlightedNode) {
        ghostNode.hidden = true;
        ghostLabel.hidden = true;
        highlightedNode.addClass("is-create-target");
        timeline.addClass("is-axis-hot");
        return;
      }
      ghostNode.style.setProperty("--tp-y", `${snappedY}px`);
      ghostLabel.style.setProperty("--tp-y", `${snappedY}px`);
      ghostLabel.setText(formatDisplayTime(pointerTime.time, settings.timeFormat));
      ghostNode.hidden = false;
      ghostLabel.hidden = false;
      timeline.addClass("is-axis-hot");
    });
    timeline.addEventListener("pointerleave", hideGhost);
    timeline.addEventListener("click", (event) => {
      if (createPending) return;
      const pointerTime = mapPointer(event);
      if (!pointerTime) return;
      event.preventDefault();
      hideGhost();
      createPending = true;
      void Promise.resolve()
        .then(() => callbacks.onCreateAtTime(pointerTime.time))
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : t("notice.createFailure"));
        })
        .finally(() => {
          createPending = false;
        });
    });
  }

  private cleanupRenderState(invalidate = true): void {
    if (invalidate) this.renderToken += 1;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    for (const component of this.markdownComponents) component.unload();
    this.markdownComponents = [];
  }
}

class CardDeleteConfirmationModal extends Modal {
  constructor(
    app: App,
    private readonly entry: TimePointEntry,
    private readonly onConfirm: (entry: TimePointEntry) => Promise<void> | void,
    private readonly appearanceMode: TimePointSettings["appearanceMode"],
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("timepoint-modal", "timepoint-delete-confirmation");
    this.modalEl.addClass(`timepoint-appearance-${this.appearanceMode}`);
    this.contentEl.createEl("h2", { text: t("delete.title") });
    this.contentEl.createEl("p", {
      text: t("delete.body", { time: this.entry.time, id: this.entry.id }),
    });
    const actions = this.contentEl.createDiv({ cls: "timepoint-confirmation-actions" });
    const cancel = actions.createEl("button", {
      text: t("delete.cancel"),
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-warning",
      text: t("delete.confirm"),
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => void this.deleteEntry(confirm));
    confirm.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async deleteEntry(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.onConfirm(this.entry);
      this.close();
    } catch (error) {
      button.disabled = false;
      new Notice(error instanceof Error ? error.message : t("delete.failure"));
    }
  }
}

function parseCssPixels(element: HTMLElement, property: string, fallback: number): number {
  const parsed = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFiniteCssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function entryMenuTitle(entry: TimePointEntry): string {
  const preview = entry.contentMarkdown
    .replace(/^[#>*_`~-]+\s*/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return preview ? preview.slice(0, 72) : entry.id;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function findTimelineScrollContainer(container: HTMLElement): HTMLElement | null {
  return container.closest<HTMLElement>(".timepoint-content-scroll, .timepoint-embedded-scroll");
}
