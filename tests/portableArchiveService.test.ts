import { TFile, TFolder, type Vault } from "obsidian";
import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

vi.mock("obsidian", () => ({
  TFolder: class TFolder {},
  TFile: class TFile {},
  normalizePath: (value: string) => value.replace(/\/{2,}/gu, "/"),
}));

import type { TimePointEntry } from "../src/model/types";
import { sha256Hex } from "../src/services/ExternalSnapshotService";
import {
  PortableArchiveService,
  type PortableManifest,
} from "../src/services/PortableArchiveService";
import {
  parseStandaloneEntry,
  serializeDayIndex,
  serializeStandaloneEntry,
  type DayFileRepository,
} from "../src/storage";

describe("PortableArchiveService", () => {
  it("previews and transactionally imports a Web portable ZIP", async () => {
    const archive = await buildArchive();
    const vault = new MemoryVault();
    const service = createService(vault);
    const preview = await service.preview(asFile(archive));
    expect(preview).toMatchObject({
      canImport: true,
      entryCount: 1,
      attachmentCount: 1,
      conflicts: [],
      errors: [],
    });

    const result = await service.import(asFile(archive), preview.planFingerprint);
    expect(result.canImport).toBe(true);
    const eventPath = vault
      .files()
      .find((path) => path.includes("tp-web-portable") && path.endsWith(".md"));
    expect(eventPath).toBeDefined();
    expect(parseStandaloneEntry(vault.text(eventPath ?? "") ?? "").entry).toMatchObject({
      id: "tp-web-portable",
      date: "2028-02-29",
    });
    expect(vault.binary("TimePoint/Days/2028/02/2028-02-29/attachments/pixel.png")).toEqual(
      pngBytes(),
    );
    expect(vault.text("TimePoint/Days/2028/02/2028-02-29/_Timeline.md")).toContain("```timepoint");
  });

  it("imports the fixed cross-platform Portable v1 fixture", async () => {
    const vault = new MemoryVault();
    const service = createService(vault);
    const archive = zipFixture();
    const preview = await service.preview(asFile(archive));
    expect(preview).toMatchObject({
      canImport: true,
      entryCount: 1,
      attachmentCount: 1,
      dates: ["2028-02-29"],
    });
    await service.import(asFile(archive), preview.planFingerprint);
    const eventPath = vault.files().find((path) => path.includes("tp-cross-platform-fixture"));
    expect(parseStandaloneEntry(vault.text(eventPath ?? "") ?? "").entry).toMatchObject({
      id: "tp-cross-platform-fixture",
      cardLayout: { width: 0.5, height: 180 },
    });
    expect(
      new TextDecoder().decode(
        vault.binary("TimePoint/Days/2028/02/2028-02-29/attachments/fixture.txt"),
      ),
    ).toBe("Cross-platform fixture\n");
    expect(vault.text("TimePoint/Days/2028/02/2028-02-29/_Timeline.md")).toContain(
      '"verticalScale":1.4',
    );
  });

  it("blocks collisions during preview and never overwrites existing files", async () => {
    const archive = await buildArchive();
    const vault = new MemoryVault();
    vault.seedText("TimePoint/Days/2028/02/2028-02-29/_Timeline.md", "existing index");
    const preview = await createService(vault).preview(asFile(archive));
    expect(preview.canImport).toBe(false);
    expect(preview.conflicts).toContain("TimePoint/Days/2028/02/2028-02-29/_Timeline.md");
    expect(vault.text("TimePoint/Days/2028/02/2028-02-29/_Timeline.md")).toBe("existing index");
  });

  it("rejects path traversal and attachment integrity mismatches before writing", async () => {
    const traversal = await buildArchive({ unsafePath: true });
    await expect(createService(new MemoryVault()).preview(asFile(traversal))).rejects.toThrow(
      /unsafe path/u,
    );

    const corrupt = await buildArchive({ corruptHash: true });
    await expect(createService(new MemoryVault()).preview(asFile(corrupt))).rejects.toThrow(
      /SHA-256/u,
    );
  });

  it("rejects forged oversized declarations before decompression", async () => {
    const forged = forgeCentralOriginalSize(await buildArchive(), 51 * 1024 * 1024);
    await expect(createService(new MemoryVault()).preview(asFile(forged))).rejects.toThrow(
      /exceeds 50 MiB/u,
    );
  });

  it("rolls back every created file if a later portable write fails", async () => {
    const archive = await buildArchive();
    const vault = new MemoryVault(2);
    const service = createService(vault);
    const preview = await service.preview(asFile(archive));
    await expect(service.import(asFile(archive), preview.planFingerprint)).rejects.toThrow(
      /simulated/iu,
    );
    expect(vault.files()).toEqual([]);
  });
});

function createService(vault: MemoryVault): PortableArchiveService {
  const repository = {
    loadDay: vi.fn(async (date: string) => ({
      date,
      entries: [],
      diagnostics: [],
      rawMarkdown: "",
      storageLayout: "empty",
    })),
  };
  return new PortableArchiveService(
    vault as unknown as Vault,
    repository as unknown as DayFileRepository,
    () => "TimePoint/Days",
    (file) => vault.delete(file),
  );
}

