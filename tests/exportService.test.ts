import { TFile, TFolder, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFolder: class TFolder {},
  TFile: class TFile {},
  normalizePath: (value: string) => value.replace(/\/{2,}/gu, "/"),
}));

import type { TimePointEntry } from "../src/model/types";
import {
  parseTimePointCsv,
  parseTimePointJson,
  parseTimePointMarkdown,
} from "../src/import-export";
import { sha256Hex } from "../src/services/ExternalSnapshotService";
import { ExportService, enumerateExportDates } from "../src/services/ExportService";
import {
  parseStandaloneEntry,
  serializeDayViewStateBlock,
  type DayFileRepository,
} from "../src/storage";

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

  it("carries day canvas state and completed snapshot artifacts in portable output", async () => {
    const snapshotUrl = "https://example.org/portable";
    const snapshotId = await sha256Hex(snapshotUrl);
    const vault = new MemoryVault();
    vault.seedText(
      `TimePoint/Snapshots/${snapshotId}/snapshot.md`,
      [
        "---",
        "timepoint-link-snapshot: 1",
        `id: "${snapshotId}"`,
        `originalUrl: "${snapshotUrl}"`,
        `normalizedUrl: "${snapshotUrl}"`,
        'title: "Portable snapshot"',
        'description: "Safe metadata"',
        'fetchedAt: "2026-07-21T12:00:00.000Z"',
        `contentHash: "${"a".repeat(64)}"`,
        'sourceEntryIds: ["tp-portable"]',
        `previewPath: "TimePoint/Snapshots/${snapshotId}/preview.webp"`,
        "---",
        "",
      ].join("\n"),
    );
    vault.seedBinary(
      `TimePoint/Snapshots/${snapshotId}/preview.webp`,
      new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]).buffer,
    );
    const rawMarkdown = serializeDayViewStateBlock({
      schemaVersion: 1,
      modes: {
        elastic: { zoom: 1.5, centerX: 0.7, centerY: 0.25 },
        realtime: { zoom: 0.75, centerX: 0.5, centerY: 0.5 },
      },
      minimapExpanded: false,
      relationsEnabled: true,
      stackOrder: ["tp-portable"],
      referenceCards: {
        "ref:portable": {
          id: "ref:portable",
          kind: "external-url",
          target: "https://example.org/portable",
          x: 0.8,
          y: 0.2,
          width: 0.3,
          height: 160,
          expanded: true,
        },
      },
    });
    const repository = {
      loadDay: vi.fn(async (date: string) =>
        loadedDay(
          date,
          [entry(date, "tp-portable", { linkSnapshotIds: [snapshotId] })],
          rawMarkdown,
        ),
      ),
    };
    const service = createService(vault, repository);
    const request = {
      scope: { kind: "day" as const, date: "2028-02-29" },
      format: "portable" as const,
    };
    const preview = await service.preview(request);
    const result = await service.export(request, preview.sourceFingerprint);
    const root = "TimePoint/Exports/2028-02-29/portable";
    const indexPath = `${root}/TimePoint/Days/2028/02/2028-02-29/_Timeline.md`;

    expect(vault.content(indexPath)).toContain('"relationsEnabled": true');
    expect(result.files).toContain(`${root}/TimePoint/Snapshots/${snapshotId}/preview.webp`);
    expect(result.files).toContain(`${root}/TimePoint/Snapshots/${snapshotId}/snapshot.md`);
    expect(vault.binary(`${root}/TimePoint/Snapshots/${snapshotId}/preview.webp`)).toEqual(
      new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]),
    );
    expect(result.files.at(-1)).toBe(result.primaryPath);
  });

  it("blocks a portable commit when day view state changes after preview", async () => {
    const vault = new MemoryVault();
    let centerY = 0.1;
    const repository = {
      loadDay: vi.fn(async (date: string) =>
        loadedDay(
          date,
          [],
          serializeDayViewStateBlock({
            schemaVersion: 1,
            modes: {
              elastic: { zoom: 1, centerX: 0.5, centerY },
              realtime: { zoom: 1, centerX: 0.5, centerY: 0 },
            },
            minimapExpanded: true,
            relationsEnabled: false,
            stackOrder: [],
            referenceCards: {},
          }),
        ),
      ),
    };
    const service = createService(vault, repository);
    const request = {
      scope: { kind: "day" as const, date: "2028-02-29" },
      format: "portable" as const,
    };
    const preview = await service.preview(request);
    centerY = 0.9;

    await expect(service.export(request, preview.sourceFingerprint)).rejects.toThrow(/stale/i);
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

  it("blocks portable output when an associated snapshot is incomplete", async () => {
    const vault = new MemoryVault();
    const missingId = "c".repeat(64);
    const repository = {
      loadDay: vi.fn(async (date: string) =>
        loadedDay(date, [entry(date, "tp-missing-snapshot", { linkSnapshotIds: [missingId] })]),
      ),
    };
    const service = createService(vault, repository);
    const preview = await service.preview({
      scope: { kind: "day", date: "2028-02-29" },
      format: "portable",
    });

    expect(preview).toMatchObject({ canExport: false, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/completed snapshot.*missing/i);
    expect(vault.createdFiles()).toEqual([]);
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

  it("exports and re-imports every format at the 366-day range ceiling", async () => {
    const dates = enumerateExportDates({
      kind: "range",
      startDate: "2028-01-01",
      endDate: "2028-12-31",
    });
    const entriesByDate = new Map(
      dates.map((date, dayIndex) => [
        date,
        Array.from({ length: 8 }, (_, entryIndex) => {
          const minuteOfDay = entryIndex * 180 + (dayIndex % 17);
          return entry(date, `tp-${dayIndex.toString().padStart(3, "0")}-${entryIndex}`, {
            time: `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`,
            minuteOfDay,
            contentMarkdown: `Day ${dayIndex} · event ${entryIndex} · 压力回归 🧪`,
          });
        }),
      ]),
    );
    const repository = {
      loadDay: vi.fn(async (date: string) => loadedDay(date, entriesByDate.get(date) ?? [])),
    };
    const expectedCount = dates.length * 8;

    for (const format of ["markdown", "json", "csv"] as const) {
      const vault = new MemoryVault();
      const service = createService(vault, repository);
      const request = {
        scope: { kind: "range" as const, startDate: dates[0] ?? "", endDate: dates.at(-1) ?? "" },
        format,
      };
      const preview = await service.preview(request);
      expect(preview).toMatchObject({
        canExport: true,
        dayCount: 366,
        entryCount: expectedCount,
        emptyDayCount: 0,
      });
      const result = await service.export(request, preview.sourceFingerprint);
      const content = vault.content(result.primaryPath) ?? "";
      const parsed =
        format === "markdown"
          ? parseTimePointMarkdown(content)
          : format === "json"
            ? parseTimePointJson(content)
            : parseTimePointCsv(content);
      expect(parsed.issues).toEqual([]);
      expect(parsed.ok).toBe(true);
      expect(parsed.entries).toHaveLength(expectedCount);
      expect(new Set(parsed.entries.map((item) => item.id)).size).toBe(expectedCount);
    }

    const portableVault = new MemoryVault();
    const portableService = createService(portableVault, repository);
    const portableRequest = {
      scope: { kind: "range" as const, startDate: dates[0] ?? "", endDate: dates.at(-1) ?? "" },
      format: "portable" as const,
    };
    const portablePreview = await portableService.preview(portableRequest);
    const portable = await portableService.export(
      portableRequest,
      portablePreview.sourceFingerprint,
    );
    expect(portable.files).toHaveLength(expectedCount + dates.length + 1);
    expect(portable.files.at(-1)).toBe(portable.primaryPath);
    expect(portableVault.content(portable.primaryPath)).toContain(`eventCount: ${expectedCount}`);
    const eventFiles = portable.files.filter(
      (path) =>
        path.endsWith(".md") && !path.endsWith("/_Timeline.md") && path !== portable.primaryPath,
    );
    expect(eventFiles).toHaveLength(expectedCount);
    for (const path of eventFiles.filter((_, index) => index % 127 === 0)) {
      expect(parseStandaloneEntry(portableVault.content(path) ?? "").entry).toBeDefined();
    }
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

function loadedDay(date: string, entries: TimePointEntry[], rawMarkdown = "") {
  return {
    schemaVersion: 2,
    date,
    timezone: "UTC",
    entries,
    diagnostics: [],
    rawMarkdown,
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

  async createBinary(path: string, content: ArrayBuffer): Promise<object> {
    this.createAttempts += 1;
    if (this.createAttempts === this.failCreateAt) throw new Error("Simulated write failure");
    const file = new (
      TFile as unknown as new () => TFile & { path: string; binary: ArrayBuffer }
    )();
    file.path = path;
    file.binary = content.slice(0);
    this.entries.set(path, file);
    return file;
  }

  async cachedRead(file: TFile & { content?: string }): Promise<string> {
    return file.content ?? "";
  }

  async readBinary(file: TFile & { binary?: ArrayBuffer }): Promise<ArrayBuffer> {
    return file.binary?.slice(0) ?? new ArrayBuffer(0);
  }

  seedText(path: string, content: string): void {
    const file = new (TFile as unknown as new () => TFile & { path: string; content: string })();
    file.path = path;
    file.content = content;
    this.entries.set(path, file);
  }

  seedBinary(path: string, content: ArrayBuffer): void {
    const file = new (
      TFile as unknown as new () => TFile & { path: string; binary: ArrayBuffer }
    )();
    file.path = path;
    file.binary = content.slice(0);
    this.entries.set(path, file);
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

  binary(path: string): Uint8Array | undefined {
    const value = this.entries.get(path);
    return value instanceof TFile
      ? new Uint8Array((value as TFile & { binary?: ArrayBuffer }).binary ?? new ArrayBuffer(0))
      : undefined;
  }
}
