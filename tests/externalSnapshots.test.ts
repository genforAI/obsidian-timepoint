import type { RequestUrlResponse, TAbstractFile, TFile, Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalSnapshotService,
  extractPageMetadata,
  matchesImageMagic,
  sha256Hex,
  validatePublicHttpsUrl,
} from "../src/services/ExternalSnapshotService";

vi.stubGlobal("window", { setTimeout, clearTimeout });

describe("external snapshot safety", () => {
  it("allows normalized public HTTPS and blocks credentials, local names, and IP literals", () => {
    expect(validatePublicHttpsUrl("https://Example.com:443/a?utm_source=x&b=2#part")).toEqual({
      ok: true,
      normalizedUrl: "https://example.com/a?b=2",
    });
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://localhost/a",
      "https://printer.local/a",
      "https://127.0.0.1/a",
      "https://[::1]/a",
      "https://intranet/a",
      "https://reserved.test/a",
    ]) {
      expect(validatePublicHttpsUrl(url).ok, url).toBe(false);
    }
  });

  it("extracts inert, length-limited metadata without retaining markup or controls", () => {
    const html = [
      "<html><head>",
      '<meta property="og:title" content="Safe &amp; useful">',
      '<meta name="description" content="<b>Summary</b>\u0000 text">',
      '<meta property="og:image" content="/preview.png">',
      "<script>window.pwned = true</script>",
      "</head></html>",
    ].join("");
    expect(extractPageMetadata(html, "https://example.com/article")).toEqual({
      title: "Safe & useful",
      description: "Summary text",
      imageUrl: "https://example.com/preview.png",
    });
    expect((window as Window & { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("accepts only matching PNG, JPEG, and WebP magic bytes", () => {
    expect(
      matchesImageMagic(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
        "image/png",
      ),
    ).toBe(true);
    expect(matchesImageMagic(Uint8Array.from([0xff, 0xd8, 0xff]).buffer, "image/jpeg")).toBe(true);
    expect(matchesImageMagic(new TextEncoder().encode("RIFF0000WEBP").buffer, "image/webp")).toBe(
      true,
    );
    expect(matchesImageMagic(new TextEncoder().encode("<svg>").buffer, "image/png")).toBe(false);
    expect(
      matchesImageMagic(new TextEncoder().encode("RIFF0000WEBP").buffer, "image/svg+xml"),
    ).toBe(false);
  });
});

describe("external snapshot transaction and cache", () => {
  it("writes the optional preview first and the snapshot marker last, then serves cache without network", async () => {
    const vault = new SnapshotMemoryVault();
    let requests = 0;
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      request: async ({ url }) => {
        requests += 1;
        if (url.endsWith("preview.png")) {
          return response(
            Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
            "image/png",
          );
        }
        return response(
          new TextEncoder().encode(
            '<title>Article</title><meta name="description" content="Summary"><meta property="og:image" content="https://cdn.example.net/preview.png">',
          ).buffer,
          "text/html; charset=utf-8",
        );
      },
      convertPreview: async () => new TextEncoder().encode("RIFF0000WEBP").buffer,
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });

    const first = await service.getOrCreate("https://example.com/article", ["tp-a"], true);
    expect(first.status).toBe("fetched");
    expect(first.snapshot).toMatchObject({
      title: "Article",
      description: "Summary",
      sourceEntryIds: ["tp-a"],
    });
    expect(vault.writeLog.at(-1)).toMatch(/\/snapshot\.md$/u);
    expect(vault.writeLog.at(-2)).toMatch(/\/preview\.webp$/u);
    expect(requests).toBe(2);

    const second = await service.getOrCreate("https://example.com/article", ["tp-b"], true);
    expect(second.status).toBe("cached");
    expect(second.snapshot?.sourceEntryIds).toEqual(["tp-a", "tp-b"]);
    expect(requests).toBe(2);

    vault.remove(first.snapshot?.previewPath ?? "");
    expect(await service.readSnapshot(first.snapshot?.id ?? "")).toBeNull();
  });

  it("deduplicates concurrent requests for the same normalized URL", async () => {
    const vault = new SnapshotMemoryVault();
    let requests = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      request: async () => {
        requests += 1;
        await gate;
        return response(new TextEncoder().encode("<title>One</title>").buffer, "text/html");
      },
    });
    const first = service.getOrCreate("https://example.com/?utm_source=a", ["tp-a"], true);
    const second = service.getOrCreate("https://EXAMPLE.com/", ["tp-b"], true);
    await Promise.resolve();
    release?.();
    const [left, right] = await Promise.all([first, second]);
    expect(left.snapshot?.id).toBe(right.snapshot?.id);
    expect(right.snapshot?.sourceEntryIds).toEqual(["tp-a", "tp-b"]);
    expect(requests).toBe(1);
  });

  it("retains every source ID across concurrent fetch joins and cache hits", async () => {
    const vault = new SnapshotMemoryVault();
    let requests = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      hostIntervalMs: 0,
      request: async () => {
        requests += 1;
        await gate;
        return response(new TextEncoder().encode("<title>Concurrent</title>").buffer, "text/html");
      },
    });
    const url = "https://concurrent.example.com/article";
    const firstWave = Array.from({ length: 64 }, (_, index) =>
      service.getOrCreate(url, [`tp-fetch-${index.toString().padStart(2, "0")}`], true),
    );
    await Promise.resolve();
    release?.();
    await Promise.all(firstWave);

    const secondWave = Array.from({ length: 64 }, (_, index) =>
      service.getOrCreate(url, [`tp-cache-${index.toString().padStart(2, "0")}`], true),
    );
    await Promise.all(secondWave);

    const id = await sha256Hex(url);
    const snapshot = await service.readSnapshot(id);
    expect(requests).toBe(1);
    expect(snapshot?.sourceEntryIds).toHaveLength(128);
    expect(snapshot?.sourceEntryIds).toEqual(
      [
        ...Array.from(
          { length: 64 },
          (_, index) => `tp-fetch-${index.toString().padStart(2, "0")}`,
        ),
        ...Array.from(
          { length: 64 },
          (_, index) => `tp-cache-${index.toString().padStart(2, "0")}`,
        ),
      ].sort(),
    );
  });

  it("never exposes an asset-only partial snapshot when the final marker write fails", async () => {
    const vault = new SnapshotMemoryVault(/\/snapshot\.md$/u);
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      hostIntervalMs: 0,
      request: async ({ url }) =>
        url.endsWith("preview.png")
          ? response(
              Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
              "image/png",
            )
          : response(
              new TextEncoder().encode(
                '<title>Interrupted</title><meta property="og:image" content="https://cdn.example.net/preview.png">',
              ).buffer,
              "text/html",
            ),
      convertPreview: async () => new TextEncoder().encode("RIFF0000WEBP").buffer,
    });

    const result = await service.getOrCreate("https://failure.example.com/article", ["tp-a"], true);
    const id = await sha256Hex("https://failure.example.com/article");
    expect(result.status).toBe("offline");
    expect(result.reason).toMatch(/simulated marker failure/i);
    expect(await service.readSnapshot(id)).toBeNull();
    expect(vault.writeLog).toEqual([`TimePoint/Snapshots/${id}/preview.webp`]);
  });

  it("replaces an invalid pre-existing marker only after a successful refetch", async () => {
    const vault = new SnapshotMemoryVault();
    const url = "https://rebuild.example.com/article";
    const id = await sha256Hex(url);
    const markerPath = `TimePoint/Snapshots/${id}/snapshot.md`;
    await vault.create(markerPath, "---\ntimepoint-link-snapshot: 1\nid: invalid\n---\n");
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      hostIntervalMs: 0,
      request: async () =>
        response(new TextEncoder().encode("<title>Recovered cache</title>").buffer, "text/html"),
    });

    const result = await service.getOrCreate(url, ["tp-a"], true);
    expect(result.status).toBe("fetched");
    expect((await service.readSnapshot(id))?.title).toBe("Recovered cache");
    expect(vault.writeLog.at(-1)).toBe(markerPath);
  });

  it("never exceeds two active requests across different domains", async () => {
    const vault = new SnapshotMemoryVault();
    let active = 0;
    let maximum = 0;
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      hostIntervalMs: 0,
      request: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 5));
        active -= 1;
        return response(new TextEncoder().encode("<title>Bounded</title>").buffer, "text/html");
      },
    });

    const results = await Promise.all(
      ["one.example.com", "two.example.net", "three.example.org"].map((host, index) =>
        service.getOrCreate(`https://${host}/article`, [`tp-${index}`], true),
      ),
    );
    expect(results.every((result) => result.status === "fetched")).toBe(true);
    expect(maximum).toBe(2);
  });

  it("paces requests to the same host without serializing other domains", async () => {
    const starts: Array<{ url: string; at: number }> = [];
    const service = new ExternalSnapshotService({
      vault: new SnapshotMemoryVault() as unknown as Vault,
      hostIntervalMs: 25,
      request: async ({ url }) => {
        starts.push({ url, at: performance.now() });
        return response(new TextEncoder().encode("<title>Paced</title>").buffer, "text/html");
      },
    });

    await Promise.all([
      service.getOrCreate("https://pace.example.com/a", ["tp-a"], true),
      service.getOrCreate("https://pace.example.com/b", ["tp-b"], true),
      service.getOrCreate("https://other.example.net/a", ["tp-c"], true),
    ]);
    const sameHost = starts.filter(({ url }) => new URL(url).hostname === "pace.example.com");
    const otherHost = starts.find(({ url }) => new URL(url).hostname === "other.example.net");
    expect(sameHost).toHaveLength(2);
    expect((sameHost[1]?.at ?? 0) - (sameHost[0]?.at ?? 0)).toBeGreaterThanOrEqual(15);
    expect((otherHost?.at ?? Number.POSITIVE_INFINITY) - (sameHost[0]?.at ?? 0)).toBeLessThan(15);
  });

  it("ignores late results after timeout and can recover on a later request", async () => {
    const vault = new SnapshotMemoryVault();
    let calls = 0;
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      hostIntervalMs: 0,
      requestTimeoutMs: 5,
      request: async () => {
        calls += 1;
        if (calls === 1) return new Promise<RequestUrlResponse>(() => undefined);
        return response(new TextEncoder().encode("<title>Recovered</title>").buffer, "text/html");
      },
    });

    const offline = await service.getOrCreate(
      "https://recovery.example.com/article",
      ["tp-a"],
      true,
    );
    expect(offline.status).toBe("offline");
    expect(offline.reason).toMatch(/timed out/i);
    expect(vault.writeLog).toEqual([]);
    const recovered = await service.getOrCreate(
      "https://recovery.example.com/article",
      ["tp-a"],
      true,
    );
    expect(recovered).toMatchObject({ status: "fetched", snapshot: { title: "Recovered" } });
  });

  it("keeps a valid cache available but never reports a failed explicit refresh as fetched", async () => {
    const vault = new SnapshotMemoryVault();
    let calls = 0;
    const service = new ExternalSnapshotService({
      vault: vault as unknown as Vault,
      hostIntervalMs: 0,
      request: async () => {
        calls += 1;
        if (calls > 1) throw new Error("offline");
        return response(new TextEncoder().encode("<title>Cached</title>").buffer, "text/html");
      },
    });
    const first = await service.getOrCreate("https://cached.example.com/", ["tp-a"], true);
    const writesBeforeRefresh = vault.writeLog.length;
    const refresh = await service.getOrCreate("https://cached.example.com/", ["tp-a"], true, true);

    expect(first.status).toBe("fetched");
    expect(refresh.status).toBe("offline");
    expect(refresh.snapshot?.title).toBe("Cached");
    expect(vault.writeLog).toHaveLength(writesBeforeRefresh);
  });

  it("rejects oversized and non-HTML targets without committing a marker", async () => {
    const oversizedVault = new SnapshotMemoryVault();
    const oversized = new ExternalSnapshotService({
      vault: oversizedVault as unknown as Vault,
      hostIntervalMs: 0,
      request: async () => response(new Uint8Array(512 * 1024 + 1).buffer, "text/html"),
    });
    const oversizedResult = await oversized.getOrCreate(
      "https://large.example.com/",
      ["tp-a"],
      true,
    );
    expect(oversizedResult.status).toBe("offline");
    expect(oversizedResult.reason).toMatch(/512 KiB/i);
    expect(oversizedVault.writeLog).toEqual([]);

    const mimeVault = new SnapshotMemoryVault();
    const wrongMime = new ExternalSnapshotService({
      vault: mimeVault as unknown as Vault,
      hostIntervalMs: 0,
      request: async () => response(new TextEncoder().encode("not html").buffer, "image/svg+xml"),
    });
    const wrongMimeResult = await wrongMime.getOrCreate(
      "https://mime.example.net/",
      ["tp-a"],
      true,
    );
    expect(wrongMimeResult.status).toBe("offline");
    expect(wrongMimeResult.reason).toMatch(/not an HTML/i);
    expect(mimeVault.writeLog).toEqual([]);
  });

  it("does not request the network without explicit authorization", async () => {
    let requests = 0;
    const service = new ExternalSnapshotService({
      vault: new SnapshotMemoryVault() as unknown as Vault,
      request: async () => {
        requests += 1;
        return response(new ArrayBuffer(0), "text/html");
      },
    });
    const result = await service.getOrCreate("https://example.com/", ["tp-a"], false);
    expect(result.status).toBe("blocked");
    expect(requests).toBe(0);
  });
});

