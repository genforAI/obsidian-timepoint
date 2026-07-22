import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import {
  MAX_RELATION_CARDS,
  MAX_RELATION_EDGES,
  RelationService,
  createsCycle,
  stableReferenceId,
} from "../src/relations/RelationService";
import { extractMarkdownLinks, normalizeExternalUrl } from "../src/relations/markdownLinks";
import { defaultDayViewState } from "../src/storage/DayViewState";
import { createTimePointEntry } from "../src/storage/TimePointSerializer";

describe("relationship link extraction", () => {
  it("extracts Wiki, Markdown, embed, and HTTPS targets while ignoring code", () => {
    const markdown = [
      "[[Local note]] and ![[Image note|preview]]",
      "[cross day](../Days/2026-07-20/entry.md#heading)",
      "[website](https://Example.com/a?utm_source=x&b=2#part)",
      "<https://example.net/path>",
      "https://example.org/bare.",
      "`[[ignored inline]]`",
      "```markdown",
      "[ignored](https://ignored.example.com)",
      "```",
    ].join("\n");
    expect(extractMarkdownLinks(markdown)).toEqual([
      { target: "Local note", kind: "internal", embedded: false },
      { target: "Image note", kind: "internal", embedded: true },
      {
        target: "../Days/2026-07-20/entry.md#heading",
        kind: "internal",
        embedded: false,
      },
      { target: "https://example.com/a?b=2", kind: "external", embedded: false },
      { target: "https://example.net/path", kind: "external", embedded: false },
      { target: "https://example.org/bare", kind: "external", embedded: false },
    ]);
  });

  it("normalizes equivalent external URLs for deduplication", () => {
    expect(normalizeExternalUrl("https://EXAMPLE.com:443/a?gclid=x&z=2#a")).toBe(
      "https://example.com/a?z=2",
    );
    expect(normalizeExternalUrl("http://example.com")).toBeNull();
    expect(normalizeExternalUrl("https://user@example.com")).toBeNull();
  });
});