async function buildArchive(
  options: { corruptHash?: boolean; unsafePath?: boolean } = {},
): Promise<Uint8Array> {
  const date = "2028-02-29";
  const event: TimePointEntry = {
    id: "tp-web-portable",
    date,
    time: "09:30",
    minuteOfDay: 570,
    timezone: "UTC",
    contentMarkdown: "# Portable\n\n![Pixel](attachments/pixel.png)",
    tags: ["portable"],
    source: "timepoint-web",
    createdAt: "2028-02-29T09:30:00.000Z",
    updatedAt: "2028-02-29T09:30:00.000Z",
  };
  const image = pngBytes();
  const digest = await sha256Hex(image);
  const attachmentPath = "TimePoint/Days/2028/02/2028-02-29/attachments/pixel.png";
  const manifest: PortableManifest = {
    schema: "timepoint-portable",
    schemaVersion: 1,
    exportedAt: "2028-02-29T10:00:00.000Z",
    generator: "timepoint-web",
    generatorVersion: "0.2.0-beta.1",
    entrySchemaVersion: 1,
    entryCount: 1,
    attachmentCount: 1,
    dates: [date],
    attachments: [
      {
        id: "asset-web-pixel",
        eventId: event.id,
        path: "attachments/pixel.png",
        archivePath: attachmentPath,
        fileName: "pixel.png",
        mimeType: "image/png",
        kind: "raster-image",
        renderPolicy: "inline-image",
        size: image.byteLength,
        sha256: options.corruptHash ? "0".repeat(64) : digest,
      },
    ],
  };
  const files: Zippable = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "TimePoint/Days/2028/02/2028-02-29/0930--tp-web-portable.md": strToU8(
      serializeStandaloneEntry(event),
    ),
    "TimePoint/Days/2028/02/2028-02-29/_Timeline.md": strToU8(
      serializeDayIndex(date, [event], "UTC"),
    ),
    [attachmentPath]: image,
  };
  if (options.unsafePath) files["../escaped.txt"] = strToU8("unsafe");
  return zipSync(files, { level: 6 });
}

function asFile(bytes: Uint8Array): File {
  return {
    name: "timepoint-portable.zip",
    size: bytes.byteLength,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  } as File;
}

function forgeCentralOriginalSize(source: Uint8Array, size: number): Uint8Array {
  const forged = source.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  for (let offset = 0; offset <= forged.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    view.setUint32(offset + 24, size, true);
    return forged;
  }
  throw new Error("Test ZIP has no central directory entry.");
}

function zipFixture(): Uint8Array {
  const root = join(process.cwd(), "tests/fixtures/timepoint-portable-v1");
  const files: Record<string, Uint8Array> = {};
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else files[relative(root, path).replaceAll("\\", "/")] = new Uint8Array(readFileSync(path));
    }
  };
  walk(root);
  return zipSync(files, { level: 6 });
}

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
}

class MemoryVault {
  private readonly entries = new Map<string, object>();
  private writes = 0;

  constructor(private readonly failWriteAt?: number) {}

  getAbstractFileByPath(path: string): object | null {
    return this.entries.get(path) ?? null;
  }

  async createFolder(path: string): Promise<void> {
    const folder = new (
      TFolder as unknown as new () => TFolder & {
        path: string;
      }
    )();
    folder.path = path;
    this.entries.set(path, folder);
  }

  async create(path: string, content: string): Promise<TFile> {
    this.beforeWrite();
    const file = makeFile(path, new TextEncoder().encode(content).byteLength);
    (file as TFile & { content: string }).content = content;
    this.entries.set(path, file);
    return file;
  }

  async createBinary(path: string, content: ArrayBuffer): Promise<TFile> {
    this.beforeWrite();
    const file = makeFile(path, content.byteLength);
    (file as TFile & { binary: ArrayBuffer }).binary = content.slice(0);
    this.entries.set(path, file);
    return file;
  }

  seedText(path: string, content: string): void {
    const file = makeFile(path, new TextEncoder().encode(content).byteLength);
    (file as TFile & { content: string }).content = content;
    this.entries.set(path, file);
  }

  async delete(file: TFile): Promise<void> {
    this.entries.delete(file.path);
  }

  files(): string[] {
    return [...this.entries]
      .filter(([, value]) => value instanceof TFile)
      .map(([path]) => path)
      .sort();
  }

  text(path: string): string | undefined {
    const file = this.entries.get(path);
    return file instanceof TFile ? (file as TFile & { content?: string }).content : undefined;
  }

  binary(path: string): Uint8Array | undefined {
    const file = this.entries.get(path);
    return file instanceof TFile
      ? new Uint8Array((file as TFile & { binary?: ArrayBuffer }).binary ?? new ArrayBuffer(0))
      : undefined;
  }

  private beforeWrite(): void {
    this.writes += 1;
    if (this.writes === this.failWriteAt) throw new Error("Simulated portable write failure");
  }
}

function makeFile(path: string, size: number): TFile {
  const file = new (TFile as unknown as new () => TFile)();
  const name = path.slice(path.lastIndexOf("/") + 1);
  Object.assign(file, {
    path,
    name,
    extension: name.split(".").at(-1) ?? "",
    basename: name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name,
    stat: { size, ctime: 0, mtime: 0 },
  });
  return file;
}
