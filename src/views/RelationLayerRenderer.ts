import { setIcon } from "obsidian";
import { t } from "../i18n";
import {
  freezeCardGeometry,
  moveCardRect,
  resizeCardRect,
  type CanvasBounds,
  type CanvasRect,
} from "../layout";
import type {
  CanvasGestureState,
  ResizeHandle,
  TimePointDayViewState,
  TimePointReferenceCardState,
  TimePointRelationCard,
  TimePointRelationGraph,
} from "../model/types";
import { createCardLayout } from "../storage";
import { advanceCanvasGesture, beginCanvasGesture } from "./canvasGesture";

export interface RelationLayerOptions {
  timeline: HTMLElement;
  cardLayer: HTMLElement;
  graph: TimePointRelationGraph;
  viewState: TimePointDayViewState;
  timelineScale: number;
  eventGeometries?: ReadonlyMap<string, CanvasRect>;
  eventLayerOffsetLeft?: number;
  referenceLayerOffsetLeft?: number;
  selectedId?: string | null;
  editable: boolean;
  resolveResourcePath?: (path: string) => string;
  onSelect: (id: string) => void;
  onStackOrderChange: (stackOrder: string[]) => void;
  onReferenceStateChange: (state: TimePointReferenceCardState) => void | Promise<void>;
  onToggleExpanded: (
    card: TimePointRelationCard,
    state: TimePointReferenceCardState,
  ) => void | Promise<void>;
  onOpen: (card: TimePointRelationCard) => void | Promise<void>;
  onRefreshSnapshot?: (card: TimePointRelationCard) => void | Promise<void>;
  onGeometryChanged?: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export class RelationLayerRenderer {
  private readonly cards = new Map<string, HTMLElement>();
  private readonly states = new Map<string, TimePointReferenceCardState>();
  private readonly resolvedRects = new Map<string, CanvasRect>();
  private readonly relationPaths: SVGPathElement[] = [];
  private summaryEl: HTMLElement | null = null;
  private frame: number | null = null;
  private runtimeStackOrder: string[] = [];
  private layerOffsetLeft = 0;
  private eventLayerOffsetLeft = 0;
  private eventGeometries: ReadonlyMap<string, CanvasRect> = new Map();

  constructor(private readonly options: RelationLayerOptions) {}

  mount(): void {
    this.layerOffsetLeft =
      this.options.referenceLayerOffsetLeft ?? this.options.cardLayer.offsetLeft;
    this.eventLayerOffsetLeft = this.options.eventLayerOffsetLeft ?? 0;
    this.eventGeometries = this.options.eventGeometries ?? new Map();
    const bounds = this.bounds();
    this.options.graph.cards.forEach((model, index) => {
      const stored = this.options.viewState.referenceCards[model.id];
      const state = stored
        ? { ...stored }
        : defaultReferenceState(model, index, this.options.graph.cards.length);
      this.states.set(model.id, state);
      this.renderCard(model, state, bounds);
    });
    this.renderEdges();
    this.summaryEl = this.options.timeline.createDiv({
      cls: "timepoint-relations-summary",
      text: t("relations.summary", {
        cards: this.options.graph.cards.length,
        edges: this.options.graph.edges.length,
      }),
    });
    if (
      this.options.graph.truncatedCards > 0 ||
      this.options.graph.truncatedEdges > 0 ||
      this.options.graph.cycles.length > 0
    ) {
      this.summaryEl.addClass("is-warning");
      this.summaryEl.setAttr(
        "title",
        t("relations.limited", {
          cards: this.options.graph.truncatedCards,
          edges: this.options.graph.truncatedEdges,
          cycles: this.options.graph.cycles.length,
        }),
      );
    }
  }

  destroy(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    for (const path of this.relationPaths) path.remove();
    this.summaryEl?.remove();
    this.summaryEl = null;
    for (const card of this.cards.values()) card.remove();
    this.relationPaths.length = 0;
    this.cards.clear();
    this.states.clear();
    this.resolvedRects.clear();
  }

  refreshConnectedGeometry(id: string): void {
    this.refreshConnectedEdges(id);
  }

  updateScale(
    scale: number,
    boundsOverride?: CanvasBounds,
    geometry?: {
      eventGeometries: ReadonlyMap<string, CanvasRect>;
      eventLayerOffsetLeft: number;
      referenceLayerOffsetLeft: number;
    },
  ): void {
    this.options.timelineScale = scale;
    if (geometry) {
      this.eventGeometries = geometry.eventGeometries;
      this.eventLayerOffsetLeft = geometry.eventLayerOffsetLeft;
      this.layerOffsetLeft = geometry.referenceLayerOffsetLeft;
    }
    const bounds = boundsOverride ?? this.bounds();
    for (const model of this.options.graph.cards) {
      const state = this.states.get(model.id);
      const card = this.cards.get(model.id);
      if (!state || !card) continue;
      const geometry = stateToRect(state, bounds, scale);
      this.resolvedRects.set(model.id, geometry);
      applyCardRect(card, geometry);
    }
    this.refreshRelationPaths();
  }

  getMinimapCards(): Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    reference: true;
  }> {
    return [...this.resolvedRects].map(([id, rect]) => ({
      id,
      x: this.layerOffsetLeft + rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      reference: true,
    }));
  }

