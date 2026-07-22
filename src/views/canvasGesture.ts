import type { CanvasGestureState, ResizeHandle } from "../model/types";

export const MOUSE_DRAG_THRESHOLD = 6;
export const COARSE_DRAG_THRESHOLD = 10;

export type CanvasClickAction = "axis-create" | "clear-selection" | "select-card" | "none";

export interface CardActivationState {
  entryId: string;
  at: number;
}

export interface CardActivationResult {
  open: boolean;
  next: CardActivationState | null;
}

export interface AnimationFrameDriver {
  request(callback: FrameRequestCallback): number;
  cancel(frame: number): void;
}

/**
 * Keep at most one animation frame pending while always applying the newest
 * pointer sample. This prevents high-frequency pointer events from building a
 * stale visual queue behind the cursor.
 */
export class LatestFrameQueue<T> {
  private frame: number | null = null;
  private latest: T | null = null;

  constructor(
    private readonly driver: AnimationFrameDriver,
    private readonly apply: (value: T) => void,
  ) {}

  enqueue(value: T): void {
    this.latest = value;
    if (this.frame !== null) return;
    this.frame = this.driver.request(() => {
      this.frame = null;
      const latest = this.latest;
      this.latest = null;
      if (latest !== null) this.apply(latest);
    });
  }

  flush(): void {
    if (this.frame !== null) this.driver.cancel(this.frame);
    this.frame = null;
    const latest = this.latest;
    this.latest = null;
    if (latest !== null) this.apply(latest);
  }

  clear(): void {
    if (this.frame !== null) this.driver.cancel(this.frame);
    this.frame = null;
    this.latest = null;
  }

  get scheduled(): boolean {
    return this.frame !== null;
  }
}

export function pointerDragThreshold(pointerType: string): number {
  return pointerType === "touch" || pointerType === "pen"
    ? COARSE_DRAG_THRESHOLD
    : MOUSE_DRAG_THRESHOLD;
}

export function beginCanvasGesture(input: {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  target: "axis" | "blank" | "card" | "resize" | "minimap";
  entryId?: string;
  handle?: ResizeHandle;
}): CanvasGestureState {
  return {
    kind: "pending",
    pointerId: input.pointerId,
    target: input.target,
    startX: input.x,
    startY: input.y,
    threshold: pointerDragThreshold(input.pointerType),
    ...(input.entryId ? { entryId: input.entryId } : {}),
    ...(input.handle ? { handle: input.handle } : {}),
  };
}

export function advanceCanvasGesture(
  state: CanvasGestureState,
  x: number,
  y: number,
  forceHand = false,
): CanvasGestureState {
  if (state.kind !== "pending") return state;
  const distance = Math.hypot(x - state.startX, y - state.startY);
  if (distance < state.threshold) return state;
  const kind = forceHand
    ? "panning"
    : state.target === "card"
      ? "moving"
      : state.target === "resize"
        ? "resizing"
        : state.target === "minimap"
          ? "minimap-panning"
          : "panning";
  return {
    kind,
    pointerId: state.pointerId,
    startX: state.startX,
    startY: state.startY,
    ...(state.entryId ? { entryId: state.entryId } : {}),
    ...(state.handle ? { handle: state.handle } : {}),
  };
}

export function pendingClickAction(
  state: CanvasGestureState,
  forceHand = false,
): CanvasClickAction {
  if (state.kind !== "pending" || forceHand) return "none";
  if (state.target === "axis") return "axis-create";
  if (state.target === "blank") return "clear-selection";
  if (state.target === "card" || state.target === "resize") return "select-card";
  return "none";
}

export function shouldOpenCardOnDoubleClick(
  handMode: boolean,
  interactiveTarget: boolean,
): boolean {
  return !handMode && !interactiveTarget;
}

/**
 * Detect two completed, non-drag card activations without depending on
 * Electron's optional `dblclick` event. The second activation consumes the
 * sequence so a triple click cannot open the note twice.
 */
export function registerCardActivation(
  previous: CardActivationState | null,
  entryId: string,
  at: number,
  maximumDelay = 500,
): CardActivationResult {
  const elapsed = previous ? at - previous.at : Number.POSITIVE_INFINITY;
  const open =
    previous?.entryId === entryId &&
    Number.isFinite(elapsed) &&
    elapsed >= 0 &&
    elapsed <= maximumDelay;
  return open ? { open: true, next: null } : { open: false, next: { entryId, at } };
}

export function isCardGestureExemptTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "a, button, input, textarea, select, option, [contenteditable='true'], .task-list-item-checkbox",
      ),
    )
  );
}