function response(bytes: ArrayBuffer, contentType: string): RequestUrlResponse {
  return {
    status: 200,
    headers: { "content-type": contentType },
    arrayBuffer: bytes,
    text: new TextDecoder().decode(bytes),
    json: null,
  };
}

class SnapshotMemoryVault {
  readonly writeLog: string[] = [];
  private readonly files = new Map<string, { file: TFile; text?: string; binary?: ArrayBuffer }>();
  private readonly folders = new Map<string, TAbstractFile>();

  constructor(private readonly failWritePattern?: RegExp) {}

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  async createFolder(path: string): Promise<void> {
    this.folders.set(path, { path, name: path.split("/").at(-1) ?? path } as TAbstractFile);
  }

  async create(path: string, text: string): Promise<TFile> {
    if (this.failWritePattern?.test(path)) throw new Error("Simulated marker failure");
    const file = fakeFile(path);
    this.files.set(path, { file, text });
    this.writeLog.push(path);
    return file;
  }

  async createBinary(path: string, binary: ArrayBuffer): Promise<TFile> {
    const file = fakeFile(path);
    this.files.set(path, { file, binary });
    this.writeLog.push(path);
    return file;
  }

  async process(file: TFile, callback: (text: string) => string): Promise<void> {
    if (this.failWritePattern?.test(file.path)) throw new Error("Simulated marker failure");
    const record = this.files.get(file.path);
    if (!record) throw new Error("missing file");
    record.text = callback(record.text ?? "");
    this.writeLog.push(file.path);
  }

  async modifyBinary(file: TFile, binary: ArrayBuffer): Promise<void> {
    const record = this.files.get(file.path);
    if (!record) throw new Error("missing file");
    record.binary = binary;
    this.writeLog.push(file.path);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path)?.text ?? "";
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.files.get(file.path)?.binary ?? new ArrayBuffer(0);
  }

  remove(path: string): void {
    this.files.delete(path);
  }
}

function fakeFile(path: string): TFile {
  const name = path.split("/").at(-1) ?? path;
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  return {
    path,
    name,
    basename: extension ? name.slice(0, -(extension.length + 1)) : name,
    extension,
  } as TFile;
}
