import type { ResizeHandle, TimePointCardLayout } from "../model/types";
import {
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  createCardLayout,
} from "../storage/CardLayoutMetadata";

export interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolvedCardGeometry extends CanvasRect {
  manual: boolean;
}

export interface ConnectorRouteInput {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  corridorX: number;
  obstacles: readonly CanvasRect[];
  clearance?: number;
}

export interface CardOverlapItem {
  id: string;
  rect: CanvasRect;
}

/**
 * Return deterministic groups where one card visibly covers another.
 *
 * A deliberately low default is important for resized cards: two wide cards
 * can produce an unreadable double layer while only sharing a small part of
 * their height. Cards that merely touch still have a ratio of zero.
 */
export function findCardOverlapGroups(
  items: readonly CardOverlapItem[],
  minimumCoveredRatio = 0.12,
): string[][] {
  const parents = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root] ?? root;
    while (parents[index] !== index) {
      const next = parents[index] ?? index;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot)
      parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  for (let left = 0; left < items.length; left += 1) {
    const leftItem = items[left];
    if (!leftItem) continue;
    for (let right = left + 1; right < items.length; right += 1) {
      const rightItem = items[right];
      if (!rightItem) continue;
      if (coveredRatio(leftItem.rect, rightItem.rect) >= minimumCoveredRatio) union(left, right);
    }
  }
  const groups = new Map<number, string[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(item.id);
    groups.set(root, group);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort((left, right) => left.localeCompare(right)))
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

export function resolveStoredCardGeometry(
  layout: TimePointCardLayout,
  bounds: CanvasBounds,
  zoom: number,
): ResolvedCardGeometry {
  const width = clamp(layout.width * bounds.width, MIN_CARD_WIDTH * bounds.width, bounds.width);
  const height = clamp(layout.height * zoom, MIN_CARD_HEIGHT * zoom, MAX_CARD_HEIGHT * zoom);
  const centreX = bounds.left + layout.x * bounds.width;
  const centreY = bounds.top + layout.y * bounds.height;
  return {
    ...clampRect({ x: centreX - width / 2, y: centreY - height / 2, width, height }, bounds, true),
    manual: true,
  };
}

export function freezeCardGeometry(
  rect: CanvasRect,
  bounds: CanvasBounds,
  zoom: number,
  updatedAt?: string,
): TimePointCardLayout {
  const safe = clampRect(rect, bounds, true);
  return createCardLayout({
    x: (safe.x + safe.width / 2 - bounds.left) / Math.max(1, bounds.width),
    y: (safe.y + safe.height / 2 - bounds.top) / Math.max(1, bounds.height),
    width: safe.width / Math.max(1, bounds.width),
    height: safe.height / Math.max(0.5, zoom),
    ...(updatedAt ? { updatedAt } : {}),
  });
}

export function moveCardRect(
  start: CanvasRect,
  deltaX: number,
  deltaY: number,
  bounds: CanvasBounds,
): CanvasRect {
  return clampRect({ ...start, x: start.x + deltaX, y: start.y + deltaY }, bounds, true);
}

export function resizeCardRect(
  start: CanvasRect,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  bounds: CanvasBounds,
  zoom: number,
): CanvasRect {
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;
  if (handle.includes("w")) left += deltaX;
  if (handle.includes("e")) right += deltaX;
  if (handle.includes("n")) top += deltaY;
  if (handle.includes("s")) bottom += deltaY;

  const minimumWidth = Math.min(bounds.width, MIN_CARD_WIDTH * bounds.width);
  const minimumHeight = MIN_CARD_HEIGHT * zoom;
  const maximumHeight = Math.min(bounds.height, MAX_CARD_HEIGHT * zoom);
  if (right - left < minimumWidth) {
    if (handle.includes("w")) left = right - minimumWidth;
    else right = left + minimumWidth;
  }
  if (top > bottom - minimumHeight) {
    if (handle.includes("n")) top = bottom - minimumHeight;
    else bottom = top + minimumHeight;
  }
  if (bottom - top > maximumHeight) {
    if (handle.includes("n")) top = bottom - maximumHeight;
    else bottom = top + maximumHeight;
  }
  return clampRect({ x: left, y: top, width: right - left, height: bottom - top }, bounds, true);
}

