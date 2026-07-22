import { App, Component, MarkdownRenderer, Menu, Modal, Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import {
  avoidManualCardObstacles,
  calculateTimelineLayout,
  findCardOverlapGroups,
  freezeCardGeometry,
  moveCardRect,
  resizeCardRect,
  resolveStoredCardGeometry,
  routeTimelineConnector,
  type CanvasBounds,
  type CanvasRect,
  type LaidOutTimelineEntry,
  type TimelineLayoutResult,
} from "../layout";
import type {
  CanvasGestureState,
  LayoutMutation,
  ResizeHandle,
  TimePointDayViewState,
  TimePointEntry,
  TimePointReferenceCardState,
  TimePointRelationCard,
  TimePointRelationGraph,
} from "../model/types";
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
import { normalizeTimelineZoom, type TimelineInteractionMode } from "./timelineNavigation";
import {
  advanceCanvasGesture,
  beginCanvasGesture,
  isCardGestureExemptTarget,
  LatestFrameQueue,
  pendingClickAction,
  registerCardActivation,
  shouldOpenCardOnDoubleClick,
  type CardActivationState,
} from "./canvasGesture";
import { TimelineMinimap } from "./TimelineMinimap";
import { RelationLayerRenderer } from "./RelationLayerRenderer";
import {
  resolveRealtimeLaneGeometry,
  resolveTimelineDensity,
  selectVisibleTimelineBadgeMinutes,
  type TimelineDensityProfile,
} from "./timelineDensity";

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
  /** Runtime-only navigation state owned by the containing workspace view. */
  interactionMode?: TimelineInteractionMode;
  timelineScale?: number;
  /** Stored day state is rendered by main and embedded timelines. */
  dayViewState?: TimePointDayViewState;
  selectedEntryId?: string | null;
  /** Layout changes are intentionally exposed only by the main timeline. */
  layoutEditable?: boolean;
  onSelectEntry?: (entry: TimePointEntry | null) => void;
  onCommitLayout?: (mutation: LayoutMutation) => Promise<void> | void;
  onStackOrderChange?: (stackOrder: string[]) => void;
  onMinimapExpandedChange?: (expanded: boolean) => void;
  relationGraph?: TimePointRelationGraph;
  resolveResourcePath?: (path: string) => string;
  onSelectReference?: (id: string) => void;
  onReferenceStateChange?: (state: TimePointReferenceCardState) => void | Promise<void>;
  onToggleReferenceExpanded?: (
    card: TimePointRelationCard,
    state: TimePointReferenceCardState,
  ) => void | Promise<void>;
  onOpenReference?: (card: TimePointRelationCard) => void | Promise<void>;
  onRefreshReferenceSnapshot?: (card: TimePointRelationCard) => void | Promise<void>;
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
  geometry?: CanvasRect;
  measuredHeight?: number;
}

interface ResolvedCardGeometries {
  bounds: CanvasBounds;
  geometries: Map<string, CanvasRect>;
  positioned: ReadonlyMap<string, LaidOutTimelineEntry>;
}

interface CardGeometryContext extends ResolvedCardGeometries {
  connectorSvg: SVGSVGElement;
  connectorPaths: Map<string, SVGPathElement>;
  connectorAnchors: Map<string, ConnectorAnchor>;
  nodes: ReadonlyMap<number, HTMLButtonElement>;
}

interface TimelineInteractionGeometry {
  layout: TimelineLayoutResult;
  context: CardGeometryContext;
  timelineScale: number;
}

interface TimelineScaleRuntime {
  timeline: HTMLElement;
  cardLayer: HTMLElement;
  connectorSvg: SVGSVGElement;
  cards: Map<string, HTMLElement>;
  cardStates: Map<string, CardRuntimeState>;
  entries: readonly TimePointEntry[];
  entryById: ReadonlyMap<string, TimePointEntry>;
  mode: TimelineMode;
  settings: TimePointSettings;
  callbacks: TimelineRendererCallbacks;
  density: TimelineDensityProfile;
  interaction: TimelineInteractionGeometry;
}

interface ConnectorAnchor {
  startX: number;
  startY: number;
  corridorX: number;
  cardLayerX: number;
  portIndex: number;
}

interface GestureConnector {
  path: SVGPathElement;
  anchor: ConnectorAnchor;
  obstacles: readonly CanvasRect[];
}