  private renderCard(
    model: TimePointRelationCard,
    state: TimePointReferenceCardState,
    bounds: CanvasBounds,
  ): void {
    const card = this.options.cardLayer.createDiv({
      cls: `timepoint-card timepoint-reference-card has-manual-layout is-${model.kind}`,
      attr: {
        tabindex: "0",
        "data-reference-id": model.id,
        "data-stack-id": model.id,
        "aria-label": t("relations.cardAria", { title: model.title }),
      },
    });
    this.cards.set(model.id, card);
    const geometry = stateToRect(state, bounds, this.options.timelineScale);
    this.resolvedRects.set(model.id, geometry);
    applyCardRect(card, geometry);
    card.toggleClass("is-selected", this.options.selectedId === model.id);
    card.style.setProperty(
      "--tp-card-z",
      String(6 + stackIndex(this.options.viewState.stackOrder, model.id)),
    );

    const header = card.createDiv({ cls: "timepoint-card-header timepoint-reference-header" });
    const title = header.createDiv({ cls: "timepoint-reference-title" });
    setIcon(title.createSpan(), iconForKind(model.kind));
    title.createSpan({ text: model.title });
    const actions = header.createDiv({ cls: "timepoint-card-actions" });
    if (model.kind === "external-url" && this.options.onRefreshSnapshot) {
      const refresh = actions.createEl("button", {
        cls: "timepoint-card-action",
        attr: { type: "button", "aria-label": t("relations.refreshSnapshot") },
      });
      setIcon(refresh, "refresh-cw");
      refresh.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.options.onRefreshSnapshot?.(model);
      });
    }
    if (model.kind !== "external-url") {
      const expand = actions.createEl("button", {
        cls: "timepoint-card-action",
        attr: {
          type: "button",
          "aria-label": state.expanded ? t("relations.collapse") : t("relations.expand"),
        },
      });
      setIcon(expand, state.expanded ? "minus" : "git-branch-plus");
      expand.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = { ...state, expanded: !state.expanded };
        this.states.set(model.id, next);
        void this.options.onToggleExpanded(model, next);
      });
    }
    const open = actions.createEl("button", {
      cls: "timepoint-card-action",
      attr: { type: "button", "aria-label": t("relations.open") },
    });
    setIcon(open, "arrow-up-right");
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.options.onOpen(model);
    });
    if (model.previewPath && this.options.resolveResourcePath) {
      const image = card.createEl("img", {
        cls: "timepoint-reference-preview",
        attr: { alt: "", loading: "lazy" },
      });
      image.src = this.options.resolveResourcePath(model.previewPath);
    }
    if (model.description) {
      card.createDiv({ cls: "timepoint-reference-description", text: model.description });
    }
    card.createDiv({ cls: "timepoint-reference-target", text: compactTarget(model.target) });
    if (this.options.editable) this.createResizeHandles(card, model.id);

    card.addEventListener("dblclick", (event) => {
      if (event.target instanceof Element && event.target.closest("button, a")) return;
      event.preventDefault();
      this.raise(model.id);
      void this.options.onOpen(model);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.target !== card) return;
      event.preventDefault();
      void this.options.onOpen(model);
    });
    if (this.options.editable) this.installGesture(card, model, state);
  }

  private installGesture(
    card: HTMLElement,
    model: TimePointRelationCard,
    initialState: TimePointReferenceCardState,
  ): void {
    let gesture: CanvasGestureState = { kind: "idle" };
    let gestureBounds = this.bounds();
    let startRect = stateToRect(initialState, gestureBounds, this.options.timelineScale);
    let workingRect = { ...startRect };
    const clearTranslation = (): void => {
      card.removeClass("is-moving-layout-gesture");
      card.style.removeProperty("--tp-gesture-x");
      card.style.removeProperty("--tp-gesture-y");
    };
    const applyWorkingRect = (): void => {
      if (gesture.kind === "moving") {
        card.addClass("is-moving-layout-gesture");
        card.style.setProperty("--tp-gesture-x", `${workingRect.x - startRect.x}px`);
        card.style.setProperty("--tp-gesture-y", `${workingRect.y - startRect.y}px`);
      } else {
        clearTranslation();
        applyCardRect(card, workingRect);
      }
      this.resolvedRects.set(model.id, workingRect);
      this.refreshConnectedEdges(model.id);
    };
    const flushFrame = (): void => {
      if (this.frame !== null) window.cancelAnimationFrame(this.frame);
      this.frame = null;
      applyWorkingRect();
    };
    const cancel = (pointerId: number): void => {
      if (this.frame !== null) window.cancelAnimationFrame(this.frame);
      this.frame = null;
      clearTranslation();
      applyCardRect(card, startRect);
      this.resolvedRects.set(model.id, startRect);
      gesture = { kind: "idle" };
      card.removeClass("is-layout-gesture");
      try {
        card.releasePointerCapture(pointerId);
      } catch {
        // The timeline may be replaced by a relation refresh.
      }
      this.refreshConnectedEdges(model.id);
      this.options.onGeometryChanged?.();
    };
    const finish = (event: PointerEvent, cancelled: boolean): void => {
      if (gesture.kind === "idle" || gesture.pointerId !== event.pointerId) return;
      if (cancelled) {
        cancel(event.pointerId);
        return;
      }
      if (gesture.kind === "moving" || gesture.kind === "resizing") {
        flushFrame();
        clearTranslation();
        applyCardRect(card, workingRect);
        this.resolvedRects.set(model.id, workingRect);
        this.refreshConnectedEdges(model.id);
        const layout = freezeCardGeometry(workingRect, gestureBounds, this.options.timelineScale);
        const next: TimePointReferenceCardState = {
          ...(this.states.get(model.id) ?? initialState),
          x: layout.x,
          y: layout.y,
          width: layout.width,
          height: layout.height,
        };
        this.states.set(model.id, next);
        void this.options.onReferenceStateChange(next);
      }
      gesture = { kind: "idle" };
      card.removeClass("is-layout-gesture");
      try {
        card.releasePointerCapture(event.pointerId);
      } catch {
        // The timeline may be replaced by a relation refresh.
      }
      this.options.onGeometryChanged?.();
    };
    card.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || gesture.kind !== "idle") return;
      if (
        this.options.timeline.hasClass("is-pan-mode") ||
        this.options.timeline.hasClass("is-temporary-pan")
      ) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, a, input, textarea, select")) return;
      event.stopPropagation();
      const handle = target?.closest<HTMLElement>("[data-resize-handle]")?.dataset.resizeHandle as
        ResizeHandle | undefined;
      gesture = beginCanvasGesture({
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        x: event.clientX,
        y: event.clientY,
        target: handle ? "resize" : "card",
        entryId: model.id,
        ...(handle ? { handle } : {}),
      });
      gestureBounds = this.bounds();
      startRect = stateToRect(
        this.states.get(model.id) ?? initialState,
        gestureBounds,
        this.options.timelineScale,
      );
      workingRect = { ...startRect };
      this.raise(model.id);
      try {
        card.setPointerCapture(event.pointerId);
      } catch {
        // Movement continues while the pointer remains over the card.
      }
    });
    card.addEventListener("pointermove", (event) => {
      if (gesture.kind === "idle" || gesture.pointerId !== event.pointerId) return;
      gesture = advanceCanvasGesture(gesture, event.clientX, event.clientY);
      if (gesture.kind === "idle" || gesture.kind === "pending") return;
      event.preventDefault();
      event.stopPropagation();
      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      workingRect =
        gesture.kind === "resizing" && gesture.handle
          ? resizeCardRect(
              startRect,
              gesture.handle,
              deltaX,
              deltaY,
              gestureBounds,
              this.options.timelineScale,
            )
          : moveCardRect(startRect, deltaX, deltaY, gestureBounds);
      card.addClass("is-layout-gesture");
      if (this.frame !== null) return;
      this.frame = window.requestAnimationFrame(() => {
        this.frame = null;
        applyWorkingRect();
      });
    });
    card.addEventListener("pointerup", (event) => finish(event, false));
    card.addEventListener("pointercancel", (event) => finish(event, true));
    card.addEventListener("lostpointercapture", (event) => {
      if (gesture.kind !== "idle") finish(event, true);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || gesture.kind === "idle") return;
      event.preventDefault();
      cancel(gesture.pointerId);
    });
  }

  private createResizeHandles(card: HTMLElement, id: string): void {
    for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) {
      card.createDiv({
        cls: `timepoint-resize-handle is-${handle}`,
        attr: {
          role: "separator",
          "data-resize-handle": handle,
          "data-reference-id": id,
          "aria-label": t("relations.resizeCard", { handle }),
        },
      });
    }
  }

  private raise(id: string): void {
    this.options.onSelect(id);
    if (this.runtimeStackOrder.length === 0) {
      this.runtimeStackOrder = normalizeOrder(
        [
          ...[...this.options.timeline.querySelectorAll<HTMLElement>("[data-entry-id]")].map(
            (element) => element.dataset.entryId ?? "",
          ),
          ...this.options.graph.cards.map((card) => card.id),
        ].filter(Boolean),
        this.options.viewState.stackOrder,
      );
    }
    this.runtimeStackOrder = moveToEnd(this.runtimeStackOrder, id);
    this.options.onStackOrderChange(this.runtimeStackOrder);
    const maximum = Math.max(
      6,
      ...[
        ...this.options.timeline.querySelectorAll<HTMLElement>(
          "[data-entry-id], [data-reference-id]",
        ),
      ].map((element) => Number.parseInt(element.style.getPropertyValue("--tp-card-z"), 10) || 6),
    );
    for (const candidate of this.cards.values()) candidate.removeClass("is-selected");
    const card = this.cards.get(id);
    card?.addClass("is-selected");
    if (card) card.style.setProperty("--tp-card-z", String(maximum + 1));
    for (const path of this.relationPaths) {
      const edge = this.options.graph.edges.find(
        (candidate) => candidate.id === path.dataset.edgeId,
      );
      path.classList.toggle("is-selected", edge?.fromId === id || edge?.toId === id);
    }
  }

  private renderEdges(): void {
    for (const path of this.relationPaths) path.remove();
    this.relationPaths.length = 0;
    const svg = this.options.timeline.querySelector<SVGSVGElement>(".timepoint-connector-layer");
    if (!svg) return;
    for (const edge of this.options.graph.edges) {
      const path = document.createElementNS(SVG_NS, "path");
      path.classList.add("timepoint-relation-path", `is-${edge.kind}`);
      path.classList.toggle(
        "is-selected",
        edge.fromId === this.options.selectedId || edge.toId === this.options.selectedId,
      );
      path.dataset.edgeId = edge.id;
      path.dataset.fromId = edge.fromId;
      path.dataset.toId = edge.toId;
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
      this.relationPaths.push(path);
    }
    this.refreshRelationPaths();
  }

  private refreshConnectedEdges(id: string): void {
    this.refreshRelationPaths((path) => path.dataset.fromId === id || path.dataset.toId === id);
  }

  private refreshRelationPaths(include: (path: SVGPathElement) => boolean = () => true): void {
    const geometries = new Map<string, CanvasRect>();
    let timelineRect: DOMRect | null = null;
    const resolve = (id: string): CanvasRect | null => {
      const existing = geometries.get(id);
      if (existing) return existing;
      const eventRect = this.eventGeometries.get(id);
      if (eventRect) {
        const rect = { ...eventRect, x: eventRect.x + this.eventLayerOffsetLeft };
        geometries.set(id, rect);
        return rect;
      }
      const referenceRect = this.resolvedRects.get(id);
      if (referenceRect) {
        const rect = { ...referenceRect, x: referenceRect.x + this.layerOffsetLeft };
        geometries.set(id, rect);
        return rect;
      }
      const card = this.findCard(id);
      if (!card) return null;
      timelineRect ??= this.options.timeline.getBoundingClientRect();
      const rect = rectRelativeToBounds(card, timelineRect);
      geometries.set(id, rect);
      return rect;
    };
    for (const path of this.relationPaths) {
      if (!include(path)) continue;
      const fromId = path.dataset.fromId;
      const toId = path.dataset.toId;
      if (!fromId || !toId) continue;
      const fromRect = resolve(fromId);
      const toRect = resolve(toId);
      if (!fromRect || !toRect) continue;
      const startX = fromRect.x + fromRect.width;
      const startY = fromRect.y + fromRect.height / 2;
      const endX = toRect.x;
      const endY = toRect.y + toRect.height / 2;
      const control = Math.max(36, Math.abs(endX - startX) * 0.45);
      const nextPath = `M ${round(startX)} ${round(startY)} C ${round(startX + control)} ${round(startY)}, ${round(endX - control)} ${round(endY)}, ${round(endX)} ${round(endY)}`;
      if (path.getAttribute("d") !== nextPath) path.setAttribute("d", nextPath);
    }
  }

  private findCard(id: string): HTMLElement | null {
    return (
      this.cards.get(id) ??
      this.options.timeline.querySelector<HTMLElement>(
        `.timepoint-card[data-entry-id="${cssId(id)}"]`,
      )
    );
  }

  private bounds(): CanvasBounds {
    const timelineStyle = getComputedStyle(this.options.timeline);
    const top = Number.parseFloat(timelineStyle.getPropertyValue("--tp-axis-top-y")) || 36;
    const height =
      Number.parseFloat(timelineStyle.getPropertyValue("--tp-axis-height")) ||
      Math.max(1, this.options.timeline.clientHeight - top - 44);
    return { left: 0, top, width: Math.max(1, this.options.cardLayer.clientWidth), height };
  }
}