/** Manual cards are fixed obstacles; automatic cards move down deterministically. */
export function avoidManualCardObstacles(
  automatic: readonly CanvasRect[],
  manual: readonly CanvasRect[],
  bounds: CanvasBounds,
  gap: number,
  maximumAutomaticGap = Number.POSITIVE_INFINITY,
): CanvasRect[] {
  const placed: CanvasRect[] = [];
  for (const initial of automatic) {
    let candidate = { ...initial };
    const previous = placed.at(-1);
    if (previous && Number.isFinite(maximumAutomaticGap)) {
      candidate.y = Math.min(
        candidate.y,
        previous.y + previous.height + Math.max(gap, maximumAutomaticGap),
      );
    }
    const obstacles = [...manual, ...placed]
      .filter((rect) => horizontalOverlap(candidate, rect, gap))
      .sort((left, right) => left.y - right.y || left.x - right.x);
    // A forward sweep is enough because cards only move down. Rechecking the
    // current obstacle after a move also handles tall cards spanning several
    // compact rows without repeatedly allocating or scanning every rectangle.
    for (let index = 0; index < obstacles.length; index += 1) {
      const obstacle = obstacles[index];
      if (!obstacle || !rectanglesOverlap(candidate, obstacle, gap)) continue;
      candidate.y = obstacle.y + obstacle.height + gap;
    }
    placed.push(clampRect(candidate, bounds, false));
  }
  return placed;
}

/**
 * Route through the axis/card corridor. If the final horizontal landing is
 * obstructed, choose the nearest clear Y. The SVG remains below all cards.
 */
export function routeTimelineConnector(input: ConnectorRouteInput): string {
  const clearance = input.clearance ?? 8;
  let landingY = input.endY;
  const crossing = input.obstacles
    .filter(
      (rect) =>
        input.endX >= rect.x - clearance &&
        input.corridorX <= rect.x + rect.width + clearance &&
        landingY >= rect.y - clearance &&
        landingY <= rect.y + rect.height + clearance,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x);
  for (const obstacle of crossing) {
    const above = obstacle.y - clearance;
    const below = obstacle.y + obstacle.height + clearance;
    landingY = Math.abs(landingY - above) <= Math.abs(landingY - below) ? above : below;
  }
  const startControlX = input.startX + (input.corridorX - input.startX) * 0.65;
  return [
    `M ${round(input.startX)} ${round(input.startY)}`,
    `C ${round(startControlX)} ${round(input.startY)}, ${round(input.corridorX)} ${round(input.startY)}, ${round(input.corridorX)} ${round(input.startY)}`,
    `L ${round(input.corridorX)} ${round(landingY)}`,
    `C ${round(input.corridorX)} ${round(landingY)}, ${round(input.endX - 18)} ${round(landingY)}, ${round(input.endX)} ${round(input.endY)}`,
  ].join(" ");
}

export function clampRect(
  rect: CanvasRect,
  bounds: CanvasBounds,
  clampVertical: boolean,
): CanvasRect {
  const width = clamp(
    rect.width,
    Math.min(bounds.width, MIN_CARD_WIDTH * bounds.width),
    bounds.width,
  );
  const height = clamp(rect.height, 1, Math.max(1, bounds.height));
  const x = clamp(rect.x, bounds.left, bounds.left + Math.max(0, bounds.width - width));
  const y = clampVertical
    ? clamp(rect.y, bounds.top, bounds.top + Math.max(0, bounds.height - height))
    : Math.max(bounds.top, rect.y);
  return { x, y, width, height };
}

export function rectanglesOverlap(left: CanvasRect, right: CanvasRect, gap = 0): boolean {
  return (
    left.x < right.x + right.width + gap &&
    left.x + left.width + gap > right.x &&
    left.y < right.y + right.height + gap &&
    left.y + left.height + gap > right.y
  );
}

function horizontalOverlap(left: CanvasRect, right: CanvasRect, gap: number): boolean {
  return left.x < right.x + right.width + gap && left.x + left.width + gap > right.x;
}

function coveredRatio(left: CanvasRect, right: CanvasRect): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  if (smallerArea <= 0) return 0;
  return (intersectionWidth * intersectionHeight) / smallerArea;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
