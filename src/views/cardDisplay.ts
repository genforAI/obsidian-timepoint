export type CardDisplayMode = "smart" | "preview";

export interface CardDisplayDecision {
  /** Whether the rendered Markdown exceeds the hard timeline preview limit. */
  clipped: boolean;
  /** The clamp height in pixels. Null means that the full note is visible. */
  maxHeight: number | null;
}

export interface CardDisplayOptions {
  mode: CardDisplayMode;
  naturalHeight: number;
  smartCollapseHeight: number;
  previewHeight: number;
  /** Optional runtime density cap; it never changes persisted Markdown. */
  densityLimit?: number | null;
}

export interface TimelineCardMeasurement {
  expectedHeight: number | undefined;
  measuredHeight: number;
}

export interface TimelineReflowMeasurement {
  previousContainerWidth: number;
  containerWidth: number;
  cards: readonly TimelineCardMeasurement[];
}

const CONTENT_HEIGHT_TOLERANCE = 2;

/**
 * Resolve a card's runtime-only presentation after Markdown has been rendered
 * and measured. The decision never changes the source entry or persisted data.
 */
export function resolveCardDisplay(options: CardDisplayOptions): CardDisplayDecision {
  const naturalHeight = normalizeHeight(options.naturalHeight);
  const configuredLimit = normalizeHeight(
    options.mode === "smart" ? options.smartCollapseHeight : options.previewHeight,
  );
  const densityLimit =
    options.densityLimit === null || options.densityLimit === undefined
      ? configuredLimit
      : normalizeHeight(options.densityLimit);
  const limit = Math.min(configuredLimit, densityLimit);
  const clipped = naturalHeight > limit + CONTENT_HEIGHT_TOLERANCE;
  return { clipped, maxHeight: clipped ? limit : null };
}

/** A small measurement tolerance prevents observer rounding from re-rendering forever. */
export function cardHeightChangeNeedsReflow(
  previousHeight: number,
  nextHeight: number,
  tolerance = 3,
): boolean {
  if (!Number.isFinite(previousHeight) || !Number.isFinite(nextHeight)) return true;
  return Math.abs(previousHeight - nextHeight) > Math.max(0, tolerance);
}

/**
 * Decide whether a ResizeObserver measurement is useful enough to drive a
 * layout pass. Obsidian temporarily gives inactive/full-screen-covered views
 * zero-sized boxes. Those measurements must not spend the renderer's bounded
 * reflow budget; a later non-zero container measurement performs recovery.
 */
export function timelineMeasurementNeedsReflow(measurement: TimelineReflowMeasurement): boolean {
  const { previousContainerWidth, containerWidth, cards } = measurement;
  if (!timelineMeasurementIsUsable(measurement)) return false;
  if (
    !Number.isFinite(previousContainerWidth) ||
    Math.abs(containerWidth - previousContainerWidth) > CONTENT_HEIGHT_TOLERANCE
  ) {
    return true;
  }
  return cards.some(
    ({ expectedHeight, measuredHeight }) =>
      expectedHeight !== undefined && cardHeightChangeNeedsReflow(expectedHeight, measuredHeight),
  );
}

/** Zero-sized card boxes mean Obsidian is currently hiding the owning leaf. */
export function timelineMeasurementIsUsable(
  measurement: Pick<TimelineReflowMeasurement, "containerWidth" | "cards">,
): boolean {
  if (
    !Number.isFinite(measurement.containerWidth) ||
    measurement.containerWidth <= CONTENT_HEIGHT_TOLERANCE
  ) {
    return false;
  }
  return (
    measurement.cards.length === 0 ||
    measurement.cards.some(
      ({ measuredHeight }) =>
        Number.isFinite(measuredHeight) && measuredHeight > CONTENT_HEIGHT_TOLERANCE,
    )
  );
}

/** Restore an in-view timeline position after its DOM is rebuilt and briefly empty. */
export function clampTimelineScrollTop(
  previousScrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const requested = Number.isFinite(previousScrollTop) ? Math.max(0, previousScrollTop) : 0;
  const available =
    Number.isFinite(scrollHeight) && Number.isFinite(clientHeight)
      ? Math.max(0, scrollHeight - clientHeight)
      : 0;
  return Math.min(requested, available);
}

/**
 * Real-time mode can contain hours of intentionally empty space before the
 * first record. On a fresh render, keep a small amount of temporal context
 * above that first node instead of presenting an apparently blank viewport.
 */
export function resolveInitialTimelineScrollTop(
  mode: "elastic" | "realtime",
  firstNodeY: number | undefined,
  scrollHeight: number,
  clientHeight: number,
  contextAbove = 96,
): number {
  if (mode !== "realtime" || firstNodeY === undefined || !Number.isFinite(firstNodeY)) return 0;
  return clampTimelineScrollTop(firstNodeY - Math.max(0, contextAbove), scrollHeight, clientHeight);
}

/**
 * Resolve the height that Elastic layout must reserve for a rendered card.
 * Obsidian themes can let list markers or late Markdown post-processors extend
 * the scroll box without immediately enlarging the border box. Reserving the
 * larger value prevents the following absolute-positioned card from covering
 * that content.
 */
export function resolveTimelineCardMeasuredHeight(
  borderBoxHeight: number,
  scrollBoxHeight: number,
  paintedContentHeight?: number,
): number | undefined {
  const candidates = [borderBoxHeight, scrollBoxHeight, paintedContentHeight].filter(
    (height): height is number =>
      height !== undefined && Number.isFinite(height) && height > CONTENT_HEIGHT_TOLERANCE,
  );
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

/** Build an Obsidian block link whose identity remains stable across time edits. */
export function buildStableBlockReference(sourcePath: string, entryId: string): string {
  const notePath = sourcePath.replace(/\.md$/iu, "");
  return `[[${notePath}#^${entryId}]]`;
}

function normalizeHeight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
