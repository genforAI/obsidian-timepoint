import {
  TIMEPOINT_VIEW_STATE_SCHEMA_VERSION,
  type TimePointDayViewState,
  type TimePointReferenceCardState,
  type TimelineMode,
  type TimelineViewportState,
} from "../model/types";

export const VIEW_STATE_START = "<!-- timepoint:view-state";
export const VIEW_STATE_END = "-->";

const VIEW_STATE_PATTERN = /<!-- timepoint:view-state\r?\n([\s\S]*?)\r?\n-->[ \t]*(?:\r?\n)?/gu;

export interface ParsedDayViewState {
  state: TimePointDayViewState;
  rawBlock?: string;
  status: "missing" | "valid" | "invalid" | "future";
  warning?: string;
}

export function defaultTimelineViewportState(): TimelineViewportState {
  return { zoom: 1, centerX: 0.5, centerY: 0, verticalScale: 1 };
}

export function defaultDayViewState(): TimePointDayViewState {
  return {
    schemaVersion: TIMEPOINT_VIEW_STATE_SCHEMA_VERSION,
    modes: {
      elastic: defaultTimelineViewportState(),
      realtime: defaultTimelineViewportState(),
    },
    minimapExpanded: true,
    relationsEnabled: false,
    stackOrder: [],
    referenceCards: {},
  };
}

export function parseDayViewState(markdown: string): ParsedDayViewState {
  const matches = [...markdown.matchAll(VIEW_STATE_PATTERN)];
  if (matches.length === 0) return { state: defaultDayViewState(), status: "missing" };
  if (matches.length > 1) {
    return {
      state: defaultDayViewState(),
      rawBlock: matches[0]?.[0],
      status: "invalid",
      warning: "Multiple timepoint:view-state blocks were ignored.",
    };
  }
  const match = matches[0];
  const rawBlock = match?.[0];
  const json = match?.[1];
  if (!rawBlock || json === undefined || json.includes("-->")) {
    return {
      state: defaultDayViewState(),
      ...(rawBlock ? { rawBlock } : {}),
      status: "invalid",
      warning: "The timepoint:view-state block is malformed and was ignored.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return {
      state: defaultDayViewState(),
      rawBlock,
      status: "invalid",
      warning: "The timepoint:view-state JSON is invalid and was ignored.",
    };
  }
  if (
    isRecord(parsed) &&
    finiteNumber(parsed.schemaVersion) > TIMEPOINT_VIEW_STATE_SCHEMA_VERSION
  ) {
    return {
      state: defaultDayViewState(),
      rawBlock,
      status: "future",
      warning:
        "A newer timepoint:view-state schema was preserved but its display settings were ignored.",
    };
  }
  const state = sanitizeDayViewState(parsed);
  return state
    ? { state, rawBlock, status: "valid" }
    : {
        state: defaultDayViewState(),
        rawBlock,
        status: "invalid",
        warning: "Unsafe timepoint:view-state values were ignored.",
      };
}

export function sanitizeDayViewState(value: unknown): TimePointDayViewState | null {
  if (!isRecord(value) || value.schemaVersion !== TIMEPOINT_VIEW_STATE_SCHEMA_VERSION) return null;
  if (!isRecord(value.modes)) return null;
  const elastic = sanitizeViewport(value.modes.elastic);
  const realtime = sanitizeViewport(value.modes.realtime);
  if (!elastic || !realtime) return null;
  if (
    typeof value.minimapExpanded !== "boolean" ||
    typeof value.relationsEnabled !== "boolean" ||
    !Array.isArray(value.stackOrder) ||
    !isRecord(value.referenceCards)
  ) {
    return null;
  }
  const stackOrder = [...new Set(value.stackOrder.filter(isSafeId))].slice(0, 500);
  const referenceCards: Record<string, TimePointReferenceCardState> = {};
  for (const [id, raw] of Object.entries(value.referenceCards).slice(0, 50)) {
    if (!isSafeId(id)) continue;
    const card = sanitizeReferenceCard(id, raw);
    if (card) referenceCards[id] = card;
  }
  return {
    schemaVersion: TIMEPOINT_VIEW_STATE_SCHEMA_VERSION,
    modes: { elastic, realtime },
    minimapExpanded: value.minimapExpanded,
    relationsEnabled: value.relationsEnabled,
    stackOrder,
    referenceCards,
  };
}

