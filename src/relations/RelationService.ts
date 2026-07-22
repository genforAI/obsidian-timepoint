import type { App, TAbstractFile, TFile } from "obsidian";
import type {
  TimePointDayViewState,
  TimePointEntry,
  TimePointRelationCard,
  TimePointRelationEdge,
  TimePointRelationGraph,
} from "../model/types";
import type { DayFileRepository } from "../storage";
import { extractMarkdownLinks, type ExtractedMarkdownLink } from "./markdownLinks";

export const MAX_RELATION_CARDS = 50;
export const MAX_RELATION_EDGES = 100;

export class RelationService {
  constructor(
    private readonly app: App,
    private readonly repository: DayFileRepository,
  ) {}

  async buildDayGraph(
    entries: readonly TimePointEntry[],
    viewState: TimePointDayViewState,
  ): Promise<TimePointRelationGraph> {
    const cards = new Map<string, TimePointRelationCard>();
    const edges: TimePointRelationEdge[] = [];
    const cycles: string[] = [];
    const sourcePathByEntryId = new Map(
      entries.map((entry) => [entry.id, this.repository.getEntrySourcePath(entry)]),
    );
    const entryIdByPath = new Map(
      [...sourcePathByEntryId].map(([entryId, path]) => [path, entryId]),
    );
    let truncatedCards = 0;
    let truncatedEdges = 0;

    const addCard = (card: TimePointRelationCard): TimePointRelationCard | null => {
      const existing = cards.get(card.id);
      if (existing) {
        existing.sourceEntryIds = [
          ...new Set([...existing.sourceEntryIds, ...card.sourceEntryIds]),
        ];
        return existing;
      }
      if (cards.size >= MAX_RELATION_CARDS) {
        truncatedCards += 1;
        return null;
      }
      cards.set(card.id, { ...card, sourceEntryIds: [...new Set(card.sourceEntryIds)] });
      return cards.get(card.id) ?? null;
    };

    const addEdge = (edge: Omit<TimePointRelationEdge, "id">): void => {
      const id = `${edge.kind}:${edge.fromId}->${edge.toId}`;
      if (edges.some((candidate) => candidate.id === id)) return;
      if (edge.fromId === edge.toId || createsCycle(edges, edge.fromId, edge.toId)) {
        cycles.push(id);
        return;
      }
      if (edges.length >= MAX_RELATION_EDGES) {
        truncatedEdges += 1;
        return;
      }
      edges.push({ ...edge, id });
    };

    const resolveLink = async (
      fromId: string,
      sourceEntryIds: string[],
      sourcePath: string,
      link: ExtractedMarkdownLink,
    ): Promise<void> => {
      if (link.kind === "external") {
        const id = `ref-url-${stableReferenceId(link.target)}`;
        const card = addCard({
          id,
          kind: "external-url",
          target: link.target,
          title: safeHostname(link.target),
          description: link.target,
          sourceEntryIds,
        });
        if (card) addEdge({ fromId, toId: card.id, kind: "external" });
        return;
      }

      const targetText = stripSubpath(link.target);
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetText, sourcePath);
      if (!isFile(targetFile)) return;
      const sameDayEntryId = entryIdByPath.get(targetFile.path);
      if (sameDayEntryId) {
        addEdge({ fromId, toId: sameDayEntryId, kind: "timepoint" });
        return;
      }
      const cache = this.app.metadataCache.getFileCache(targetFile);
      const frontmatter = cache?.frontmatter;
      const targetEntryId = stringValue(frontmatter?.id);
      const targetDate = stringValue(frontmatter?.date);
      const isTimePoint = Number(frontmatter?.["timepoint-entry-schema"]) === 1;
      const id = `${isTimePoint ? "ref-day" : "ref-note"}-${stableReferenceId(targetFile.path)}`;
      const card = addCard({
        id,
        kind: isTimePoint ? "day-entry" : "local-note",
        target: targetFile.path,
        title: stringValue(frontmatter?.title) || targetFile.basename,
        ...(stringValue(frontmatter?.description)
          ? { description: stringValue(frontmatter?.description) }
          : {}),
        sourceEntryIds,
        ...(targetEntryId ? { targetEntryId } : {}),
        ...(targetDate ? { targetDate } : {}),
      });
      if (card) addEdge({ fromId, toId: card.id, kind: isTimePoint ? "timepoint" : "local" });
    };

    for (const entry of entries) {
      const sourcePath = sourcePathByEntryId.get(entry.id) ?? "";
      for (const link of extractMarkdownLinks(entry.contentMarkdown)) {
        await resolveLink(entry.id, [entry.id], sourcePath, link);
      }
    }

    // Only cards explicitly expanded by the user contribute one additional
    // level. Repeated expansion is bounded by the global card/edge limits and
    // cycle detection, so a linked-note loop cannot grow without limit.
    const expandedQueue = [...cards.values()].filter(
      (card) =>
        card.kind !== "external-url" && viewState.referenceCards[card.id]?.expanded === true,
    );
    const queuedIds = new Set(expandedQueue.map((card) => card.id));
    const expandedTargets = new Set<string>();
    for (let cursor = 0; cursor < expandedQueue.length; cursor += 1) {
      const card = expandedQueue[cursor];
      if (!card) continue;
      if (expandedTargets.has(card.target)) continue;
      expandedTargets.add(card.target);
      const file = this.app.vault.getAbstractFileByPath(card.target);
      if (!isFile(file)) continue;
      const markdown = await this.app.vault.cachedRead(file);
      for (const link of extractMarkdownLinks(markdown)) {
        await resolveLink(card.id, card.sourceEntryIds, file.path, link);
      }
      for (const candidate of cards.values()) {
        if (
          candidate.kind !== "external-url" &&
          viewState.referenceCards[candidate.id]?.expanded === true &&
          !queuedIds.has(candidate.id)
        ) {
          queuedIds.add(candidate.id);
          expandedQueue.push(candidate);
        }
      }
    }

    return {
      cards: [...cards.values()].sort((left, right) => left.id.localeCompare(right.id)),
      edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
      truncatedCards,
      truncatedEdges,
      cycles: [...new Set(cycles)].sort(),
    };
  }
}

export function createsCycle(
  edges: readonly Pick<TimePointRelationEdge, "fromId" | "toId">[],
  fromId: string,
  toId: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.fromId) ?? [];
    targets.push(edge.toId);
    adjacency.set(edge.fromId, targets);
  }
  const queue = [toId];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    if (current === fromId) return true;
    visited.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function stableReferenceId(value: string): string {
  // FNV-1a is used only for stable DOM/index IDs; snapshot security IDs use SHA-256.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function stripSubpath(target: string): string {
  return target.split(/[#^]/u, 1)[0]?.trim() ?? target;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 120);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 600) : "";
}

function isFile(file: TAbstractFile | null): file is TFile {
  return Boolean(file && "extension" in file && typeof file.extension === "string");
}