export class TimelineRenderer extends Component {
  private markdownComponents: Component[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private resizeExpectedHeights: Map<string, number> | null = null;
  private renderToken = 0;
  private snapshot: RenderSnapshot | null = null;
  private resizeTimer: number | null = null;
  private automaticReflowsRemaining = 3;
  private lastContainerWidth = 0;
  private minimap: TimelineMinimap | null = null;
  private relationLayer: RelationLayerRenderer | null = null;
  private gestureFrames: LatestFrameQueue<CanvasRect> | null = null;
  private connectorSettleTimer: number | null = null;
  private connectorSettleFrame: number | null = null;
  private connectorScrollFrame: number | null = null;
  private connectorScrollContainer: HTMLElement | null = null;
  private readonly overlapBadgeHandlers = new WeakMap<
    HTMLButtonElement,
    (event: MouseEvent) => void
  >();
  private scaleRuntime: TimelineScaleRuntime | null = null;
  private fullRenderCount = 0;
  private geometryReflowCount = 0;

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

  /**
   * Reflow the existing canvas for zoom/container geometry without replacing
   * any rendered Markdown. Keeping the card nodes mounted preserves paint,
   * focus, selection, image decode state, and Obsidian renderer components.
   */
  async updateTimelineScale(nextScale: number): Promise<boolean> {
    const scale = normalizeTimelineZoom(nextScale);
    if (this.snapshot) this.snapshot.callbacks.timelineScale = scale;
    return this.reflowExistingGeometry(scale);
  }

  /** Reflow only geometry after the independent vertical day scale changes. */
  async updateVerticalScale(): Promise<boolean> {
    const scale = this.scaleRuntime?.interaction.timelineScale;
    if (scale === undefined) return false;
    return this.reflowExistingGeometry(scale);
  }

  /** Reconcile persisted card geometry without replacing mounted Markdown. */
  async refreshLayoutGeometry(): Promise<boolean> {
    const scale = this.scaleRuntime?.interaction.timelineScale;
    return scale === undefined ? false : this.reflowExistingGeometry(scale, false, true);
  }

  private async reflowExistingGeometry(
    scale: number,
    containerGeometryChanged = false,
    reconcileOverlaps = containerGeometryChanged,
  ): Promise<boolean> {
    const reflowStartedAt = performance.now();
    let geometryMark = reflowStartedAt;
    const geometryProfile: Record<string, number> = {};
    const markGeometryStage = (stage: string): void => {
      const now = performance.now();
      geometryProfile[stage] = Math.round((now - geometryMark) * 10) / 10;
      geometryMark = now;
    };
    const runtime = this.scaleRuntime;
    if (!runtime || !runtime.timeline.isConnected) {
      if (this.snapshot) {
        this.snapshot.container.dataset.tpGeometryResult = runtime ? "disconnected" : "missing";
      }
      return false;
    }
    this.geometryReflowCount += 1;
    if (this.snapshot) {
      this.snapshot.container.dataset.tpLastRenderPath = "geometry";
      this.snapshot.container.dataset.tpGeometryReflowCount = String(this.geometryReflowCount);
      this.snapshot.container.dataset.tpGeometryResult = "running";
    }
    const token = this.renderToken;
    const preserveResizeObservation = runtime.mode === "elastic" && this.resizeObserver !== null;
    if (!preserveResizeObservation) this.stopResizeObservation();
    runtime.interaction.timelineScale = scale;
    // Read stable canvas dimensions before any style mutation. Reading them
    // after 250 card positions change forces a second full synchronous layout.
    const timelineClientWidth = Math.max(1, runtime.timeline.clientWidth);
    const timelineCanvasWidth = Math.max(timelineClientWidth, runtime.timeline.scrollWidth);
    const scrollContainer = findTimelineScrollContainer(runtime.timeline);
    const connectorViewport = scrollContainer
      ? {
          top: scrollContainer.scrollTop - runtime.timeline.offsetTop,
          bottom:
            scrollContainer.scrollTop - runtime.timeline.offsetTop + scrollContainer.clientHeight,
        }
      : undefined;
    const cardLayerClientWidth = containerGeometryChanged
      ? Math.max(1, runtime.cardLayer.clientWidth)
      : runtime.interaction.context.bounds.width;
    const firstElasticAutomaticEntry =
      containerGeometryChanged && runtime.mode === "elastic"
        ? runtime.entries.find((entry) => !entry.cardLayout)
        : undefined;
    const elasticAutomaticCardWidth = firstElasticAutomaticEntry
      ? runtime.cards.get(firstElasticAutomaticEntry.id)?.offsetWidth
      : undefined;
    const minimapAxisX = parseCssPixels(runtime.timeline, "--tp-axis-x", 84);
    const cardStart = parseCssPixels(runtime.timeline, "--tp-card-start", 124);
    const minimapCardLayerX = containerGeometryChanged
      ? cardStart
      : (runtime.interaction.context.connectorAnchors.values().next().value?.cardLayerX ??
        cardStart);
    const density = resolveTimelineDensity(
      runtime.entries,
      runtime.mode,
      runtime.timeline.parentElement?.clientWidth ?? runtime.timeline.clientWidth,
      cardStart,
    );
    if (runtime.timeline.dataset.density !== density.level) {
      runtime.timeline.removeClass(
        "is-density-comfortable",
        "is-density-compact",
        "is-density-dense",
      );
      runtime.timeline.addClass(`is-density-${density.level}`);
      runtime.timeline.setAttr("data-density", density.level);
    }
    runtime.density = density;
    const relationCanvasMetrics = this.updateRelationCanvasColumns(
      runtime.timeline,
      runtime.cardLayer,
      runtime.callbacks,
    );
    const effectiveCardLayerWidth = relationCanvasMetrics?.eventLayerWidth ?? cardLayerClientWidth;

    let layout = this.calculateLayout(
      runtime.entries,
      runtime.cards,
      runtime.mode,
      runtime.settings,
      density,
      scale,
      runtime.cardStates,
      true,
    );
    // Real-time lanes can alter wrapping, so they receive one bounded mounted-
    // DOM measurement pass. Elastic resize/zoom reuses cached measurements;
    // its ResizeObserver reports only cards that genuinely changed afterward.
    // Deep-scanning every descendant of 250 cards here caused multi-second
    // width-change stalls and visible global flashing.
    const measurementPasses = runtime.mode === "realtime" ? 1 : 0;
    for (let pass = 0; pass < measurementPasses; pass += 1) {
      this.applyRealtimeColumns(
        runtime.timeline,
        runtime.cardLayer,
        runtime.cards,
        layout,
        density,
        scale,
      );
      await nextFrame();
      if (token !== this.renderToken || this.scaleRuntime !== runtime) {
        if (this.snapshot) this.snapshot.container.dataset.tpGeometryResult = "superseded";
        return false;
      }
      for (const state of runtime.cardStates.values()) {
        this.refreshCardDisplay(state, runtime.settings, density);
      }
      layout = this.calculateLayout(
        runtime.entries,
        runtime.cards,
        runtime.mode,
        runtime.settings,
        density,
        scale,
        runtime.cardStates,
      );
    }
    markGeometryStage("layout");
    this.applyRealtimeColumns(
      runtime.timeline,
      runtime.cardLayer,
      runtime.cards,
      layout,
      density,
      scale,
    );
    setStylePropertyIfChanged(runtime.timeline, "--tp-axis-top-y", `${layout.axisTop}px`);
    setStylePropertyIfChanged(
      runtime.timeline,
      "--tp-axis-height",
      `${Math.max(1, layout.axisBottom - layout.axisTop)}px`,
    );

    const geometry = this.resolveCardGeometries(
      runtime.entries,
      runtime.cards,
      layout,
      runtime.cardLayer,
      scale,
      Math.min(runtime.settings.minimumCardGap, density.layoutCardGap),
      density.level === "dense" ? Math.max(24, density.layoutCardGap * 2) : undefined,
      runtime.mode === "elastic" ? runtime.interaction.context : undefined,
      effectiveCardLayerWidth,
      elasticAutomaticCardWidth,
    );
    markGeometryStage("cardGeometry");
    const geometryBottom = Math.max(
      layout.totalHeight,
      ...[...geometry.geometries.values()].map((rect) => rect.y + rect.height + 44),
    );
    setStylePropertyIfChanged(
      runtime.timeline,
      "--tp-timeline-height",
      `${Math.ceil(geometryBottom)}px`,
    );
    setAttributeIfChanged(
      runtime.connectorSvg,
      "viewBox",
      `0 0 ${timelineClientWidth} ${Math.ceil(geometryBottom)}`,
    );
    for (const label of runtime.timeline.querySelectorAll<HTMLElement>(
      ".timepoint-time-label[data-minute]",
    )) {
      const minute = Number.parseInt(label.dataset.minute ?? "", 10);
      if (Number.isFinite(minute)) {
        setStylePropertyIfChanged(label, "--tp-y", `${layout.timeScale.minuteToY(minute)}px`);
      }
    }
    markGeometryStage("axis");

    const context = this.updateExistingCardsAndNodes(
      runtime,
      layout,
      density,
      geometry,
      !containerGeometryChanged,
      cardStart,
      minimapAxisX,
      connectorViewport,
    );
    markGeometryStage("nodesAndConnectors");
    runtime.interaction.layout = layout;
    runtime.interaction.context = context;
    this.scheduleSettledConnectorRouting(runtime);
    if (reconcileOverlaps) {
      const stackOrder = [...runtime.cards]
        .sort(([, left], [, right]) => cardStackIndex(left) - cardStackIndex(right))
        .map(([id]) => id);
      this.decorateOverlappingCards(
        runtime.entries,
        runtime.cards,
        geometry.geometries,
        stackOrder,
        runtime.callbacks,
      );
    }
    markGeometryStage("overlaps");
    this.relationLayer?.updateScale(
      scale,
      relationCanvasMetrics
        ? {
            left: 0,
            top: layout.axisTop,
            width: relationCanvasMetrics.referenceWidth,
            height: Math.max(1, layout.axisBottom - layout.axisTop),
          }
        : undefined,
      relationCanvasMetrics
        ? {
            eventGeometries: geometry.geometries,
            eventLayerOffsetLeft: cardStart,
            referenceLayerOffsetLeft: relationCanvasMetrics.referenceLeft,
          }
        : undefined,
    );
    markGeometryStage("relations");
    const minimapGeometry = this.buildMinimapGeometry(runtime.interaction, {
      timelineWidth: timelineCanvasWidth,
      timelineHeight: Math.ceil(geometryBottom),
      axisX: minimapAxisX,
      cardLayerX: minimapCardLayerX,
    });
    markGeometryStage("minimapModel");
    this.minimap?.refreshGeometry(minimapGeometry);
    markGeometryStage("minimap");
    if (token !== this.renderToken || this.scaleRuntime !== runtime) {
      if (this.snapshot) this.snapshot.container.dataset.tpGeometryResult = "superseded";
      return false;
    }
    if (!preserveResizeObservation) {
      this.installResizeObserver(
        runtime.timeline.parentElement ?? runtime.timeline,
        runtime.cards,
        layout,
        token,
        true,
      );
    } else {
      this.updateResizeExpectations(layout);
    }
    markGeometryStage("observer");
    if (this.snapshot) {
      this.snapshot.container.dataset.tpGeometryResult = "reused";
      this.snapshot.container.dataset.tpLastGeometryMs = (
        Math.round((performance.now() - reflowStartedAt) * 10) / 10
      ).toFixed(1);
      this.snapshot.container.dataset.tpGeometryProfile = JSON.stringify(geometryProfile);
    }
    return true;
  }

  private async renderSnapshot(preserveScroll = true): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const scrollContainer = findTimelineScrollContainer(snapshot.container);
    const previousScrollTop = preserveScroll ? scrollContainer?.scrollTop : undefined;
    const previousScrollLeft = preserveScroll ? scrollContainer?.scrollLeft : undefined;
    const token = ++this.renderToken;
    this.fullRenderCount += 1;
    snapshot.container.dataset.tpLastRenderPath = "full";
    snapshot.container.dataset.tpFullRenderCount = String(this.fullRenderCount);
    this.cleanupRenderState(false);
    const { container, entries, mode, sourcePath, settings, callbacks } = snapshot;
    const editable = callbacks.editable !== false;
    const interactionMode = callbacks.interactionMode ?? "select";
    const timelineScale = normalizeTimelineZoom(callbacks.timelineScale ?? 1);
    container.empty();

    const timeline = container.createDiv({
      cls: `timepoint-timeline is-${mode}${interactionMode === "pan" ? " is-pan-mode" : ""}`,
      attr: {
        role: "region",
        tabindex: "0",
        "data-mode-label": mode === "elastic" ? t("view.elasticSpacing") : t("view.exactSpacing"),
        "aria-label": t("view.timelineAria", {
          mode: mode === "elastic" ? t("view.elastic") : t("view.realtime"),
          hint:
            interactionMode === "pan"
              ? t("view.timelineHintPan")
              : editable
                ? t("view.timelineHintCreate")
                : t("view.timelineHintReadonly"),
        }),
      },
    });
    const hasRelations = Boolean(callbacks.relationGraph);
    timeline.toggleClass("has-relations", hasRelations);
    const density = resolveTimelineDensity(
      entries,
      mode,
      container.clientWidth,
      parseCssPixels(timeline, "--tp-card-start", 124),
    );
    timeline.addClass(`is-density-${density.level}`);
    timeline.setAttr("data-density", density.level);
    const connectorSvg = createSvg("svg");
    connectorSvg.classList.add("timepoint-connector-layer");
    connectorSvg.setAttribute("aria-hidden", "true");
    timeline.appendChild(connectorSvg);
    const cardLayer = timeline.createDiv({ cls: "timepoint-card-layer" });
    const referenceLayer = hasRelations
      ? timeline.createDiv({ cls: "timepoint-reference-layer" })
      : null;
    const relationCanvasMetrics = this.updateRelationCanvasColumns(timeline, cardLayer, callbacks);
    const cards = new Map<string, HTMLElement>();
    const cardStates = new Map<string, CardRuntimeState>();
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const stackOrder = normalizeStackOrder(
      [
        ...entries.map((entry) => entry.id),
        ...Object.keys(callbacks.dayViewState?.referenceCards ?? {}),
        ...(callbacks.relationGraph?.cards.map((card) => card.id) ?? []),
      ],
      callbacks.dayViewState?.stackOrder ?? [],
    );

    const markdownJobs = entries.map(async (entry) => {
      const card = cardLayer.createDiv({
        cls: `timepoint-card is-${settings.cardDisplayMode}-mode`,
        attr: {
          tabindex: "0",
          "data-entry-id": entry.id,
          "aria-label": t(editable ? "view.cardAriaEditable" : "view.cardAria", {
            time: entry.time,
          }),
          ...(editable ? { title: t("view.cardTitle") } : {}),
        },
      });
      cards.set(entry.id, card);
      card.toggleClass("is-selected", callbacks.selectedEntryId === entry.id);
      card.toggleClass("has-manual-layout", Boolean(entry.cardLayout));
      card.style.setProperty("--tp-card-z", String(6 + stackOrder.indexOf(entry.id)));

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
            "aria-label": t("view.editCard", { time: entry.time }),
            title: t("view.editInObsidian"),
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
        attr: { type: "button", "aria-label": t("view.moreCard", { time: entry.time }) },
      });
      setIcon(moreButton, "ellipsis");
      this.ensureOverlapBadge(actions);

      if (editable) {
        // Opening is driven by two completed pointer activations in the canvas
        // state machine. Keep this listener only to prevent native text-word
        // selection after the second click.
        card.addEventListener("dblclick", (event) => {
          if (!shouldOpenCardOnDoubleClick(false, isCardGestureExemptTarget(event.target))) return;
          event.preventDefault();
          event.stopPropagation();
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
      if (editable && callbacks.layoutEditable && callbacks.onCommitLayout) {
        this.createResizeHandles(card, entry);
      }
      moreButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.showCardActions(event, entry, entrySourcePath, callbacks, settings.appearanceMode);
      });
    });

