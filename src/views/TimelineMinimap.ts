import { setIcon } from "obsidian";
import { t } from "../i18n";

const MAP_WIDTH = 168;
const MAP_HEIGHT = 220;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface TimelineMinimapOptions {
  scrollContainer: HTMLElement;
  timeline: HTMLElement;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export interface TimelineMinimapGeometry {
  timelineWidth: number;
  timelineHeight: number;
  nodes: readonly { id: string; x: number; y: number }[];
  cards: readonly {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    reference?: boolean;
  }[];
}

export class TimelineMinimap {
  private readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly canvasContext: CanvasRenderingContext2D | null;
  private readonly svg: SVGSVGElement;
  private readonly viewport: SVGRectElement;
  private expanded: boolean;
  private frame: number | null = null;
  private pointerId: number | null = null;
  private narrow = false;
  private narrowOverlayOpen = false;
  private resizeObserver: ResizeObserver | null = null;
  private timelineWidth = 1;
  private timelineHeight = 1;
  private timelineOffsetLeft = 0;
  private timelineOffsetTop = 0;
  private scrollClientWidth = 1;
  private scrollClientHeight = 1;
  private palette: {
    cardFill: string;
    cardStroke: string;
    referenceFill: string;
    nodeFill: string;
  } | null = null;

  constructor(private readonly options: TimelineMinimapOptions) {
    this.expanded = options.expanded;
    this.root = createDiv();
    this.root.className = "timepoint-minimap";
    this.toggle = createEl("button");
    this.toggle.className = "timepoint-minimap-toggle timepoint-icon-button";
    this.toggle.type = "button";
    this.toggle.setAttribute("aria-label", t("view.minimapToggle"));
    setIcon(this.toggle, "map");
    this.panel = createDiv();
    this.panel.className = "timepoint-minimap-panel";
    this.canvas = createEl("canvas");
    this.canvas.className = "timepoint-minimap-canvas";
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(MAP_WIDTH * pixelRatio);
    this.canvas.height = Math.round(MAP_HEIGHT * pixelRatio);
    this.canvasContext = this.canvas.getContext("2d");
    this.canvasContext?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("timepoint-minimap-svg");
    this.svg.setAttribute("viewBox", `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`);
    this.svg.setAttribute("role", "application");
    this.svg.setAttribute("tabindex", "0");
    this.svg.setAttribute("aria-label", t("view.minimapAria"));
    this.viewport = document.createElementNS(SVG_NS, "rect");
    this.viewport.classList.add("timepoint-minimap-viewport");
    this.panel.append(this.canvas, this.svg);
    this.svg.append(this.viewport);
    this.root.append(this.toggle, this.panel);
  }

  mount(): void {
    this.options.scrollContainer.prepend(this.root);
    this.toggle.addEventListener("click", this.toggleExpanded);
    this.options.scrollContainer.addEventListener("scroll", this.scheduleUpdate, { passive: true });
    this.svg.addEventListener("pointerdown", this.pointerDown);
    this.svg.addEventListener("pointermove", this.pointerMove);
    this.svg.addEventListener("pointerup", this.pointerUp);
    this.svg.addEventListener("pointercancel", this.pointerUp);
    this.svg.addEventListener("keydown", this.keyDown);
    this.narrow = this.options.scrollContainer.clientWidth <= 720;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.updateResponsiveState());
      this.resizeObserver.observe(this.options.scrollContainer);
    }
    this.captureViewportMetrics();
    this.renderContent();
    this.updateExpanded();
    this.updateViewport();
  }

  destroy(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.toggle.removeEventListener("click", this.toggleExpanded);
    this.options.scrollContainer.removeEventListener("scroll", this.scheduleUpdate);
    this.svg.removeEventListener("pointerdown", this.pointerDown);
    this.svg.removeEventListener("pointermove", this.pointerMove);
    this.svg.removeEventListener("pointerup", this.pointerUp);
    this.svg.removeEventListener("pointercancel", this.pointerUp);
    this.svg.removeEventListener("keydown", this.keyDown);
    this.root.remove();
  }

  refreshContent(): void {
    this.renderContent();
    this.updateViewport();
  }

  /** Update map shapes from renderer geometry without forcing card layout. */
  refreshGeometry(snapshot: TimelineMinimapGeometry): void {
    this.timelineWidth = Math.max(1, snapshot.timelineWidth);
    this.timelineHeight = Math.max(1, snapshot.timelineHeight);
    this.updateGeometryPaths(snapshot.nodes, snapshot.cards);
    // Do not read scroll offsets while card geometry is dirty. The anchored
    // scroll applied by the view emits a scroll event and refreshes the frame
    // after the browser has completed that layout once.
  }

  private readonly toggleExpanded = (): void => {
    if (this.narrow) {
      this.narrowOverlayOpen = !this.narrowOverlayOpen;
      this.updateExpanded();
      return;
    }
    this.expanded = !this.expanded;
    this.updateExpanded();
    this.options.onExpandedChange?.(this.expanded);
  };

  private updateExpanded(): void {
    const visible = this.narrow ? this.narrowOverlayOpen : this.expanded;
    this.root.classList.toggle("is-expanded", visible);
    this.root.classList.toggle("is-narrow", this.narrow);
    this.toggle.setAttribute("aria-pressed", String(visible));
    this.panel.hidden = !visible;
  }

  private updateResponsiveState(): void {
    this.captureViewportMetrics();
    const narrow = this.options.scrollContainer.clientWidth <= 720;
    if (narrow !== this.narrow) {
      this.narrow = narrow;
      this.narrowOverlayOpen = false;
      this.updateExpanded();
    }
    this.renderContent();
    this.updateViewport();
  }

  private renderContent(): void {
    const timelineWidth = Math.max(1, this.options.timeline.scrollWidth);
    const timelineHeight = Math.max(1, this.options.timeline.scrollHeight);
    this.timelineWidth = timelineWidth;
    this.timelineHeight = timelineHeight;
    const nodes: Array<{ id: string; x: number; y: number }> = [];
    let nodeIndex = 0;
    for (const node of this.options.timeline.querySelectorAll<HTMLElement>(".timepoint-node")) {
      const key = node.dataset.minute ?? `node-${nodeIndex}`;
      nodeIndex += 1;
      nodes.push({ id: key, x: node.offsetLeft, y: node.offsetTop });
    }
    const cards: TimelineMinimapGeometry["cards"][number][] = [];
    let cardIndex = 0;
    for (const card of this.options.timeline.querySelectorAll<HTMLElement>(
      ".timepoint-card, .timepoint-reference-card",
    )) {
      const reference = card.hasClass("timepoint-reference-card");
      const key = reference
        ? `reference:${card.dataset.referenceId ?? cardIndex}`
        : `entry:${card.dataset.entryId ?? cardIndex}`;
      cardIndex += 1;
      const parentLeft =
        card.offsetParent === this.options.timeline
          ? 0
          : ((card.offsetParent as HTMLElement | null)?.offsetLeft ?? 0);
      const left = parentLeft + card.offsetLeft;
      cards.push({
        id: key,
        x: left,
        y: card.offsetTop,
        width: card.offsetWidth,
        height: card.offsetHeight,
        reference,
      });
    }
    this.updateGeometryPaths(nodes, cards);
  }

  private readonly scheduleUpdate = (): void => {
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.updateViewport();
    });
  };

  private updateViewport(): void {
    const scroll = this.options.scrollContainer;
    const timelineWidth = this.timelineWidth;
    const timelineHeight = this.timelineHeight;
    const left = scroll.scrollLeft - this.timelineOffsetLeft;
    const top = scroll.scrollTop - this.timelineOffsetTop;
    this.viewport.setAttribute("x", String(clamp(left / timelineWidth, 0, 1) * MAP_WIDTH));
    this.viewport.setAttribute("y", String(clamp(top / timelineHeight, 0, 1) * MAP_HEIGHT));
    this.viewport.setAttribute(
      "width",
      String(
        Math.min(MAP_WIDTH, Math.max(8, (this.scrollClientWidth / timelineWidth) * MAP_WIDTH)),
      ),
    );
    this.viewport.setAttribute(
      "height",
      String(
        Math.min(MAP_HEIGHT, Math.max(8, (this.scrollClientHeight / timelineHeight) * MAP_HEIGHT)),
      ),
    );
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.svg.focus({ preventScroll: true });
    this.pointerId = event.pointerId;
    this.svg.setPointerCapture(event.pointerId);
    this.navigate(event);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    event.preventDefault();
    this.navigate(event);
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.pointerId = null;
    try {
      this.svg.releasePointerCapture(event.pointerId);
    } catch {
      // The overlay may collapse while the pointer is still held.
    }
  };

  private readonly keyDown = (event: KeyboardEvent): void => {
    const scroll = this.options.scrollContainer;
    const maximumLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    const maximumTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const lineX = Math.max(44, scroll.clientWidth * 0.1);
    const lineY = Math.max(44, scroll.clientHeight * 0.1);
    const pageY = Math.max(44, scroll.clientHeight * 0.9);
    let left = scroll.scrollLeft;
    let top = scroll.scrollTop;
    switch (event.key) {
      case "Home":
        top = 0;
        break;
      case "End":
        top = maximumTop;
        break;
      case "ArrowUp":
        top -= lineY;
        break;
      case "ArrowDown":
        top += lineY;
        break;
      case "ArrowLeft":
        left -= lineX;
        break;
      case "ArrowRight":
        left += lineX;
        break;
      case "PageUp":
        top -= pageY;
        break;
      case "PageDown":
        top += pageY;
        break;
      default:
        return;
    }
    event.preventDefault();
    scroll.scrollLeft = clamp(left, 0, maximumLeft);
    scroll.scrollTop = clamp(top, 0, maximumTop);
  };

  private navigate(event: PointerEvent): void {
    const bounds = this.svg.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const y = clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1);
    const scroll = this.options.scrollContainer;
    scroll.scrollLeft =
      this.timelineOffsetLeft + x * this.timelineWidth - this.scrollClientWidth / 2;
    scroll.scrollTop =
      this.timelineOffsetTop + y * this.timelineHeight - this.scrollClientHeight / 2;
  }

  private captureViewportMetrics(): void {
    this.timelineOffsetLeft = this.options.timeline.offsetLeft;
    this.timelineOffsetTop = this.options.timeline.offsetTop;
    this.scrollClientWidth = Math.max(1, this.options.scrollContainer.clientWidth);
    this.scrollClientHeight = Math.max(1, this.options.scrollContainer.clientHeight);
  }

  private updateGeometryPaths(
    nodes: TimelineMinimapGeometry["nodes"],
    cards: TimelineMinimapGeometry["cards"],
  ): void {
    const context = this.canvasContext;
    if (!context) return;
    if (!this.palette) {
      const style = getComputedStyle(this.options.timeline);
      const read = (name: string, fallback: string): string =>
        style.getPropertyValue(name).trim() || fallback;
      this.palette = {
        cardFill: read("--background-secondary", style.backgroundColor),
        cardStroke: read("--background-modifier-border-hover", style.color),
        referenceFill: read("--background-secondary-alt", style.backgroundColor),
        nodeFill: read("--text-faint", style.color),
      };
    }
    context.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    context.lineWidth = 0.8;
    context.strokeStyle = this.palette.cardStroke;
    for (const reference of [false, true]) {
      context.fillStyle = reference ? this.palette.referenceFill : this.palette.cardFill;
      context.setLineDash(reference ? [2, 2] : []);
      context.beginPath();
      for (const card of cards) {
        if ((card.reference === true) !== reference) continue;
        context.rect(
          (card.x / this.timelineWidth) * MAP_WIDTH,
          (card.y / this.timelineHeight) * MAP_HEIGHT,
          Math.max(2, (card.width / this.timelineWidth) * MAP_WIDTH),
          Math.max(2, (card.height / this.timelineHeight) * MAP_HEIGHT),
        );
      }
      context.fill();
      context.stroke();
    }
    context.setLineDash([]);
    context.fillStyle = this.palette.nodeFill;
    context.beginPath();
    for (const node of nodes) {
      const x = (node.x / this.timelineWidth) * MAP_WIDTH;
      const y = (node.y / this.timelineHeight) * MAP_HEIGHT;
      context.rect(x - 1.25, y - 1.25, 2.5, 2.5);
    }
    context.fill();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