export function serializeDayViewStateBlock(state: TimePointDayViewState): string {
  const safe = sanitizeDayViewState(state);
  if (!safe) throw new Error("Cannot serialize an invalid TimePoint day view state.");
  return `${VIEW_STATE_START}\n${JSON.stringify(safe, null, 2)}\n${VIEW_STATE_END}`;
}

/** Replace one managed state block without touching user-authored index content. */
export function upsertDayViewState(markdown: string, state: TimePointDayViewState): string {
  const block = serializeDayViewStateBlock(state);
  const matches = [...markdown.matchAll(VIEW_STATE_PATTERN)];
  if (matches.length > 1)
    throw new Error("Multiple timepoint:view-state blocks prevent a safe write.");
  if (matches.length === 1) {
    const match = matches[0];
    if (match?.index === undefined) throw new Error("Cannot locate timepoint:view-state block.");
    return `${markdown.slice(0, match.index)}${block}\n${markdown.slice(match.index + match[0].length)}`;
  }
  const separator =
    markdown.length === 0 || markdown.endsWith("\n\n")
      ? ""
      : markdown.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${markdown}${separator}${block}\n`;
}

export function updateViewportState(
  state: TimePointDayViewState,
  mode: TimelineMode,
  viewport: TimelineViewportState,
): TimePointDayViewState {
  const next = structuredCloneState(state);
  const safe = sanitizeViewport(viewport);
  if (!safe) throw new Error("Invalid TimePoint viewport state.");
  next.modes[mode] = safe;
  return next;
}

function sanitizeViewport(value: unknown): TimelineViewportState | null {
  if (!isRecord(value)) return null;
  const zoom = finiteNumber(value.zoom);
  const centerX = finiteNumber(value.centerX);
  const centerY = finiteNumber(value.centerY);
  const verticalScale = value.verticalScale === undefined ? 1 : finiteNumber(value.verticalScale);
  if (
    !Number.isFinite(zoom) ||
    !Number.isFinite(centerX) ||
    !Number.isFinite(centerY) ||
    !Number.isFinite(verticalScale)
  )
    return null;
  return {
    zoom: round(clamp(zoom, 0.5, 3), 4),
    centerX: round(clamp(centerX, 0, 1), 6),
    centerY: round(clamp(centerY, 0, 1), 6),
    verticalScale: round(clamp(verticalScale, 0.4, 4), 4),
  };
}

function sanitizeReferenceCard(id: string, value: unknown): TimePointReferenceCardState | null {
  if (!isRecord(value) || value.id !== id || !isReferenceKind(value.kind)) return null;
  if (typeof value.target !== "string" || value.target.length === 0 || value.target.length > 4096) {
    return null;
  }
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (![x, y, width, height].every(Number.isFinite) || typeof value.expanded !== "boolean") {
    return null;
  }
  return {
    id,
    kind: value.kind,
    target: value.target,
    x: round(clamp(x, 0, 1), 6),
    y: round(clamp(y, 0, 1), 6),
    width: round(clamp(width, 0.2, 1), 6),
    height: round(clamp(height, 72, 720), 2),
    expanded: value.expanded,
  };
}

function structuredCloneState(state: TimePointDayViewState): TimePointDayViewState {
  return {
    ...state,
    modes: { elastic: { ...state.modes.elastic }, realtime: { ...state.modes.realtime } },
    stackOrder: [...state.stackOrder],
    referenceCards: Object.fromEntries(
      Object.entries(state.referenceCards).map(([id, card]) => [id, { ...card }]),
    ),
  };
}

function isReferenceKind(value: unknown): value is TimePointReferenceCardState["kind"] {
  return value === "local-note" || value === "day-entry" || value === "external-url";
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,255}$/u.test(value);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