    await Promise.all(markdownJobs);
    await nextFrame();
    if (token !== this.renderToken) return;

    let layout = this.calculateLayout(
      entries,
      cards,
      mode,
      settings,
      density,
      timelineScale,
      cardStates,
    );
    // Real-time lane widths can change natural Markdown height and therefore a
    // smart/preview decision. Two bounded measurement passes converge both.
    for (let pass = 0; pass < 2; pass += 1) {
      this.applyRealtimeColumns(timeline, cardLayer, cards, layout, density, timelineScale);
      await nextFrame();
      if (token !== this.renderToken) return;
      for (const state of cardStates.values()) this.refreshCardDisplay(state, settings, density);
      layout = this.calculateLayout(
        entries,
        cards,
        mode,
        settings,
        density,
        timelineScale,
        cardStates,
      );
    }
    this.applyRealtimeColumns(timeline, cardLayer, cards, layout, density, timelineScale);
    timeline.style.setProperty("--tp-timeline-height", `${Math.ceil(layout.totalHeight)}px`);
    timeline.style.setProperty("--tp-axis-top-y", `${layout.axisTop}px`);
    timeline.style.setProperty(
      "--tp-axis-height",
      `${Math.max(1, layout.axisBottom - layout.axisTop)}px`,
    );

    const geometry = this.resolveCardGeometries(
      entries,
      cards,
      layout,
      cardLayer,
      timelineScale,
      Math.min(settings.minimumCardGap, density.layoutCardGap),
      density.level === "dense" ? Math.max(24, density.layoutCardGap * 2) : undefined,
    );
    const geometryBottom = Math.max(
      layout.totalHeight,
      ...[...geometry.geometries.values()].map((rect) => rect.y + rect.height + 44),
    );
    timeline.style.setProperty("--tp-timeline-height", `${Math.ceil(geometryBottom)}px`);
    connectorSvg.setAttribute(
      "viewBox",
      `0 0 ${Math.max(1, timeline.clientWidth)} ${Math.ceil(geometryBottom)}`,
    );

    this.renderAxisLabels(timeline, layout, settings);
    const connectorContext = this.positionCardsAndNodes(
      timeline,
      cardLayer,
      cards,
      entryById,
      layout,
      settings,
      density,
      callbacks,
      geometry,
      connectorSvg,
    );
    const interaction: TimelineInteractionGeometry = {
      layout,
      context: connectorContext,
      timelineScale,
    };
    this.scaleRuntime = {
      timeline,
      cardLayer,
      connectorSvg,
      cards,
      cardStates,
      entries,
      entryById,
      mode,
      settings,
      callbacks,
      density,
      interaction,
    };
    this.decorateOverlappingCards(entries, cards, geometry.geometries, stackOrder, callbacks);
    if (
      callbacks.relationGraph &&
      callbacks.dayViewState &&
      callbacks.onSelectReference &&
      callbacks.onReferenceStateChange &&
      callbacks.onToggleReferenceExpanded &&
      callbacks.onOpenReference
    ) {
      this.relationLayer = new RelationLayerRenderer({
        timeline,
        cardLayer: referenceLayer ?? cardLayer,
        graph: callbacks.relationGraph,
        viewState: { ...callbacks.dayViewState, stackOrder },
        timelineScale,
        eventGeometries: connectorContext.geometries,
        eventLayerOffsetLeft:
          connectorContext.connectorAnchors.values().next().value?.cardLayerX ??
          parseCssPixels(timeline, "--tp-card-start", 124),
        ...(relationCanvasMetrics
          ? { referenceLayerOffsetLeft: relationCanvasMetrics.referenceLeft }
          : {}),
        selectedId: callbacks.selectedEntryId,
        editable: Boolean(callbacks.layoutEditable && editable),
        ...(callbacks.resolveResourcePath
          ? { resolveResourcePath: callbacks.resolveResourcePath }
          : {}),
        onSelect: callbacks.onSelectReference,
        onStackOrderChange: (order) => callbacks.onStackOrderChange?.(order),
        onReferenceStateChange: callbacks.onReferenceStateChange,
        onToggleExpanded: callbacks.onToggleReferenceExpanded,
        onOpen: callbacks.onOpenReference,
        onGeometryChanged: () => {
          if (this.scaleRuntime) {
            this.minimap?.refreshGeometry(this.buildMinimapGeometry(this.scaleRuntime.interaction));
          }
        },
        ...(callbacks.onRefreshReferenceSnapshot
          ? { onRefreshSnapshot: callbacks.onRefreshReferenceSnapshot }
          : {}),
      });
      this.relationLayer.mount();
    }

    if (entries.length === 0) this.renderEmptyState(timeline, callbacks, editable);

