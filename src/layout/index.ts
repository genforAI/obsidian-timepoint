export * from "./layoutTypes";
export * from "./ElasticTimelineLayout";
export * from "./RealtimeTimelineLayout";
export * from "./CanvasCardLayout";

import { calculateElasticTimelineLayout } from "./ElasticTimelineLayout";
import { calculateRealtimeTimelineLayout } from "./RealtimeTimelineLayout";
import type {
  LayoutEntryInput,
  TimelineLayoutMode,
  TimelineLayoutOptions,
  TimelineLayoutResult,
} from "./layoutTypes";

export function calculateTimelineLayout(
  mode: TimelineLayoutMode,
  entries: readonly LayoutEntryInput[],
  options: TimelineLayoutOptions = {},
): TimelineLayoutResult {
  return mode === "elastic"
    ? calculateElasticTimelineLayout(entries, options)
    : calculateRealtimeTimelineLayout(entries, options);
}
