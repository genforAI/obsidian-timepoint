import type { TAbstractFile, TFile, Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { DayFileRepository, normalizeStorageFolder } from "../src/storage/DayFileRepository";
import { planLegacyDayRepair } from "../src/storage/LegacyRepair";
import {
  parseStandaloneEntry,
  serializeDayIndex,
  serializeStandaloneEntry,
  updateStandaloneEntryMarkdown,
} from "../src/storage/StandaloneEntryFile";
import { parseDayFile } from "../src/storage/TimePointParser";
import {
  StorageMutationError,
  addEntryToMarkdown,
  createEntryMutationExpectation,
  createTimePointEntry,
  deleteEntryFromMarkdown,
  serializeDayFile,
  serializeEntry,
  updateEntryInMarkdown,
} from "../src/storage/TimePointSerializer";

function entry(overrides: Partial<ReturnType<typeof createTimePointEntry>> = {}) {
  return {
    ...createTimePointEntry({
      id: "tp-entry-a1",
      date: "2026-07-18",
      time: "08:15",
      contentMarkdown: "Original body",
      tags: [],
      createdAt: "2026-07-18T08:15:00Z",
      updatedAt: "2026-07-18T08:15:00Z",
    }),
    ...overrides,
  };
}

describe("pure conflict-conscious mutations", () => {
  it("adds without rewriting unrelated Markdown", () => {
    const original = `${serializeDayFile("2026-07-18", "UTC")}\n## Manual section\nDo not touch this.\n`;
    const result = addEntryToMarkdown(original, entry());
    expect(result.startsWith(original)).toBe(true);
    expect(result).toContain("Original body");
    expect(() => addEntryToMarkdown(result, entry())).toThrow(StorageMutationError);
  });

  it("updates only the matching bounded block", () => {
    const before = "Manual text before\n\n";
    const after = "\n\nManual text after — 保留\n";
    const original = `${before}${serializeEntry(entry())}${after}`;
    const changed = entry({
      time: "09:30",
      minuteOfDay: 570,
      contentMarkdown: "Changed body",
      updatedAt: "2026-07-18T09:30:00Z",
    });
    const result = updateEntryInMarkdown(original, changed, {
      expectedUpdatedAt: "2026-07-18T08:15:00Z",
      expectedContentMarkdown: "Original body",
      expectedTime: "08:15",
    });
    expect(result.startsWith(before)).toBe(true);
    expect(result.endsWith(after)).toBe(true);
    expect(result).toContain("Changed body");
    expect(result).not.toContain("Original body");
  });

  it("rejects stale edits inside the target entry", () => {
    const manuallyChanged = serializeEntry(entry({ contentMarkdown: "Manual sync edit" }));
    expect(() =>
      updateEntryInMarkdown(manuallyChanged, entry({ contentMarkdown: "UI edit" }), {
        expectedContentMarkdown: "Original body",
      }),
    ).toThrow(/content mismatch/);
  });

  it("rejects metadata-only and unknown-field races using the opened block snapshot", () => {
    const originalMarkdown = serializeDayFile("2026-07-18", "UTC", [entry()]);
    const opened = parseDayFile(originalMarkdown, { expectedDate: "2026-07-18" }).entries[0];
    expect(opened).toBeDefined();
    if (!opened) return;
    const externalEdit = originalMarkdown
      .replace('"createdAt": "2026-07-18T08:15:00.000Z"', '"createdAt": "2026-07-18T07:00:00Z"')
      .replace('"source": "manual"', '"source": "sync",\n  "futureOwnedNote": "preserve me"');
    const uiEdit = entry({
      contentMarkdown: "UI edit",
      updatedAt: "2026-07-18T09:00:00Z",
    });

    for (const mutate of [
      () => updateEntryInMarkdown(externalEdit, uiEdit, createEntryMutationExpectation(opened)),
      () =>
        deleteEntryFromMarkdown(
          externalEdit,
          opened.date,
          opened.id,
          createEntryMutationExpectation(opened),
        ),
    ]) {
      expect(mutate).toThrow(
        /changed inside its managed block|unknown metadata .*refusing to modify/i,
      );
    }
    expect(externalEdit).toContain('"futureOwnedNote": "preserve me"');
  });

  it("fails closed when unknown metadata already existed before the entry was opened", () => {
    const extended = serializeDayFile("2026-07-18", "UTC", [entry()]).replace(
      '"tags": []',
      '"userExtension": { "mustSurvive": true },\n  "tags": []',
    );
    const opened = parseDayFile(extended, { expectedDate: "2026-07-18" }).entries[0];
    expect(opened).toBeDefined();
    if (!opened) return;

    for (const mutate of [
      () => addEntryToMarkdown(extended, entry({ id: "tp-entry-new" })),
      () =>
        updateEntryInMarkdown(
          extended,
          entry({ contentMarkdown: "UI edit", updatedAt: "2026-07-18T09:00:00Z" }),
          createEntryMutationExpectation(opened),
        ),
      () =>
        deleteEntryFromMarkdown(
          extended,
          opened.date,
          opened.id,
          createEntryMutationExpectation(opened),
        ),
    ]) {
      expect(mutate).toThrow(/unknown metadata userExtension.*refusing to modify/is);
    }
    expect(extended).toContain('"userExtension": { "mustSurvive": true }');
  });

  it("deletes only one bounded entry", () => {
    const first = entry();
    const second = entry({ id: "tp-entry-b2", time: "10:00", minuteOfDay: 600 });
    const original = `Manual header\n${serializeEntry(first)}\nKeep between\n${serializeEntry(second)}\nManual footer`;
    const result = deleteEntryFromMarkdown(original, first.date, first.id, {
      expectedContentMarkdown: first.contentMarkdown,
    });
    expect(result).toContain("Manual header");
    expect(result).toContain("Keep between");
    expect(result).toContain("Manual footer");
    expect(result).not.toContain(first.id);
    expect(result).toContain(second.id);
  });

  it("refuses ambiguous duplicate blocks and reserved markers", () => {
    const duplicate = `${serializeEntry(entry())}\n${serializeEntry(entry())}`;
    expect(() => updateEntryInMarkdown(duplicate, entry())).toThrow(/more than once/);
    expect(() =>
      createTimePointEntry({
        date: "2026-07-18",
        time: "12:00",
        contentMarkdown: '<!-- timepoint:entry:end id="collision" -->',
      }),
    ).toThrow(/reserved/);
  });

  it("rejects HTML comment terminators in hidden metadata strings", () => {
    for (const unsafe of [
      { timezone: "UTC --> forged" },
      { source: "import --> forged" },
      { tags: ["safe", "forged-->tag"] },
    ]) {
      expect(() =>
        createTimePointEntry({
          date: "2026-07-18",
          time: "12:00",
          contentMarkdown: "Safe body",
          ...unsafe,
        }),
      ).toThrow(/comment terminator/);
    }
  });

  it("does not add an ID already present in an unpaired marker", () => {
    const damaged = '<!-- timepoint:entry:start id="tp-entry-a1" -->\nmanual recovery text\n';
    expect(() => addEntryToMarkdown(damaged, entry())).toThrow(/already exists/);
  });

  it("fails closed for add, update, and delete against a future day schema", () => {
    const futureDay = serializeDayFile("2026-07-18", "UTC", [entry()]).replace(
      "timepoint-schema: 1",
      "timepoint-schema: 2",
    );

    for (const mutate of [
      () => addEntryToMarkdown(futureDay, entry({ id: "tp-entry-new" })),
      () => updateEntryInMarkdown(futureDay, entry({ contentMarkdown: "Unsafe update" })),
      () => deleteEntryFromMarkdown(futureDay, "2026-07-18", "tp-entry-a1"),
    ]) {
      try {
        mutate();
        throw new Error("Expected mutation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageMutationError);
        expect((error as StorageMutationError).code).toBe("UNSUPPORTED_SCHEMA");
        expect((error as Error).message).toMatch(/schema 2 is newer.*refusing to modify/i);
      }
    }
  });

  it("fails closed for every mutation when an entry uses a future schema", () => {
    const futureEntryDay = serializeDayFile("2026-07-18", "UTC", [entry()])
      .replace('"schemaVersion": 1', '"schemaVersion": 2')
      .replace('"tags": []', '"futureOwnedField": "must survive",\n  "tags": []');

    for (const mutate of [
      () => addEntryToMarkdown(futureEntryDay, entry({ id: "tp-entry-new" })),
      () => updateEntryInMarkdown(futureEntryDay, entry({ contentMarkdown: "Unsafe update" })),
      () => deleteEntryFromMarkdown(futureEntryDay, "2026-07-18", "tp-entry-a1"),
    ]) {
      try {
        mutate();
        throw new Error("Expected mutation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageMutationError);
        expect((error as StorageMutationError).code).toBe("UNSUPPORTED_SCHEMA");
        expect((error as Error).message).toMatch(/entry .*schema 2.*refusing to modify/is);
      }
    }

    expect(futureEntryDay).toContain('"futureOwnedField": "must survive"');
  });

  it("preserves CRLF style within a replaced block", () => {
    const original = serializeEntry(entry(), "\r\n");
    const result = updateEntryInMarkdown(
      original,
      entry({ contentMarkdown: "Line one\nLine two", updatedAt: "2026-07-18T09:00:00Z" }),
    );
    expect(result).toContain("Line one\r\nLine two");
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("DayFileRepository", () => {
  it("stores each event as a Markdown note and maintains a portable day index", async () => {
    const memoryVault = new MemoryVault();
    const repository = new DayFileRepository(memoryVault as unknown as Vault, {
      getStorageFolder: () => "Journal\\TimePoint/Days/",
      getTimezone: () => "UTC",
      trashFile: (file) => memoryVault.trash(file),
    });
    const original = entry();

    expect(repository.getDayPath("2026-07-18")).toBe(
      "Journal/TimePoint/Days/2026/07/2026-07-18.md",
    );
    await repository.addEntry(original);
    expect(memoryVault.createdFolders).toEqual([
      "Journal",
      "Journal/TimePoint",
      "Journal/TimePoint/Days",
      "Journal/TimePoint/Days/2026",
      "Journal/TimePoint/Days/2026/07",
      "Journal/TimePoint/Days/2026/07/2026-07-18",
    ]);
    expect(memoryVault.processCalls).toBe(1);
    expect(memoryVault.paths()).toContain("Journal/TimePoint/Days/2026/07/2026-07-18/_Timeline.md");
    expect(memoryVault.paths()).toContain(
      "Journal/TimePoint/Days/2026/07/2026-07-18/0815--tp-entry-a1.md",
    );

    await repository.updateEntry(
      entry({ contentMarkdown: "Updated", updatedAt: "2026-07-18T09:00:00Z" }),
      { expectedContentMarkdown: "Original body" },
    );
    expect((await repository.loadDay("2026-07-18")).entries[0]?.contentMarkdown).toBe("Updated");

    await repository.deleteEntry("2026-07-18", original.id, { expectedContentMarkdown: "Updated" });
    expect((await repository.loadDay("2026-07-18")).entries).toEqual([]);
    expect(memoryVault.processCalls).toBe(4);
    expect(memoryVault.trashedPaths).toEqual([
      "Journal/TimePoint/Days/2026/07/2026-07-18/0815--tp-entry-a1.md",
    ]);
  });

  it("rejects parent traversal and file/folder collisions", async () => {
    expect(() => normalizeStorageFolder("TimePoint/../Outside")).toThrow(/cannot contain/);
    const memoryVault = new MemoryVault();
    memoryVault.seedFile("TimePoint", "collision");
    const repository = new DayFileRepository(memoryVault as unknown as Vault, {
      getStorageFolder: () => "TimePoint/Days",
      trashFile: (file) => memoryVault.trash(file),
    });
    await expect(repository.migrateLegacyDay("2026-07-18")).rejects.toThrow(/a file already uses/);
  });

  it("non-destructively migrates a legacy day after repairing an unambiguous marker", async () => {
    const memoryVault = new MemoryVault();
    const repository = new DayFileRepository(memoryVault as unknown as Vault, {
      getStorageFolder: () => "TimePoint/Days",
      getTimezone: () => "UTC",
      trashFile: (file) => memoryVault.trash(file),
    });
    const legacyPath = repository.getDayPath("2026-07-18");
    const valid = serializeDayFile("2026-07-18", "UTC", [entry()]);
    const damaged = valid.replace(
      '<!-- timepoint:entry:end id="tp-entry-a1" -->',
      '<!-- timepoint:entry:end id="tp-entry-a1" --',
    );
    memoryVault.seedFile(legacyPath, damaged);

    const result = await repository.migrateLegacyDay("2026-07-18");
    expect(result).toMatchObject({ migratedEntries: 1, safeRepairsAppliedInCopy: 1 });
    expect(memoryVault.content(legacyPath)).toBe(damaged);
    expect((await repository.loadDay("2026-07-18")).entries[0]?.contentMarkdown).toBe(
      "Original body",
    );
    expect(memoryVault.content(result.indexPath)).toContain("```timepoint");
  });

  it("refuses migration when legacy damage is ambiguous", async () => {
    const memoryVault = new MemoryVault();
    const repository = new DayFileRepository(memoryVault as unknown as Vault, {
      getStorageFolder: () => "TimePoint/Days",
      trashFile: (file) => memoryVault.trash(file),
    });
    const legacyPath = repository.getDayPath("2026-07-18");
    const damaged = serializeDayFile("2026-07-18", "UTC", [entry()]).replace(
      '<!-- timepoint:entry:end id="tp-entry-a1" -->',
      '<!-- timepoint:entry:end id="another-id" -->',
    );
    memoryVault.seedFile(legacyPath, damaged);

    await expect(repository.migrateLegacyDay("2026-07-18")).rejects.toThrow(/migration blocked/i);
    expect(memoryVault.paths()).toEqual([legacyPath]);
  });

  it("isolates duplicate standalone IDs and blocks ambiguous edits", async () => {
    const memoryVault = new MemoryVault();
    const repository = new DayFileRepository(memoryVault as unknown as Vault, {
      getStorageFolder: () => "TimePoint/Days",
      trashFile: (file) => memoryVault.trash(file),
    });
    await repository.migrateLegacyDay("2026-07-18");
    const folder = repository.getEntryFolderPath("2026-07-18");
    memoryVault.seedFile(`${folder}/0815--tp-entry-a1.md`, serializeStandaloneEntry(entry()));
    memoryVault.seedFile(
      `${folder}/0900--tp-entry-a1.md`,
      serializeStandaloneEntry(entry({ time: "09:00", minuteOfDay: 540 })),
    );

    const day = await repository.loadDay("2026-07-18");
    expect(day.entries).toHaveLength(1);
    expect(day.diagnostics).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_ID", severity: "error" }),
    );
    await expect(
      repository.updateEntry(
        entry({ contentMarkdown: "Unsafe", updatedAt: "2026-07-18T10:00:00Z" }),
      ),
    ).rejects.toThrow(/appears in 2 separate notes/);
  });
});

describe("standalone entry files and conservative legacy repair", () => {
  it("round-trips an event as ordinary Markdown and preserves user properties on update", () => {
    const original = serializeStandaloneEntry(entry()).replace(
      "---\n\nOriginal body",
      "aliases:\n  - Morning log\ncssclasses: timepoint-custom\n---\n\nOriginal body",
    );
    const opened = parseStandaloneEntry(original, { expectedDate: "2026-07-18" });
    expect(opened.entry?.contentMarkdown).toBe("Original body");
    const updated = updateStandaloneEntryMarkdown(
      original,
      entry({ contentMarkdown: "Changed in Obsidian", updatedAt: "2026-07-18T09:00:00Z" }),
    );
    expect(updated).toContain("aliases:\n  - Morning log");
    expect(updated).toContain("cssclasses: timepoint-custom");
    expect(parseStandaloneEntry(updated).entry?.contentMarkdown).toBe("Changed in Obsidian");
  });

  it("builds a movable daily index with an interactive block and relative note links", () => {
    const index = serializeDayIndex("2026-07-18", [entry()], "UTC");
    expect(index).toContain("timepoint-layout: entry-files");
    expect(index).toContain("```timepoint\ndate: 2026-07-18\nmode: elastic\neditable: true\n```");
    expect(index).toContain("[[0815--tp-entry-a1|08:15]]");
  });

  it("repairs only a uniquely truncated legacy end marker", () => {
    const damaged = serializeDayFile("2026-07-18", "UTC", [entry()]).replace(
      '<!-- timepoint:entry:end id="tp-entry-a1" -->',
      '<!-- timepoint:entry:end id="tp-entry-a1" --',
    );
    const plan = planLegacyDayRepair(damaged, "2026-07-18");
    expect(plan.canApply).toBe(true);
    expect(plan.changes).toMatchObject([{ code: "COMPLETE_END_MARKER", entryId: "tp-entry-a1" }]);
    expect(plan.diagnosticsAfter.filter((item) => item.severity === "error")).toEqual([]);
  });
});

class MemoryVault {
  readonly createdFolders: string[] = [];
  readonly trashedPaths: string[] = [];
  processCalls = 0;
  private readonly files = new Map<string, { file: TFile; content: string }>();
  private readonly folders = new Map<string, TAbstractFile>();

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  async createFolder(path: string): Promise<void> {
    if (this.files.has(path) || this.folders.has(path)) throw new Error("already exists");
    this.folders.set(path, { path, name: path.split("/").at(-1) ?? path } as TAbstractFile);
    this.createdFolders.push(path);
  }

  async create(path: string, content: string): Promise<TFile> {
    if (this.files.has(path) || this.folders.has(path)) throw new Error("already exists");
    const file = fakeFile(path);
    this.files.set(path, { file, content });
    return file;
  }

  async read(file: TFile): Promise<string> {
    const record = this.files.get(file.path);
    if (!record) throw new Error("missing file");
    return record.content;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()]
      .map((record) => record.file)
      .filter((file) => file.extension === "md");
  }

  async process(file: TFile, callback: (data: string) => string): Promise<string> {
    const record = this.files.get(file.path);
    if (!record) throw new Error("missing file");
    this.processCalls += 1;
    record.content = callback(record.content);
    return record.content;
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    const record = this.files.get(file.path);
    if (!record) throw new Error("missing file");
    if (this.files.has(newPath) || this.folders.has(newPath)) throw new Error("already exists");
    this.files.delete(file.path);
    const renamed = fakeFile(newPath);
    this.files.set(newPath, { file: renamed, content: record.content });
  }

  async trash(file: TFile): Promise<void> {
    if (!this.files.delete(file.path)) throw new Error("missing file");
    this.trashedPaths.push(file.path);
  }

  seedFile(path: string, content: string): void {
    this.files.set(path, { file: fakeFile(path), content });
  }

  content(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

function fakeFile(path: string): TFile {
  const name = path.split("/").at(-1) ?? path;
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return {
    path,
    name,
    basename: name.replace(/\.md$/, ""),
    extension: name.includes(".") ? (name.split(".").at(-1) ?? "") : "",
    parent: { path: parentPath, name: parentPath.split("/").at(-1) ?? parentPath },
    stat: { ctime: 1_721_293_200_000, mtime: 1_721_293_200_000, size: 0 },
  } as TFile;
}
