import { TFile, TFolder, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFolder: class TFolder {},
  TFile: class TFile {},
  normalizePath: (value: string) => value.replace(/\/{2,}/gu, "/"),
}));

import type { TimePointEntry } from "../src/model/types";
import { ExportService, enumerateExportDates } from "../src/services/ExportService";
import type { DayFileRepository } from "../src/storage";

describe("ExportService", () => {
  it("blocks before writing when the day parser reports an error", async () => {
    const vault = {
      create: vi.fn(),
      createFolder: vi.fn(),
      getAbstractFileByPath: vi.fn(),
    };
    const repository = {
      loadDay: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        date: "2026-07-18",
        timezone: "UTC",
        entries: [],
        diagnostics: [
          {
            severity: "error",
            code: "MISSING_END_MARKER",
            message: "Entry tp-damaged has no matching end marker.",
            entryId: "tp-damaged",
          },
        ],
        rawMarkdown: "damaged entry",
      }),
    };
    const service = new ExportService(
      vault as unknown as Vault,
      repository as unknown as DayFileRepository,
      () => "TimePoint/Exports",
      async () => undefined,
    );

    await expect(service.exportDay("2026-07-18", "json")).rejects.toThrow(
      /Export blocked.*MISSING_END_MARKER.*no export was written/i,
    );
    expect(vault.createFolder).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it("blocks before writing when an entry uses a future schema", async () => {
    const vault = {
      create: vi.fn(),
      createFolder: vi.fn(),
      getAbstractFileByPath: vi.fn(),
    };
    const repository = {
      loadDay: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        date: "2026-07-18",
        timezone: "UTC",
        entries: [],
        diagnostics: [
          {
            severity: "error",
            code: "UNSUPPORTED_SCHEMA",
            message: "Entry tp-future schema 2 is newer than supported schema 1.",
            entryId: "tp-future",
          },
        ],
        rawMarkdown: "future entry",
      }),
    };
    const service = new ExportService(
      vault as unknown as Vault,
      repository as unknown as DayFileRepository,
      () => "TimePoint/Exports",
      async () => undefined,
    );

    await expect(service.exportDay("2026-07-18", "json")).rejects.toThrow(
      /Export blocked.*UNSUPPORTED_SCHEMA.*no export was written/i,
    );
    expect(vault.createFolder).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it("previews inclusive ranges with empty dates and no writes", async () => {
    const vault = new MemoryVault();
    const repository = {
      loadDay: vi.fn(async (date: string) =>
        loadedDay(date, date === "2028-02-29" ? [entry(date, "tp-leap")] : []),
      ),
    };
    const service = createService(vault, repository);
    const request = {
      scope: { kind: "range" as const, startDate: "2028-02-28", endDate: "2028-03-01" },
      format: "json" as const,
    };

    const preview = await service.preview(request);
    expect(preview).toMatchObject({
      canExport: true,
      dayCount: 3,
      emptyDayCount: 2,
      entryCount: 1,
      errorCount: 0,
    });
    expect(repository.loadDay).toHaveBeenCalledTimes(3);
    expect(vault.createdFiles()).toEqual([]);
  });

  it("blocks a stale preview before creating an output folder or file", async () => {
    const vault = new MemoryVault();
    let content = "Before preview";
    const repository = {
      loadDay: vi.fn(async (date: string) =>
        loadedDay(date, [entry(date, "tp-stale", { contentMarkdown: content })]),
      ),
    };
    const service = createService(vault, repository);
    const request = {
      scope: { kind: "day" as const, date: "2028-02-29" },
      format: "markdown" as const,
    };
    const preview = await service.preview(request);
    content = "Changed after preview";

    await expect(service.export(request, preview.sourceFingerprint)).rejects.toThrow(/stale/i);
    expect(vault.createdFiles()).toEqual([]);
  });

  it("creates a canonical portable notes folder and root index last", async () => {
    const vault = new MemoryVault();
    const repository = {
      loadDay: vi.fn(async (date: string) => loadedDay(date, [entry(date, `tp-${date}`)])),
    };
    const service = createService(vault, repository);
    const request = {
      scope: { kind: "range" as const, startDate: "2028-02-29", endDate: "2028-03-01" },
      format: "portable" as const,
    };
    const preview = await service.preview(request);
    const result = await service.export(request, preview.sourceFingerprint);

    expect(result.primaryPath).toBe(
      "TimePoint/Exports/2028-02-29_to_2028-03-01/portable/_TimePoint_Export.md",
    );
    expect(result.files).toContain(
      "TimePoint/Exports/2028-02-29_to_2028-03-01/portable/TimePoint/Days/2028/02/2028-02-29/_Timeline.md",
    );
    expect(result.files).toContain(
      "TimePoint/Exports/2028-02-29_to_2028-03-01/portable/TimePoint/Days/2028/03/2028-03-01/_Timeline.md",
    );
    expect(result.files.at(-1)).toBe(result.primaryPath);
    expect(result.copyableContent).toBeUndefined();
    expect(vault.content(result.primaryPath)).toContain(
      "[2028-02-29](TimePoint/Days/2028/02/2028-02-29/_Timeline.md)",
    );
  });

  it("rolls back newly created files when a portable write is interrupted", async () => {
    const vault = new MemoryVault(2);
    const repository = {
      loadDay: vi.fn(async (date: string) => loadedDay(date, [entry(date, "tp-rollback")])),
    };
    const service = createService(vault, repository);
    const request = {
      scope: { kind: "day" as const, date: "2028-02-29" },
      format: "portable" as const,
    };
    const preview = await service.preview(request);

    await expect(service.export(request, preview.sourceFingerprint)).rejects.toThrow(
      /simulated write failure/i,
    );
    expect(vault.createdFiles()).toEqual([]);
  });

  it("blocks duplicate IDs across different days", async () => {
    const vault = new MemoryVault();
    const repository = {
      loadDay: vi.fn(async (date: string) => loadedDay(date, [entry(date, "tp-duplicate")])),
    };
    const service = createService(vault, repository);
    const preview = await service.preview({
      scope: { kind: "range", startDate: "2028-02-29", endDate: "2028-03-01" },
      format: "csv",
    });
    expect(preview).toMatchObject({ canExport: false, conflictCount: 1, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/duplicate/i);
  });

  it("exposes the exact 366-day range boundary", () => {
    expect(
      enumerateExportDates({
        kind: "range",
        startDate: "2028-01-01",
        endDate: "2028-12-31",
      }),
    ).toHaveLength(366);
  });
});

function createService(vault: MemoryVault, repository: { loadDay: (date: string) => unknown }) {
  return new ExportService(
    vault as unknown as Vault,
    repository as unknown as DayFileRepository,
    () => "TimePoint/Exports",
    (file) => vault.delete(file),
  );
}

function loadedDay(date: string, entries: TimePointEntry[]) {
  return {
    schemaVersion: 2,
    date,
    timezone: "UTC",
    entries,
    diagnostics: [],
    rawMarkdown: "",
    storageLayout: entries.length ? "entry-files" : "empty",
  };
}

function entry(date: string, id: string, overrides: Partial<TimePointEntry> = {}): TimePointEntry {
  return {
    id,
    date,
    time: "08:15",
    minuteOfDay: 495,
    timezone: "UTC",
    contentMarkdown: "Portable event",
    tags: [],
    source: "test",
    createdAt: `${date}T08:15:00.000Z`,
    updatedAt: `${date}T08:15:00.000Z`,
    ...overrides,
  };
}

class MemoryVault {
  private readonly entries = new Map<string, object>();
  private createAttempts = 0;

  constructor(private readonly failCreateAt?: number) {}

  getAbstractFileByPath(path: string): object | null {
    return this.entries.get(path) ?? null;
  }

  async createFolder(path: string): Promise<void> {
    const folder = new (TFolder as unknown as new () => TFolder & { path: string })();
    folder.path = path;
    this.entries.set(path, folder);
  }

  async create(path: string, content: string): Promise<object> {
    this.createAttempts += 1;
    if (this.createAttempts === this.failCreateAt) throw new Error("Simulated write failure");
    const file = new (TFile as unknown as new () => TFile & { path: string; content: string })();
    file.path = path;
    file.content = content;
    this.entries.set(path, file);
    return file;
  }

  async delete(file: { path: string }): Promise<void> {
    this.entries.delete(file.path);
  }

  createdFiles(): string[] {
    return [...this.entries]
      .filter(([, value]) => value instanceof TFile)
      .map(([path]) => path)
      .sort();
  }

  content(path: string): string | undefined {
    const value = this.entries.get(path);
    return value instanceof TFile ? (value as TFile & { content: string }).content : undefined;
  }
}