    if (editable && interactionMode === "select") {
      this.installAxisInteraction(timeline, interaction, settings, callbacks);
    }
    if (scrollContainer) {
      this.installCanvasInteraction(
        timeline,
        scrollContainer,
        interaction,
        settings,
        callbacks,
        entries,
        cards,
        interactionMode,
      );
      this.installConnectorViewportUpdates(scrollContainer);
    }

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
    if (scrollContainer) {
      this.minimap = new TimelineMinimap({
        scrollContainer,
        timeline,
        expanded: callbacks.dayViewState?.minimapExpanded ?? true,
        onExpandedChange: callbacks.onMinimapExpandedChange,
      });
      this.minimap.mount();
    }
    this.installResizeObserver(container, cards, layout, token, true);
  }

  private calculateLayout(
    entries: readonly TimePointEntry[],
    cards: ReadonlyMap<string, HTMLElement>,
    mode: TimelineMode,
    settings: TimePointSettings,
    density: TimelineDensityProfile,
    timelineScale: number,
    cardStates?: ReadonlyMap<string, CardRuntimeState>,
    reuseMeasurements = false,
  ): TimelineLayoutResult {
    const verticalScale = Math.min(
      4,
      Math.max(0.4, this.snapshot?.callbacks.dayViewState?.modes[mode].verticalScale ?? 1),
    );
    return calculateTimelineLayout(
      mode,
      entries.map((entry) => {
        const state = cardStates?.get(entry.id);
        const measuredHeight =
          reuseMeasurements && state?.measuredHeight !== undefined
            ? state.measuredHeight
            : this.measureCardHeight(cards.get(entry.id), true);
        if (state && measuredHeight !== undefined) state.measuredHeight = measuredHeight;
        return {
          id: entry.id,
          minuteOfDay: entry.minuteOfDay,
          manual: Boolean(entry.cardLayout),
          measuredHeight,
          estimatedHeight: 96,
        };
      }),
      {
        minimumHeight:
          (mode === "elastic" ? settings.timelineBaseHeight : settings.realtimeHeight) *
          timelineScale *
          verticalScale,
        topPadding: 36,
        bottomPadding: 44,
        cardGap:
          Math.min(settings.minimumCardGap, density.layoutCardGap) *
          Math.min(2.25, Math.max(0.55, verticalScale)),
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
      const label = timeline.createDiv({
        cls: "timepoint-time-label",
        attr: { "data-minute": String(minute) },
      });
      label.style.setProperty("--tp-y", `${layout.timeScale.minuteToY(minute)}px`);
      label.setText(formatDisplayTime(axisMinuteToTime(minute), settings.timeFormat));
    }
  }

  private resolveCardGeometries(
    entries: readonly TimePointEntry[],
    cards: ReadonlyMap<string, HTMLElement>,
    layout: TimelineLayoutResult,
    cardLayer: HTMLElement,
    timelineScale: number,
    gap: number,
    maximumAutomaticGap: number | undefined,
    previous?: CardGeometryContext,
    boundsWidth?: number,
    automaticCardWidth?: number,
  ): ResolvedCardGeometries {
    const positioned = new Map(layout.entries.map((entry) => [entry.id, entry]));
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const bounds: CanvasBounds = {
      left: 0,
      top: layout.axisTop,
      width: boundsWidth ?? previous?.bounds.width ?? Math.max(1, cardLayer.clientWidth),
      height: Math.max(1, layout.axisBottom - layout.axisTop),
    };
    const geometries = new Map<string, CanvasRect>();
    const manualRects: CanvasRect[] = [];
    const automaticEntries: Array<{ id: string; rect: CanvasRect }> = [];
    for (const entry of entries) {
      const card = cards.get(entry.id);
      const auto = positioned.get(entry.id);
      if (!card || !auto) continue;
      const previousRect = previous?.geometries.get(entry.id);
      const automaticRect: CanvasRect = {
        x: previousRect?.x ?? card.offsetLeft,
        y: auto.cardY,
        width: automaticCardWidth ?? previousRect?.width ?? Math.max(1, card.offsetWidth),
        height: auto.cardHeight,
      };
      if (entry.cardLayout) {
        const resolved = resolveStoredCardGeometry(entry.cardLayout, bounds, timelineScale);
        geometries.set(entry.id, resolved);
        manualRects.push(resolved);
      } else {
        automaticEntries.push({ id: entry.id, rect: automaticRect });
      }
    }
    const avoided = avoidManualCardObstacles(
      automaticEntries.map((item) => item.rect),
      manualRects,
      bounds,
      gap,
      maximumAutomaticGap,
    );
    automaticEntries.forEach((item, index) => {
      geometries.set(item.id, avoided[index] ?? item.rect);
    });
    for (const [id, rect] of geometries) {
      const card = cards.get(id);
      const entry = entryById.get(id);
      if (!card || !entry) continue;
      setStylePropertyIfChanged(card, "--tp-card-y", `${rect.y}px`);
      setStylePropertyIfChanged(card, "--tp-column-x", `${rect.x}px`);
      setStylePropertyIfChanged(card, "--tp-column-width", `${rect.width}px`);
      if (entry.cardLayout) {
        setStylePropertyIfChanged(card, "--tp-card-height", `${rect.height}px`);
      } else {
        removeStylePropertyIfPresent(card, "--tp-card-height");
      }
    }
    return { bounds, geometries, positioned };
  }

  private positionCardsAndNodes(
    timeline: HTMLElement,
    cardLayer: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    entryById: ReadonlyMap<string, TimePointEntry>,
    layout: TimelineLayoutResult,
    settings: TimePointSettings,
    density: TimelineDensityProfile,
    callbacks: TimelineRendererCallbacks,
    geometry: ResolvedCardGeometries,
    connectorSvg: SVGSVGElement,
  ): CardGeometryContext {
    const nodeByMinute = new Map<number, HTMLButtonElement>();
    const entriesByMinute = new Map<number, TimePointEntry[]>();
    const visibleBadgeMinutes = selectVisibleTimelineBadgeMinutes(
      layout.entries,
      density.minimumBadgeSpacing,
    );
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
      let node = nodeByMinute.get(positioned.minuteOfDay);
      if (!node) {
        const entriesAtMinute = entriesByMinute.get(positioned.minuteOfDay) ?? [entry];
        const displayTime = formatDisplayTime(entry.time, settings.timeFormat);
        const showPermanentBadge = visibleBadgeMinutes.has(positioned.minuteOfDay);
        node = timeline.createEl("button", {
          cls: `timepoint-node${entry.date === currentDate && entry.time === currentTime ? " is-current" : ""}`,
          attr: {
            type: "button",
            "data-minute": String(positioned.minuteOfDay),
            "data-time-label": displayTime,
            "aria-label": t("view.nodeGroupAria", {
              count: entriesAtMinute.length,
              time: entry.time,
            }),
          },
        });
        node.style.setProperty("--tp-y", `${positioned.nodeY}px`);
        node.disabled = callbacks.editable === false;
        node.toggleClass("is-readonly", callbacks.editable === false);
        node.toggleClass("is-badge-suppressed", !showPermanentBadge);
        let nodeClickTimer: number | null = null;
        node.addEventListener("click", (event) => {
          event.stopPropagation();
          if (callbacks.editable === false) return;
          if (entriesAtMinute.length === 1) {
            callbacks.onSelectEntry?.(entry);
            return;
          }
          if (nodeClickTimer !== null) window.clearTimeout(nodeClickTimer);
          nodeClickTimer = window.setTimeout(() => {
            nodeClickTimer = null;
            if (!node?.isConnected) return;
            const menu = new Menu();
            for (const sameTimeEntry of entriesAtMinute) {
              menu.addItem((item) =>
                item
                  .setTitle(entryMenuTitle(sameTimeEntry))
                  .setIcon("mouse-pointer-2")
                  .onClick(() => callbacks.onSelectEntry?.(sameTimeEntry)),
              );
            }
            menu.showAtMouseEvent(event);
          }, 230);
        });
        node.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          if (callbacks.editable === false) return;
          if (nodeClickTimer !== null) {
            window.clearTimeout(nodeClickTimer);
            nodeClickTimer = null;
          }
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

        const badge = timeline.createDiv({
          cls: "timepoint-time-badge",
          attr: { "data-minute": String(positioned.minuteOfDay) },
        });
        badge.style.setProperty("--tp-y", `${positioned.nodeY}px`);
        badge.createSpan({ text: displayTime });
        badge.hidden = !showPermanentBadge;
      }
    }
    const connectorPaths = new Map<string, SVGPathElement>();
    const connectorAnchors = new Map<string, ConnectorAnchor>();
    const cardLayerX = cardLayer.offsetLeft;
    if (settings.showConnectors) {
      const minutePortIndex = new Map<number, number>();
      for (const positioned of layout.entries) {
        const entry = entryById.get(positioned.id);
        const node = nodeByMinute.get(positioned.minuteOfDay);
        const cardRect = geometry.geometries.get(positioned.id);
        if (!entry || !node || !cardRect) continue;
        const portIndex = minutePortIndex.get(positioned.minuteOfDay) ?? 0;
        minutePortIndex.set(positioned.minuteOfDay, portIndex + 1);
        const path = createSvg("path");
        path.classList.add("timepoint-connector-path");
        path.dataset.entryId = entry.id;
        path.classList.toggle("is-selected", callbacks.selectedEntryId === entry.id);
        connectorSvg.appendChild(path);
        connectorPaths.set(entry.id, path);
        const anchor: ConnectorAnchor = {
          startX: node.offsetLeft + node.offsetWidth / 2 + 3,
          startY: node.offsetTop + Math.min(10, portIndex * 3) - 5,
          corridorX: Math.max(node.offsetLeft + node.offsetWidth / 2 + 11, cardLayerX - 12),
          cardLayerX,
          portIndex,
        };
        connectorAnchors.set(entry.id, anchor);
        this.updateConnectorPath(path, anchor, cardRect, geometry.geometries, entry.id);
      }
    }
    return {
      ...geometry,
      connectorSvg,
      connectorPaths,
      connectorAnchors,
      nodes: nodeByMinute,
    };
  }

  private updateExistingCardsAndNodes(
    runtime: TimelineScaleRuntime,
    layout: TimelineLayoutResult,
    density: TimelineDensityProfile,
    geometry: ResolvedCardGeometries,
    reuseHorizontalAnchors: boolean,
    cardLayerFallbackX: number,
    axisX: number,
    connectorViewport?: { top: number; bottom: number },
  ): CardGeometryContext {
    const previous = runtime.interaction.context;
    const visibleBadgeMinutes = selectVisibleTimelineBadgeMinutes(
      layout.entries,
      density.minimumBadgeSpacing,
    );
    const nodeYByMinute = new Map<number, number>();
    for (const positioned of layout.entries) {
      if (!nodeYByMinute.has(positioned.minuteOfDay)) {
        nodeYByMinute.set(positioned.minuteOfDay, positioned.nodeY);
      }
    }
    for (const [minute, node] of previous.nodes) {
      const nodeY = nodeYByMinute.get(minute);
      if (nodeY === undefined) continue;
      setStylePropertyIfChanged(node, "--tp-y", `${nodeY}px`);
      node.toggleClass("is-badge-suppressed", !visibleBadgeMinutes.has(minute));
    }
    for (const badge of runtime.timeline.querySelectorAll<HTMLElement>(
      ".timepoint-time-badge[data-minute]",
    )) {
      const minute = Number.parseInt(badge.dataset.minute ?? "", 10);
      const nodeY = nodeYByMinute.get(minute);
      if (nodeY === undefined) continue;
      setStylePropertyIfChanged(badge, "--tp-y", `${nodeY}px`);
      badge.hidden = !visibleBadgeMinutes.has(minute);
    }

    const connectorAnchors = new Map<string, ConnectorAnchor>();
    let immediateConnectorCount = 0;
    const cardLayerX = reuseHorizontalAnchors
      ? (previous.connectorAnchors.values().next().value?.cardLayerX ?? cardLayerFallbackX)
      : cardLayerFallbackX;
    if (runtime.settings.showConnectors) {
      const minutePortIndex = new Map<number, number>();
      for (const positioned of layout.entries) {
        const node = previous.nodes.get(positioned.minuteOfDay);
        const cardRect = geometry.geometries.get(positioned.id);
        const path = previous.connectorPaths.get(positioned.id);
        if (!node || !cardRect || !path) continue;
        const portIndex = minutePortIndex.get(positioned.minuteOfDay) ?? 0;
        minutePortIndex.set(positioned.minuteOfDay, portIndex + 1);
        const previousAnchor = previous.connectorAnchors.get(positioned.id);
        const anchor: ConnectorAnchor =
          reuseHorizontalAnchors && previousAnchor
            ? {
                ...previousAnchor,
                startY: positioned.nodeY + Math.min(10, portIndex * 3) - 5,
                portIndex,
              }
            : {
                // The node centre is axisX + 1px by CSS contract. Avoid
                // offsetLeft/offsetWidth reads after 250 card writes; those
                // reads synchronously laid out the whole canvas.
                startX: axisX + 4,
                startY: positioned.nodeY + Math.min(10, portIndex * 3) - 5,
                corridorX: Math.max(axisX + 12, cardLayerX - 12),
                cardLayerX,
                portIndex,
              };
        connectorAnchors.set(positioned.id, anchor);
        // During zoom/resize use a deterministic corridor path. Full obstacle
        // avoidance is settled once after the gesture burst, not O(n²) for
        // every intermediate wheel value.
        const isNearViewport =
          !connectorViewport ||
          (cardRect.y + cardRect.height >= connectorViewport.top &&
            cardRect.y <= connectorViewport.bottom);
        if (isNearViewport || runtime.callbacks.selectedEntryId === positioned.id) {
          this.updateConnectorPathWithObstacles(path, anchor, cardRect, []);
          immediateConnectorCount += 1;
        }
      }
    }
    if (this.snapshot) {
      this.snapshot.container.dataset.tpImmediateConnectorCount = String(immediateConnectorCount);
    }
    return {
      ...geometry,
      connectorSvg: runtime.connectorSvg,
      connectorPaths: previous.connectorPaths,
      connectorAnchors,
      nodes: previous.nodes,
    };
  }

  private scheduleSettledConnectorRouting(runtime: TimelineScaleRuntime): void {
    this.cancelSettledConnectorRouting();
    this.connectorSettleTimer = window.setTimeout(() => {
      this.connectorSettleTimer = null;
      if (this.scaleRuntime !== runtime || !runtime.timeline.isConnected) return;
      const entryIds = [...runtime.interaction.context.connectorPaths.keys()];
      let cursor = 0;
      let maximumChunkMs = 0;
      let chunkCount = 0;
      const routeChunk = (): void => {
        this.connectorSettleFrame = null;
        if (this.scaleRuntime !== runtime || !runtime.timeline.isConnected) return;
        const startedAt = performance.now();
        const { connectorAnchors, connectorPaths, geometries } = runtime.interaction.context;
        while (cursor < entryIds.length && performance.now() - startedAt < 6) {
          const entryId = entryIds[cursor];
          cursor += 1;
          if (!entryId) continue;
          const path = connectorPaths.get(entryId);
          const anchor = connectorAnchors.get(entryId);
          const rect = geometries.get(entryId);
          if (path && anchor && rect) {
            this.updateConnectorPath(path, anchor, rect, geometries, entryId);
          }
        }
        maximumChunkMs = Math.max(maximumChunkMs, performance.now() - startedAt);
        chunkCount += 1;
        if (cursor < entryIds.length) {
          this.connectorSettleFrame = window.requestAnimationFrame(routeChunk);
        } else if (this.snapshot) {
          this.snapshot.container.dataset.tpConnectorRouting = "settled";
          this.snapshot.container.dataset.tpConnectorChunkMaxMs = maximumChunkMs.toFixed(1);
          this.snapshot.container.dataset.tpConnectorChunkCount = String(chunkCount);
        }
      };
      this.connectorSettleFrame = window.requestAnimationFrame(routeChunk);
    }, 120);
    if (this.snapshot) this.snapshot.container.dataset.tpConnectorRouting = "deferred";
  }

  private cancelSettledConnectorRouting(): void {
    if (this.connectorSettleTimer !== null) window.clearTimeout(this.connectorSettleTimer);
    this.connectorSettleTimer = null;
    if (this.connectorSettleFrame !== null) window.cancelAnimationFrame(this.connectorSettleFrame);
    this.connectorSettleFrame = null;
  }

  private installConnectorViewportUpdates(scrollContainer: HTMLElement): void {
    this.connectorScrollContainer?.removeEventListener("scroll", this.handleConnectorScroll);
    this.connectorScrollContainer = scrollContainer;
    scrollContainer.addEventListener("scroll", this.handleConnectorScroll, { passive: true });
  }

  private readonly handleConnectorScroll = (): void => {
    if (this.connectorScrollFrame !== null) return;
    this.connectorScrollFrame = window.requestAnimationFrame(() => {
      this.connectorScrollFrame = null;
      const runtime = this.scaleRuntime;
      const scroll = this.connectorScrollContainer;
      if (!runtime || !scroll || !runtime.timeline.isConnected) return;
      const visibleTop = scroll.scrollTop - runtime.timeline.offsetTop;
      const visibleBottom = visibleTop + scroll.clientHeight;
      const { connectorAnchors, connectorPaths, geometries } = runtime.interaction.context;
      let refreshed = 0;
      for (const [entryId, rect] of geometries) {
        if (rect.y + rect.height < visibleTop || rect.y > visibleBottom) continue;
        const path = connectorPaths.get(entryId);
        const anchor = connectorAnchors.get(entryId);
        if (!path || !anchor) continue;
        this.updateConnectorPath(path, anchor, rect, geometries, entryId);
        refreshed += 1;
      }
      if (this.snapshot) {
        this.snapshot.container.dataset.tpVisibleConnectorCount = String(refreshed);
      }
    });
  };

  private updateConnectorPath(
    path: SVGPathElement,
    anchor: ConnectorAnchor,
    cardRect: CanvasRect,
    geometries: ReadonlyMap<string, CanvasRect>,
    entryId: string,
  ): void {
    const obstacles = [...geometries]
      .filter(([id]) => id !== entryId)
      .map(([, rect]) => ({ ...rect, x: rect.x + anchor.cardLayerX }));
    this.updateConnectorPathWithObstacles(path, anchor, cardRect, obstacles);
  }

  private decorateOverlappingCards(
    entries: readonly TimePointEntry[],
    cards: ReadonlyMap<string, HTMLElement>,
    geometries: ReadonlyMap<string, CanvasRect>,
    stackOrder: readonly string[],
    callbacks: TimelineRendererCallbacks,
    focusId?: string | null,
  ): void {
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const focusedEntryId = focusId === undefined ? callbacks.selectedEntryId : focusId;
    const groups = findCardOverlapGroups(
      entries.flatMap((entry) => {
        // Automatic cards should normally be collision-free, but include them
        // here as a safety net. During the short interval between pointer-up
        // and persistence, a newly manual card can overlap a still-automatic
        // neighbor; recording the group lets the top card expose a chooser
        // without altering the paint state of every covered peer.
        const rect = geometries.get(entry.id);
        return rect ? [{ id: entry.id, rect }] : [];
      }),
    );
    const desired = new Map<
      string,
      {
        group: string[];
        groupedEntries: TimePointEntry[];
        topId: string | undefined;
        signature: string;
      }
    >();
    for (const group of groups) {
      // Overlap is a contextual affordance, not a canvas-wide decoration.
      // Keeping exactly one selected top presentation avoids turning a single
      // dense-card move into style invalidation across every connected group.
      if (!focusedEntryId || !group.includes(focusedEntryId)) continue;
      const groupedEntries = group
        .map((id) => entryById.get(id))
        .filter((entry): entry is TimePointEntry => Boolean(entry))
        .sort(
          (left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id),
        );
      const topId = focusedEntryId;
      const signature = `${group.join("\u001f")}\u001e${topId ?? ""}`;
      desired.set(focusedEntryId, { group, groupedEntries, topId, signature });
    }

    // Diff the presentation instead of clearing and rebuilding every card.
    // This is important after drag and zoom: unchanged background cards keep
    // their exact paint state, badge node, listener and accessibility object.
    for (const [id, card] of cards) {
      const presentation = desired.get(id);
      const previousSignature = card.dataset.overlapSignature;
      const actions = card.querySelector<HTMLElement>(".timepoint-card-actions");
      if (!actions) continue;
      const badge = this.ensureOverlapBadge(actions);
      if (!presentation) {
        if (
          !previousSignature &&
          !card.hasClass("has-card-overlap") &&
          !card.hasClass("is-overlap-top") &&
          badge.hidden
        ) {
          continue;
        }
        card.removeClass("has-card-overlap", "is-overlap-top", "is-overlap-underlay");
        delete card.dataset.overlapCount;
        delete card.dataset.overlapSignature;
        this.hideOverlapBadge(badge);
        continue;
      }
      const isTop = id === presentation.topId;
      // Covered peers carry no overlap attributes or classes. A dense
      // same-minute group can contain dozens of cards; touching all of them
      // after one move invalidates style across the canvas and can flash even
      // though their visual state is unchanged.
      if (!isTop) {
        if (
          !previousSignature &&
          !card.hasClass("has-card-overlap") &&
          !card.hasClass("is-overlap-top") &&
          badge.hidden
        ) {
          continue;
        }
        card.removeClass("has-card-overlap", "is-overlap-top", "is-overlap-underlay");
        delete card.dataset.overlapCount;
        delete card.dataset.overlapSignature;
        this.hideOverlapBadge(badge);
        continue;
      }
      if (previousSignature === presentation.signature && !badge.hidden) {
        continue;
      }
      // Manual overlap is intentional canvas state. Keep every neighboring
      // card fully painted and interactive; only the top card receives a deck
      // outline and chooser. Clipping/fading all underlays made unrelated
      // Markdown appear to flash when a moved card entered or left a group.
      card.addClass("has-card-overlap", "is-overlap-top");
      card.removeClass("is-overlap-underlay");
      card.dataset.overlapCount = String(presentation.group.length);
      card.dataset.overlapSignature = presentation.signature;
      this.showOverlapBadge(badge, presentation.group.length);
      const previousHandler = this.overlapBadgeHandlers.get(badge);
      if (previousHandler) badge.removeEventListener("click", previousHandler);
      const handler = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu();
        for (const entry of presentation.groupedEntries) {
          menu.addItem((item) =>
            item
              .setTitle(entryMenuTitle(entry))
              .setIcon("file-pen-line")
              .onClick(() => {
                const nextOrder = moveStackItemToEnd(stackOrder, entry.id);
                const maximumZ = Math.max(
                  6,
                  ...presentation.group.map(
                    (candidate) =>
                      Number.parseInt(
                        cards.get(candidate)?.style.getPropertyValue("--tp-card-z") ?? "6",
                        10,
                      ) || 6,
                  ),
                );
                cards.get(entry.id)?.style.setProperty("--tp-card-z", String(maximumZ + 1));
                this.decorateOverlappingCards(
                  entries,
                  cards,
                  geometries,
                  nextOrder,
                  callbacks,
                  entry.id,
                );
                callbacks.onSelectEntry?.(entry);
                callbacks.onStackOrderChange?.(nextOrder);
                callbacks.onEditEntry(entry);
              }),
          );
        }
        menu.showAtMouseEvent(event);
      };
      badge.addEventListener("click", handler);
      this.overlapBadgeHandlers.set(badge, handler);
    }
  }

  private ensureOverlapBadge(actions: HTMLElement): HTMLButtonElement {
    const existing = actions.querySelector<HTMLButtonElement>(".timepoint-card-overlap-badge");
    if (existing) return existing;
    const badge = actions.createEl("button", {
      cls: "timepoint-card-action timepoint-card-overlap-badge",
      text: "+0",
      attr: { type: "button" },
    });
    badge.hidden = true;
    return badge;
  }

  private showOverlapBadge(badge: HTMLButtonElement, count: number): void {
    const label = `+${Math.max(0, count - 1)}`;
    if (badge.firstChild?.nodeType === Node.TEXT_NODE) {
      if (badge.firstChild.nodeValue !== label) badge.firstChild.nodeValue = label;
    } else {
      badge.setText(label);
    }
    badge.setAttr("aria-label", t("view.overlapCount", { count }));
    badge.setAttr("title", t("view.overlapHint", { count }));
    badge.hidden = false;
  }

  private hideOverlapBadge(badge: HTMLButtonElement): void {
    if (!badge.hidden) badge.hidden = true;
    const previousHandler = this.overlapBadgeHandlers.get(badge);
    if (previousHandler) badge.removeEventListener("click", previousHandler);
    this.overlapBadgeHandlers.delete(badge);
  }

  private updateConnectorPathWithObstacles(
    path: SVGPathElement,
    anchor: ConnectorAnchor,
    cardRect: CanvasRect,
    obstacles: readonly CanvasRect[],
  ): void {
    const endX = anchor.cardLayerX + cardRect.x;
    const endY =
      cardRect.y + Math.min(28 + anchor.portIndex * 5, Math.max(18, cardRect.height - 12));
    setAttributeIfChanged(
      path,
      "d",
      routeTimelineConnector({
        startX: anchor.startX,
        startY: anchor.startY,
        endX,
        endY,
        corridorX: anchor.corridorX,
        obstacles,
        clearance: 8,
      }),
    );
    setAttributeIfChanged(path, "vector-effect", "non-scaling-stroke");
  }

  private buildMinimapGeometry(
    interaction: TimelineInteractionGeometry,
    metrics?: {
      timelineWidth: number;
      timelineHeight: number;
      axisX: number;
      cardLayerX: number;
    },
  ) {
    const firstAnchor = interaction.context.connectorAnchors.values().next().value;
    const viewBox = interaction.context.connectorSvg.getAttribute("viewBox")?.split(/\s+/u) ?? [];
    const inlineHeight = Number.parseFloat(
      this.scaleRuntime?.timeline.style.getPropertyValue("--tp-timeline-height") ?? "",
    );
    const timelineWidth = metrics?.timelineWidth ?? (Number.parseFloat(viewBox[2] ?? "") || 1);
    const timelineHeight =
      metrics?.timelineHeight ?? (Number.parseFloat(viewBox[3] ?? "") || inlineHeight || 1);
    const axisX = metrics?.axisX ?? (firstAnchor ? firstAnchor.startX - 3 : 84);
    const cardLayerX = metrics?.cardLayerX ?? firstAnchor?.cardLayerX ?? 124;
    const nodes = new Map<string, { id: string; x: number; y: number }>();
    for (const positioned of interaction.layout.entries) {
      const id = String(positioned.minuteOfDay);
      if (!nodes.has(id)) nodes.set(id, { id, x: axisX, y: positioned.nodeY });
    }
    return {
      timelineWidth,
      timelineHeight,
      nodes: [...nodes.values()],
      cards: [
        ...[...interaction.context.geometries].map(([id, rect]) => ({
          id,
          x: cardLayerX + rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })),
        ...(this.relationLayer?.getMinimapCards() ?? []),
      ],
    };
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

  private updateRelationCanvasColumns(
    timeline: HTMLElement,
    cardLayer: HTMLElement,
    callbacks: TimelineRendererCallbacks,
  ): { eventLayerWidth: number; referenceLeft: number; referenceWidth: number } | null {
    if (!callbacks.relationGraph) {
      removeStylePropertyIfPresent(timeline, "--tp-relation-min-width");
      removeStylePropertyIfPresent(timeline, "--tp-reference-left");
      removeStylePropertyIfPresent(cardLayer, "--tp-event-layer-width");
      return null;
    }
    const cardStart = parseCssPixels(timeline, "--tp-card-start", 124);
    const containerWidth = timeline.parentElement?.clientWidth ?? timeline.clientWidth;
    const baseTimelineWidth = Math.max(310, (containerWidth || 900) - 32);
    const eventLayerWidth = Math.max(180, baseTimelineWidth - cardStart - 16);
    const referenceWidth = Math.min(560, Math.max(320, baseTimelineWidth * 0.42));
    const referenceLeft = Math.ceil(cardStart + eventLayerWidth + 24);
    setStylePropertyIfChanged(
      timeline,
      "--tp-relation-min-width",
      `${Math.ceil(baseTimelineWidth + referenceWidth + 24)}px`,
    );
    setStylePropertyIfChanged(cardLayer, "--tp-event-layer-width", `${eventLayerWidth}px`);
    setStylePropertyIfChanged(timeline, "--tp-reference-left", `${referenceLeft}px`);
    return { eventLayerWidth, referenceLeft, referenceWidth };
  }

  private applyRealtimeColumns(
    timeline: HTMLElement,
    cardLayer: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    layout: TimelineLayoutResult,
    density: TimelineDensityProfile,
    timelineScale: number,
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
    const cardStart = cardLayer.offsetLeft || parseCssPixels(timeline, "--tp-card-start", 124);
    const viewportWidth = timeline.parentElement?.clientWidth ?? timeline.clientWidth;
    const { gap, minimumColumnWidth, requiredWidth } = resolveRealtimeLaneGeometry(
      density,
      columnCount,
      cardStart,
      timelineScale,
    );
    if (requiredWidth > viewportWidth) {
      timeline.style.setProperty("--tp-timeline-min-width", `${requiredWidth}px`);
    } else {
      timeline.style.removeProperty("--tp-timeline-min-width");
    }
    const usableWidth = Math.max(minimumColumnWidth, cardLayer.clientWidth - 16);
    const columnWidth = Math.max(
      minimumColumnWidth,
      (usableWidth - (columnCount - 1) * gap) / columnCount,
    );

    for (const positioned of layout.entries) {
      const card = cards.get(positioned.id);
      if (!card) continue;
      setStylePropertyIfChanged(
        card,
        "--tp-column-x",
        `${positioned.column * (columnWidth + gap)}px`,
      );
      setStylePropertyIfChanged(card, "--tp-column-width", `${columnWidth}px`);
    }
  }

  private installResizeObserver(
    container: HTMLElement,
    cards: ReadonlyMap<string, HTMLElement>,
    layout: TimelineLayoutResult,
    token: number,
    ignoreInitialDelivery = false,
  ): void {
    if (typeof ResizeObserver === "undefined") return;
    const expectedHeights = new Map(layout.entries.map((entry) => [entry.id, entry.cardHeight]));
    this.resizeExpectedHeights = expectedHeights;
    this.lastContainerWidth = container.clientWidth;
    let skipNextDelivery = ignoreInitialDelivery;
    const cardIdByElement = new Map<HTMLElement, string>(
      [...cards].map(([id, card]) => [card, id]),
    );
    this.resizeObserver = new ResizeObserver((observedEntries) => {
      if (token !== this.renderToken) return;
      if (skipNextDelivery) {
        skipNextDelivery = false;
        this.lastContainerWidth = container.clientWidth;
      }
      const containerWidth = container.clientWidth;
      if (!Number.isFinite(containerWidth) || containerWidth <= 2) return;
      const containerWidthChanged = Math.abs(containerWidth - this.lastContainerWidth) > 2;
      const changedCards = observedEntries.flatMap((observed) => {
        if (!observed.target.instanceOf(HTMLElement) || observed.target === container) return [];
        const id = cardIdByElement.get(observed.target);
        if (!id || observed.target.hasClass("has-manual-layout")) return [];
        const borderBox = observed.borderBoxSize[0]?.blockSize;
        const measuredHeight =
          borderBox && borderBox > 2
            ? borderBox
            : (this.measureCardHeight(observed.target) ?? observed.contentRect.height);
        const state = this.scaleRuntime?.cardStates.get(id);
        if (state && Number.isFinite(measuredHeight) && measuredHeight > 2) {
          state.measuredHeight = measuredHeight;
        }
        return [{ expectedHeight: expectedHeights.get(id), measuredHeight }];
      });
      if (containerWidthChanged) {
        this.lastContainerWidth = containerWidth;
        this.automaticReflowsRemaining = 3;
        this.scheduleAutomaticReflow();
        return;
      }
      const measurement = {
        previousContainerWidth: this.lastContainerWidth,
        containerWidth,
        cards: changedCards,
      };
      if (!timelineMeasurementIsUsable(measurement)) return;
      const needsReflow = timelineMeasurementNeedsReflow(measurement);
      if (!needsReflow) {
        // A stable observer delivery ends the previous convergence burst. A
        // later resize/theme/content change receives a fresh bounded run.
        this.automaticReflowsRemaining = 3;
        return;
      }
      if (this.automaticReflowsRemaining <= 0) return;
      this.scheduleAutomaticReflow();
    });
    this.resizeObserver.observe(container);
    for (const card of cards.values()) {
      if (!card.hasClass("has-manual-layout")) this.resizeObserver.observe(card);
    }
  }

  private stopResizeObservation(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.resizeExpectedHeights = null;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
  }

  private updateResizeExpectations(layout: TimelineLayoutResult): void {
    const expected = this.resizeExpectedHeights;
    if (!expected) return;
    expected.clear();
    for (const entry of layout.entries) expected.set(entry.id, entry.cardHeight);
  }

  private scheduleAutomaticReflow(): void {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      if (this.automaticReflowsRemaining <= 0) return;
      this.automaticReflowsRemaining -= 1;
      const scale = this.scaleRuntime?.interaction.timelineScale;
      if (scale === undefined) {
        void this.renderSnapshot();
        return;
      }
      void this.reflowExistingGeometry(scale, true).then((reused) => {
        if (!reused && this.snapshot) void this.renderSnapshot();
      });
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
      card.style.setProperty("--tp-card-min-height", `${Math.ceil(measuredHeight)}px`);
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
    if (display.clipped) card.style.removeProperty("--tp-card-min-height");
    if (display.maxHeight === null) {
      markdown.style.removeProperty("--tp-markdown-max-height");
    } else {
      markdown.style.setProperty("--tp-markdown-max-height", `${display.maxHeight}px`);
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

  private createOverflowHint(_card: HTMLElement, _editable: boolean): HTMLElement {
    // Clipping is communicated only by the theme-aware gradient. Repeating a
    // label on every dense card makes the canvas noisier than the content.
    const hint = createSpan();
    hint.hidden = true;
    return hint;
  }

  private createResizeHandles(card: HTMLElement, entry: TimePointEntry): void {
    const handles: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
    for (const handle of handles) {
      card.createDiv({
        cls: `timepoint-resize-handle is-${handle}`,
        attr: {
          role: "separator",
          "data-resize-handle": handle,
          "data-entry-id": entry.id,
          "aria-label": t("view.resizeCard", { handle }),
        },
      });
    }
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
      if (entry.cardLayout && callbacks.layoutEditable && callbacks.onCommitLayout) {
        menu.addItem((item) =>
          item
            .setTitle(t("menu.resetCardLayout"))
            .setIcon("rotate-ccw")
            .onClick(
              () =>
                void Promise.resolve(
                  callbacks.onCommitLayout?.({
                    date: entry.date,
                    entryId: entry.id,
                    before: entry.cardLayout ?? null,
                    after: null,
                    reason: "reset",
                  }),
                ),
            ),
        );
      }
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
    interaction: TimelineInteractionGeometry,
    settings: TimePointSettings,
    callbacks: TimelineRendererCallbacks,
  ): void {
    const ghostNode = timeline.createDiv({ cls: "timepoint-ghost-node" });
    const ghostLabel = timeline.createDiv({ cls: "timepoint-ghost-time" });
    ghostNode.hidden = true;
    ghostLabel.hidden = true;
    let highlightedNode: HTMLElement | null = null;

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
        interaction.layout.axisTop,
        interaction.layout.axisBottom,
        (y) => interaction.layout.timeScale.yToEntryMinute(y),
        settings.snapMinutes,
      );
    };

    timeline.addEventListener("pointermove", (event) => {
      const pointerTime = mapPointer(event);
      if (!pointerTime) {
        hideGhost();
        return;
      }
      const snappedY = interaction.layout.timeScale.minuteToY(pointerTime.minuteOfDay);
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
  }

  private installCanvasInteraction(
    timeline: HTMLElement,
    scrollContainer: HTMLElement,
    interaction: TimelineInteractionGeometry,
    settings: TimePointSettings,
    callbacks: TimelineRendererCallbacks,
    entries: readonly TimePointEntry[],
    cards: ReadonlyMap<string, HTMLElement>,
    interactionMode: TimelineInteractionMode,
  ): void {
    let gesture: CanvasGestureState = { kind: "idle" };
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let startRect: CanvasRect | null = null;
    let workingRect: CanvasRect | null = null;
    let activeEntry: TimePointEntry | null = null;
    let activeConnector: GestureConnector | null = null;
    let spaceHeld = false;
    let suppressNextClick = false;
    let suppressClickUntil = 0;
    let cardActivation: CardActivationState | null = null;
    let gestureBounds: CanvasBounds | null = null;
    let gestureScale = interaction.timelineScale;
    let runtimeStackOrder = normalizeStackOrder(
      [
        ...entries.map((entry) => entry.id),
        ...Object.keys(callbacks.dayViewState?.referenceCards ?? {}),
        ...(callbacks.relationGraph?.cards.map((card) => card.id) ?? []),
      ],
      callbacks.dayViewState?.stackOrder ?? [],
    );

    const mapPointerTime = (event: PointerEvent) => {
      const rect = timeline.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const visualY = event.clientY - rect.top;
      const axisX = parseCssPixels(timeline, "--tp-axis-x", 84);
      if (!isWithinTimelineAxisHitArea(pointerX, axisX, DEFAULT_AXIS_HIT_RADIUS)) return null;
      return mapTimelineYToStoredTime(
        visualY,
        interaction.layout.axisTop,
        interaction.layout.axisBottom,
        (y) => interaction.layout.timeScale.yToEntryMinute(y),
        settings.snapMinutes,
      );
    };

    const clearGestureTranslation = (card: HTMLElement): void => {
      card.removeClass("is-moving-layout-gesture");
      card.style.removeProperty("--tp-gesture-x");
      card.style.removeProperty("--tp-gesture-y");
    };

    const updateActiveConnector = (rect: CanvasRect): void => {
      if (!activeConnector) return;
      // Keep the line attached with a cheap corridor curve while the pointer
      // is moving. Full obstacle routing scans the dense canvas and is settled
      // once at pointer-up instead of on every frame.
      this.updateConnectorPathWithObstacles(activeConnector.path, activeConnector.anchor, rect, []);
    };

    const settleActiveConnector = (rect: CanvasRect): void => {
      if (!activeConnector) return;
      this.updateConnectorPathWithObstacles(
        activeConnector.path,
        activeConnector.anchor,
        rect,
        activeConnector.obstacles,
      );
    };

    const applyWorkingRect = (rect: CanvasRect): void => {
      const frameStartedAt = performance.now();
      if (!activeEntry) return;
      const card = cards.get(activeEntry.id);
      if (!card) return;
      interaction.context.geometries.set(activeEntry.id, rect);
      card.addClass("has-manual-layout", "is-layout-gesture");
      if (gesture.kind === "moving" && startRect) {
        card.addClass("is-moving-layout-gesture");
        card.style.setProperty("--tp-gesture-x", `${rect.x - startRect.x}px`);
        card.style.setProperty("--tp-gesture-y", `${rect.y - startRect.y}px`);
      } else {
        clearGestureTranslation(card);
        card.style.setProperty("--tp-card-y", `${rect.y}px`);
        card.style.setProperty("--tp-column-x", `${rect.x}px`);
        card.style.setProperty("--tp-column-width", `${rect.width}px`);
        card.style.setProperty("--tp-card-height", `${rect.height}px`);
      }
      updateActiveConnector(rect);
      this.relationLayer?.refreshConnectedGeometry(activeEntry.id);
      if (this.snapshot) {
        const frameMs = performance.now() - frameStartedAt;
        const previousMaximum = Number.parseFloat(
          this.snapshot.container.dataset.tpGestureFrameMaxMs ?? "0",
        );
        this.snapshot.container.dataset.tpGestureFrameMaxMs = Math.max(
          Number.isFinite(previousMaximum) ? previousMaximum : 0,
          frameMs,
        ).toFixed(1);
        this.snapshot.container.dataset.tpGestureFrameCount = String(
          Number.parseInt(this.snapshot.container.dataset.tpGestureFrameCount ?? "0", 10) + 1,
        );
      }
    };

    const materializeWorkingRect = (): void => {
      if (!activeEntry || !workingRect) return;
      const card = cards.get(activeEntry.id);
      if (!card) return;
      clearGestureTranslation(card);
      card.style.setProperty("--tp-card-y", `${workingRect.y}px`);
      card.style.setProperty("--tp-column-x", `${workingRect.x}px`);
      card.style.setProperty("--tp-column-width", `${workingRect.width}px`);
      card.style.setProperty("--tp-card-height", `${workingRect.height}px`);
      interaction.context.geometries.set(activeEntry.id, workingRect);
      updateActiveConnector(workingRect);
      this.relationLayer?.refreshConnectedGeometry(activeEntry.id);
    };

    const gestureFrames = new LatestFrameQueue<CanvasRect>(
      {
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (frame) => window.cancelAnimationFrame(frame),
      },
      applyWorkingRect,
    );
    this.gestureFrames = gestureFrames;

    const restoreStartRect = (): void => {
      if (!activeEntry || !startRect) return;
      gestureFrames.clear();
      workingRect = { ...startRect };
      interaction.context.geometries.set(activeEntry.id, startRect);
      applyWorkingRect(startRect);
      settleActiveConnector(startRect);
      const card = cards.get(activeEntry.id);
      if (card) clearGestureTranslation(card);
      card?.toggleClass("has-manual-layout", Boolean(activeEntry.cardLayout));
      card?.removeClass("is-layout-gesture");
      if (!activeEntry.cardLayout && card) card.style.removeProperty("--tp-card-height");
    };

    const cleanupGesture = (pointerId: number): void => {
      timeline.removeClass("is-panning", "is-moving-card", "is-resizing-card");
      const activeCard = cards.get(activeEntry?.id ?? "");
      if (activeCard) clearGestureTranslation(activeCard);
      activeCard?.removeClass("is-layout-gesture", "is-move-primed");
      gestureFrames.clear();
      gesture = { kind: "idle" };
      startRect = null;
      workingRect = null;
      activeEntry = null;
      activeConnector = null;
      gestureBounds = null;
      try {
        timeline.releasePointerCapture(pointerId);
      } catch {
        // Obsidian may replace the leaf while a pointer is captured.
      }
    };

    const finish = (event: PointerEvent, cancel: boolean): void => {
      if (gesture.kind === "idle" || gesture.pointerId !== event.pointerId) return;
      const completed = gesture;
      if (cancel) {
        restoreStartRect();
        cleanupGesture(event.pointerId);
        return;
      }
      if (completed.kind === "pending") {
        const action = pendingClickAction(completed, interactionMode === "pan" || spaceHeld);
        let entryToOpen: TimePointEntry | null = null;
        if (action === "axis-create") {
          cardActivation = null;
          const pointerTime = mapPointerTime(event);
          if (pointerTime) {
            void Promise.resolve(callbacks.onCreateAtTime(pointerTime.time)).catch(
              (error: unknown) =>
                new Notice(error instanceof Error ? error.message : t("notice.createFailure")),
            );
          }
        } else if (action === "clear-selection") {
          cardActivation = null;
          callbacks.selectedEntryId = null;
          callbacks.onSelectEntry?.(null);
          this.decorateOverlappingCards(
            entries,
            cards,
            interaction.context.geometries,
            runtimeStackOrder,
            callbacks,
            null,
          );
        } else if (action === "select-card" && completed.target === "card" && activeEntry) {
          const activation = registerCardActivation(
            cardActivation,
            activeEntry.id,
            performance.now(),
          );
          cardActivation = activation.next;
          if (activation.open) entryToOpen = activeEntry;
          this.decorateOverlappingCards(
            entries,
            cards,
            interaction.context.geometries,
            runtimeStackOrder,
            callbacks,
            activeEntry.id,
          );
        } else {
          cardActivation = null;
        }
        cleanupGesture(event.pointerId);
        if (entryToOpen) callbacks.onEditEntry(entryToOpen);
        return;
      }
      suppressNextClick = true;
      suppressClickUntil = performance.now() + 700;
      gestureFrames.flush();
      materializeWorkingRect();
      if (workingRect) settleActiveConnector(workingRect);
      // A gesture can create or remove a manual-card collision. Recompute the
      // deck once at pointer-up (never on every pointer frame) so background
      // Markdown cannot remain visually interleaved after a resize.
      this.decorateOverlappingCards(
        entries,
        cards,
        interaction.context.geometries,
        runtimeStackOrder,
        callbacks,
        activeEntry?.id,
      );
      this.minimap?.refreshGeometry(this.buildMinimapGeometry(interaction));
      if (this.scaleRuntime) this.scheduleSettledConnectorRouting(this.scaleRuntime);
      if (
        (completed.kind === "moving" || completed.kind === "resizing") &&
        activeEntry &&
        startRect &&
        workingRect &&
        callbacks.onCommitLayout
      ) {
        const entry = activeEntry;
        const mutation: LayoutMutation = {
          date: entry.date,
          entryId: entry.id,
          before: entry.cardLayout ?? null,
          after: freezeCardGeometry(
            workingRect,
            gestureBounds ?? interaction.context.bounds,
            gestureScale,
          ),
          reason: completed.kind === "moving" ? "move" : "resize",
        };
        void Promise.resolve(callbacks.onCommitLayout(mutation)).catch((error: unknown) => {
          void this.renderSnapshot();
          new Notice(error instanceof Error ? error.message : t("notice.layoutFailure"));
        });
      }
      cleanupGesture(event.pointerId);
    };

    timeline.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !isTypingTarget(event.target)) {
        event.preventDefault();
        spaceHeld = true;
        timeline.addClass("is-temporary-pan");
      }
      if (event.key === "Escape" && gesture.kind !== "idle") {
        event.preventDefault();
        const pointerId = gesture.pointerId;
        restoreStartRect();
        cleanupGesture(pointerId);
      }
    });
    timeline.addEventListener("keyup", (event) => {
      if (event.code !== "Space") return;
      spaceHeld = false;
      timeline.removeClass("is-temporary-pan");
    });
    timeline.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && timeline.contains(event.relatedTarget)) return;
      spaceHeld = false;
      timeline.removeClass("is-temporary-pan");
    });
    timeline.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || gesture.kind !== "idle") return;
      const hand = interactionMode === "pan" || spaceHeld;
      if (!hand && isCardGestureExemptTarget(event.target)) return;
      if (hand) event.preventDefault();
      const element = event.target instanceof Element ? event.target : null;
      const handleElement = element?.closest<HTMLElement>("[data-resize-handle][data-entry-id]");
      const card = element?.closest<HTMLElement>(".timepoint-card[data-entry-id]");
      const node = element?.closest<HTMLElement>(".timepoint-node");
      if (node && !hand) return;
      const entryId = handleElement?.dataset.entryId ?? card?.dataset.entryId;
      const entry = entryId ? entries.find((candidate) => candidate.id === entryId) : undefined;
      if (card && !hand && !callbacks.layoutEditable) return;
      const pointerTime = !card && !handleElement ? mapPointerTime(event) : null;
      const target = hand
        ? "blank"
        : handleElement
          ? "resize"
          : card
            ? "card"
            : pointerTime
              ? "axis"
              : "blank";
      gesture = beginCanvasGesture({
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        x: event.clientX,
        y: event.clientY,
        target,
        ...(entry?.id ? { entryId: entry.id } : {}),
        ...(handleElement?.dataset.resizeHandle
          ? { handle: handleElement.dataset.resizeHandle as ResizeHandle }
          : {}),
      });
      startScrollLeft = scrollContainer.scrollLeft;
      startScrollTop = scrollContainer.scrollTop;
      gestureBounds = { ...interaction.context.bounds };
      gestureScale = interaction.timelineScale;
      activeEntry = entry ?? null;
      this.cancelSettledConnectorRouting();
      if (this.snapshot) {
        this.snapshot.container.dataset.tpGestureFrameMaxMs = "0.0";
        this.snapshot.container.dataset.tpGestureFrameCount = "0";
      }
      startRect = entry
        ? { ...(interaction.context.geometries.get(entry.id) ?? zeroRect()) }
        : null;
      workingRect = startRect ? { ...startRect } : null;
      const connectorPath = entry ? interaction.context.connectorPaths.get(entry.id) : undefined;
      const connectorAnchor = entry
        ? interaction.context.connectorAnchors.get(entry.id)
        : undefined;
      activeConnector =
        entry && connectorPath && connectorAnchor
          ? {
              path: connectorPath,
              anchor: connectorAnchor,
              obstacles: [...interaction.context.geometries]
                .filter(([id]) => id !== entry.id)
                .map(([, rect]) => ({ ...rect, x: rect.x + connectorAnchor.cardLayerX })),
            }
          : null;
      if (entry) {
        const activeCard = cards.get(entry.id);
        activeCard?.addClass("is-layout-gesture");
        activeCard?.toggleClass("is-move-primed", !handleElement);
        callbacks.selectedEntryId = entry.id;
        callbacks.onSelectEntry?.(entry);
        raiseCardImmediately(activeCard, timeline);
        runtimeStackOrder = moveStackItemToEnd(runtimeStackOrder, entry.id);
        callbacks.onStackOrderChange?.(runtimeStackOrder);
      }
      timeline.focus({ preventScroll: true });
      try {
        timeline.setPointerCapture(event.pointerId);
      } catch {
        // Movement still works while the pointer stays inside the canvas.
      }
    });
    timeline.addEventListener("pointermove", (event) => {
      if (gesture.kind === "idle" || gesture.pointerId !== event.pointerId) return;
      const previousKind = gesture.kind;
      gesture = advanceCanvasGesture(
        gesture,
        event.clientX,
        event.clientY,
        interactionMode === "pan" || spaceHeld,
      );
      if (gesture.kind === "pending" || gesture.kind === "idle") return;
      event.preventDefault();
      if (gesture.kind === "panning") {
        timeline.addClass("is-panning");
        scrollContainer.scrollLeft = startScrollLeft - (event.clientX - gesture.startX);
        scrollContainer.scrollTop = startScrollTop - (event.clientY - gesture.startY);
        return;
      }
      if (!startRect || !activeEntry) return;
      timeline.toggleClass("is-moving-card", gesture.kind === "moving");
      timeline.toggleClass("is-resizing-card", gesture.kind === "resizing");
      const activeCard = cards.get(activeEntry.id);
      activeCard?.addClass("has-manual-layout", "is-layout-gesture");
      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      const nextRect =
        gesture.kind === "resizing" && gesture.handle
          ? resizeCardRect(
              startRect,
              gesture.handle,
              deltaX,
              deltaY,
              gestureBounds ?? interaction.context.bounds,
              gestureScale,
            )
          : moveCardRect(startRect, deltaX, deltaY, gestureBounds ?? interaction.context.bounds);
      workingRect = nextRect;
      if (previousKind === "pending") {
        cardActivation = null;
        suppressNextClick = true;
        suppressClickUntil = performance.now() + 700;
      }
      gestureFrames.enqueue(nextRect);
    });
    timeline.addEventListener("pointerup", (event) => finish(event, false));
    timeline.addEventListener("pointercancel", (event) => finish(event, true));
    timeline.addEventListener("lostpointercapture", (event) => {
      if (gesture.kind !== "idle") finish(event, true);
    });
    timeline.addEventListener(
      "click",
      (event) => {
        const suppressDragClick = suppressNextClick && performance.now() <= suppressClickUntil;
        if (!suppressDragClick && suppressNextClick) suppressNextClick = false;
        if (interactionMode === "pan" || spaceHeld || suppressDragClick) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (interactionMode !== "pan" && !spaceHeld) suppressNextClick = false;
        }
      },
      true,
    );
    timeline.addEventListener(
      "dblclick",
      (event) => {
        if (!shouldOpenCardOnDoubleClick(interactionMode === "pan" || spaceHeld, false)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }

  private cleanupRenderState(invalidate = true): void {
    if (invalidate) this.renderToken += 1;
    this.stopResizeObservation();
    this.cancelSettledConnectorRouting();
    if (this.connectorScrollFrame !== null) window.cancelAnimationFrame(this.connectorScrollFrame);
    this.connectorScrollFrame = null;
    this.connectorScrollContainer?.removeEventListener("scroll", this.handleConnectorScroll);
    this.connectorScrollContainer = null;
    this.minimap?.destroy();
    this.minimap = null;
    this.relationLayer?.destroy();
    this.relationLayer = null;
    this.gestureFrames?.clear();
    this.gestureFrames = null;
    for (const component of this.markdownComponents) component.unload();
    this.markdownComponents = [];
    this.scaleRuntime = null;
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

function setStylePropertyIfChanged(
  element: HTMLElement | SVGElement,
  property: string,
  value: string,
): void {
  if (element.style.getPropertyValue(property) !== value)
    element.style.setProperty(property, value);
}

function removeStylePropertyIfPresent(element: HTMLElement | SVGElement, property: string): void {
  if (element.style.getPropertyValue(property)) element.style.removeProperty(property);
}

function setAttributeIfChanged(element: Element, attribute: string, value: string): void {
  if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
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

function normalizeStackOrder(allIds: readonly string[], stored: readonly string[]): string[] {
  const canonical = [...new Set(allIds)];
  const allowed = new Set(canonical);
  const storedUnique = [...new Set(stored.filter((id) => allowed.has(id)))];
  const storedSet = new Set(storedUnique);
  return [...canonical.filter((id) => !storedSet.has(id)), ...storedUnique];
}

function moveStackItemToEnd(order: readonly string[], id: string): string[] {
  return [...order.filter((candidate) => candidate !== id), id];
}

function raiseCardImmediately(card: HTMLElement | undefined, timeline: HTMLElement): void {
  if (!card) return;
  const cards = [
    ...timeline.querySelectorAll<HTMLElement>(
      ".timepoint-card[data-entry-id], .timepoint-reference-card[data-reference-id]",
    ),
  ];
  const highest = Math.max(
    6,
    ...cards.map(
      (candidate) => Number.parseInt(candidate.style.getPropertyValue("--tp-card-z"), 10) || 6,
    ),
  );
  card.style.setProperty("--tp-card-z", String(highest + 1));
}

function cardStackIndex(card: HTMLElement): number {
  return Number.parseInt(card.style.getPropertyValue("--tp-card-z"), 10) || 6;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("a, button, input, textarea, select, [contenteditable='true']"))
  );
}

function zeroRect(): CanvasRect {
  return { x: 0, y: 0, width: 1, height: 1 };
}