describe("bounded relationship graph helpers", () => {
  it("detects direct and transitive cycles", () => {
    const edges = [
      { fromId: "a", toId: "b" },
      { fromId: "b", toId: "c" },
    ];
    expect(createsCycle(edges, "c", "a")).toBe(true);
    expect(createsCycle(edges, "c", "d")).toBe(false);
    expect(createsCycle(edges, "a", "a")).toBe(true);
  });

  it("produces deterministic, compact reference IDs", () => {
    expect(stableReferenceId("TimePoint/Note.md")).toBe(stableReferenceId("TimePoint/Note.md"));
    expect(stableReferenceId("TimePoint/Note.md")).not.toBe(stableReferenceId("timepoint/note.md"));
    expect(stableReferenceId("https://example.com")).toMatch(/^[a-z0-9]{7}$/u);
  });

  it("deduplicates direct links, rejects cycles, and caps reference cards", async () => {
    const first = createTimePointEntry({
      id: "tp-a",
      date: "2026-07-21",
      time: "08:00",
      contentMarkdown: `[[Second]]\n${Array.from(
        { length: MAX_RELATION_CARDS + 8 },
        (_, index) => `https://site-${index}.example.org/page`,
      ).join("\n")}`,
    });
    const second = createTimePointEntry({
      id: "tp-b",
      date: "2026-07-21",
      time: "09:00",
      contentMarkdown: "[[First]]",
    });
    const firstFile = fakeFile("TimePoint/Days/2026/07/2026-07-21/0800--tp-a.md");
    const secondFile = fakeFile("TimePoint/Days/2026/07/2026-07-21/0900--tp-b.md");
    const files = new Map([
      ["First", firstFile],
      ["Second", secondFile],
    ]);
    const app = {
      metadataCache: {
        getFirstLinkpathDest: (link: string) => files.get(link) ?? null,
        getFileCache: () => null,
      },
      vault: {
        getAbstractFileByPath: () => null,
        cachedRead: async () => "",
      },
    } as unknown as App;
    const paths = new Map([
      [first.id, firstFile.path],
      [second.id, secondFile.path],
    ]);
    const service = new RelationService(app, {
      getEntrySourcePath: (entry: { id: string }) => paths.get(entry.id) ?? "",
    } as never);
    const graph = await service.buildDayGraph([first, second], defaultDayViewState());
    expect(graph.cards).toHaveLength(MAX_RELATION_CARDS);
    expect(graph.truncatedCards).toBe(8);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ fromId: "tp-a", toId: "tp-b", kind: "timepoint" }),
    );
    expect(graph.cycles).toContain("timepoint:tp-b->tp-a");
  });

  it("continues through only the reference cards the user explicitly expanded", async () => {
    const entry = createTimePointEntry({
      id: "tp-root",
      date: "2026-07-21",
      time: "08:00",
      contentMarkdown: "[[First hop]]",
    });
    const first = fakeFile("Notes/First hop.md");
    const second = fakeFile("Notes/Second hop.md");
    const third = fakeFile("Notes/Third hop.md");
    const files = new Map([
      ["First hop", first],
      ["Second hop", second],
      ["Third hop", third],
    ]);
    const markdown = new Map([
      [first.path, "[[Second hop]]"],
      [second.path, "[[Third hop]]"],
      [third.path, "[[First hop]]"],
    ]);
    const app = {
      metadataCache: {
        getFirstLinkpathDest: (link: string) => files.get(link) ?? null,
        getFileCache: () => null,
      },
      vault: {
        getAbstractFileByPath: (path: string) =>
          [...files.values()].find((file) => file.path === path) ?? null,
        cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
      },
    } as unknown as App;
    const state = defaultDayViewState();
    for (const file of [first, second, third]) {
      const id = `ref-note-${stableReferenceId(file.path)}`;
      state.referenceCards[id] = {
        id,
        kind: "local-note",
        target: file.path,
        x: 0.5,
        y: 0.5,
        width: 0.3,
        height: 120,
        expanded: true,
      };
    }
    const service = new RelationService(app, {
      getEntrySourcePath: () => "TimePoint/root.md",
    } as never);
    const graph = await service.buildDayGraph([entry], state);

    expect(new Set(graph.cards.map((card) => card.target))).toEqual(
      new Set([first.path, second.path, third.path]),
    );
    expect(graph.cycles).toContain(
      `local:ref-note-${stableReferenceId(third.path)}->ref-note-${stableReferenceId(first.path)}`,
    );
  });

  it("caps a large same-day relationship fan-in at 100 deterministic edges", async () => {
    const target = createTimePointEntry({
      id: "tp-target",
      date: "2026-07-21",
      time: "23:59",
      contentMarkdown: "Target",
    });
    const sources = Array.from({ length: MAX_RELATION_EDGES + 7 }, (_, index) =>
      createTimePointEntry({
        id: `tp-source-${index}`,
        date: "2026-07-21",
        time: `${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
        contentMarkdown: "[[Target]]",
      }),
    );
    const targetFile = fakeFile("TimePoint/Days/2026/07/2026-07-21/2359--tp-target.md");
    const paths = new Map<string, string>([
      [target.id, targetFile.path],
      ...sources.map(
        (entry) =>
          [
            entry.id,
            `TimePoint/Days/2026/07/2026-07-21/${entry.time.replace(":", "")}--${entry.id}.md`,
          ] as const,
      ),
    ]);
    const app = {
      metadataCache: {
        getFirstLinkpathDest: (link: string) => (link === "Target" ? targetFile : null),
        getFileCache: () => null,
      },
      vault: { getAbstractFileByPath: () => null, cachedRead: async () => "" },
    } as unknown as App;
    const service = new RelationService(app, {
      getEntrySourcePath: (entry: { id: string }) => paths.get(entry.id) ?? "",
    } as never);

    const graph = await service.buildDayGraph([...sources, target], defaultDayViewState());
    expect(graph.edges).toHaveLength(MAX_RELATION_EDGES);
    expect(graph.truncatedEdges).toBe(7);
    expect(graph.cards).toEqual([]);
  });
});

function fakeFile(path: string): TFile {
  const name = path.split("/").at(-1) ?? path;
  return {
    path,
    name,
    basename: name.replace(/\.md$/u, ""),
    extension: "md",
  } as TFile;
}