function defaultReferenceState(
  card: TimePointRelationCard,
  index: number,
  count: number,
): TimePointReferenceCardState {
  return {
    id: card.id,
    kind: card.kind,
    target: card.target,
    x: 0.5,
    y: Math.min(0.92, Math.max(0.08, (index + 1) / (count + 1))),
    width: 0.88,
    height: 156,
    expanded: false,
  };
}

function stateToRect(
  state: TimePointReferenceCardState,
  bounds: CanvasBounds,
  scale: number,
): CanvasRect {
  const layout = createCardLayout({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  });
  const width = Math.min(bounds.width, layout.width * bounds.width);
  const height = Math.min(bounds.height, layout.height * scale);
  return {
    x: clamp(
      bounds.left + layout.x * bounds.width - width / 2,
      bounds.left,
      bounds.left + bounds.width - width,
    ),
    y: clamp(
      bounds.top + layout.y * bounds.height - height / 2,
      bounds.top,
      bounds.top + bounds.height - height,
    ),
    width,
    height,
  };
}

function applyCardRect(card: HTMLElement, rect: CanvasRect): void {
  setStyleIfChanged(card, "--tp-card-y", `${rect.y}px`);
  setStyleIfChanged(card, "--tp-column-x", `${rect.x}px`);
  setStyleIfChanged(card, "--tp-column-width", `${rect.width}px`);
  setStyleIfChanged(card, "--tp-card-height", `${rect.height}px`);
}

function setStyleIfChanged(card: HTMLElement, property: string, value: string): void {
  if (card.style.getPropertyValue(property) !== value) card.style.setProperty(property, value);
}

function rectRelativeToBounds(element: HTMLElement, timelineRect: DOMRect): CanvasRect {
  const elementRect = element.getBoundingClientRect();
  return {
    x: elementRect.left - timelineRect.left,
    y: elementRect.top - timelineRect.top,
    width: elementRect.width,
    height: elementRect.height,
  };
}

function iconForKind(kind: TimePointRelationCard["kind"]): string {
  return kind === "external-url" ? "globe-2" : kind === "day-entry" ? "calendar-days" : "file-text";
}

function compactTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 180);
  } catch {
    return value.slice(0, 180);
  }
}

function normalizeOrder(allIds: readonly string[], stored: readonly string[]): string[] {
  const all = new Set(allIds);
  const existing = [...new Set(stored.filter((id) => all.has(id)))];
  const present = new Set(existing);
  return [...allIds.filter((id) => !present.has(id)), ...existing];
}

function moveToEnd(order: readonly string[], id: string): string[] {
  return [...order.filter((candidate) => candidate !== id), id];
}

function stackIndex(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? 0 : index;
}

function cssId(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
