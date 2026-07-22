import type { RequestUrlResponse, TAbstractFile, TFile, Vault } from "obsidian";
import type { TimePointLinkSnapshot } from "../model/types";
import { normalizeExternalUrl } from "../relations/markdownLinks";

const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const HOST_INTERVAL_MS = 1_000;

export interface SnapshotRequestClient {
  (request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    throw?: boolean;
  }): Promise<RequestUrlResponse>;
}

export interface ExternalSnapshotServiceOptions {
  vault: Vault;
  request: SnapshotRequestClient;
  snapshotsFolder?: string;
  now?: () => Date;
  convertPreview?: (bytes: ArrayBuffer, mime: string) => Promise<ArrayBuffer | null>;
  /** Test seams; production always uses the documented safety defaults. */
  maximumConcurrentRequests?: number;
  hostIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface SnapshotLookupResult {
  status: "cached" | "fetched" | "blocked" | "offline";
  normalizedUrl?: string;
  reason?: string;
  snapshot?: TimePointLinkSnapshot;
}

interface InFlightSnapshotOperation {
  sourceEntryIds: Set<string>;
  promise: Promise<SnapshotLookupResult>;
}

export class ExternalSnapshotService {
  private readonly vault: Vault;
  private readonly request: SnapshotRequestClient;
  private readonly snapshotsFolder: string;
  private readonly now: () => Date;
  private readonly convertPreview: (
    bytes: ArrayBuffer,
    mime: string,
  ) => Promise<ArrayBuffer | null>;
  private readonly maximumConcurrentRequests: number;
  private readonly hostIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly inFlight = new Map<string, InFlightSnapshotOperation>();
  private readonly sourceMergeChains = new Map<string, Promise<TimePointLinkSnapshot>>();
  private readonly hostReadyAt = new Map<string, number>();
  private activeRequests = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: ExternalSnapshotServiceOptions) {
    this.vault = options.vault;
    this.request = options.request;
    this.snapshotsFolder = (options.snapshotsFolder ?? "TimePoint/Snapshots").replace(/\/+$/u, "");
    this.now = options.now ?? (() => new Date());
    this.convertPreview = options.convertPreview ?? convertImageToWebp;
    this.maximumConcurrentRequests = options.maximumConcurrentRequests ?? 2;
    this.hostIntervalMs = options.hostIntervalMs ?? HOST_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async getOrCreate(
    originalUrl: string,
    sourceEntryIds: readonly string[],
    allowNetwork: boolean,
    refresh = false,
  ): Promise<SnapshotLookupResult> {
    const validation = validatePublicHttpsUrl(originalUrl);
    if (!validation.ok) return { status: "blocked", reason: validation.reason };
    const normalizedUrl = validation.normalizedUrl;
    if (allowNetwork) {
      const running = this.inFlight.get(normalizedUrl);
      if (running) {
        addSourceIds(running.sourceEntryIds, sourceEntryIds);
        return running.promise;
      }
      const accumulatedSourceIds = new Set<string>();
      addSourceIds(accumulatedSourceIds, sourceEntryIds);
      const operation = this.performLookup(
        originalUrl,
        normalizedUrl,
        accumulatedSourceIds,
        refresh,
      );
      const record: InFlightSnapshotOperation = {
        sourceEntryIds: accumulatedSourceIds,
        promise: operation,
      };
      this.inFlight.set(normalizedUrl, record);
      void operation
        .finally(() => {
          if (this.inFlight.get(normalizedUrl) === record) this.inFlight.delete(normalizedUrl);
        })
        .catch(() => undefined);
      return operation;
    }

    const id = await sha256Hex(normalizedUrl);
    const cached = await this.readSnapshot(id);
    if (cached && !refresh) {
      const merged = await this.mergeSnapshotSourceIds(id, sourceEntryIds);
      return { status: "cached", normalizedUrl, snapshot: merged };
    }
    return {
      status: "blocked",
      normalizedUrl,
      reason: "External snapshot networking has not been authorized.",
    };
  }

  private async performLookup(
    originalUrl: string,
    normalizedUrl: string,
    sourceEntryIds: Set<string>,
    refresh: boolean,
  ): Promise<SnapshotLookupResult> {
    const id = await sha256Hex(normalizedUrl);
    const cached = await this.readSnapshot(id);
    let result: SnapshotLookupResult;
    if (cached && !refresh) {
      result = { status: "cached", normalizedUrl, snapshot: cached };
    } else {
      result = await this.withConcurrency(async () => {
        try {
          return await this.fetchAndStore(
            id,
            originalUrl,
            normalizedUrl,
            [...sourceEntryIds],
            cached,
          );
        } catch (error) {
          return {
            status: "offline" as const,
            normalizedUrl,
            reason: error instanceof Error ? error.message : "External snapshot request failed.",
            ...(cached ? { snapshot: cached } : {}),
          };
        }
      });
    }
    if (!result.snapshot) return result;
    let merged = result.snapshot;
    let appliedSignature = "";
    // Callers register their source IDs synchronously before joining this
    // promise. Repeat only if another caller joined while the marker write was
    // awaiting the Vault, then resolve every joined caller with the same union.
    while (true) {
      const pending = normalizeSourceIds([...sourceEntryIds]);
      const signature = pending.join("\u0000");
      if (signature === appliedSignature) break;
      merged = await this.mergeSnapshotSourceIds(id, pending);
      appliedSignature = signature;
    }
    return { ...result, snapshot: merged };
  }

  async readSnapshot(id: string): Promise<TimePointLinkSnapshot | null> {
    if (!/^[a-f0-9]{64}$/u.test(id)) return null;
    const path = `${this.snapshotsFolder}/${id}/snapshot.md`;
    const file = this.vault.getAbstractFileByPath(path);
    if (!isFile(file)) return null;
    try {
      const snapshot = parseSnapshotMarkdown(await this.vault.cachedRead(file), path);
      if (!snapshot || snapshot.id !== id) return null;
      const normalized = validatePublicHttpsUrl(snapshot.normalizedUrl);
      if (!normalized.ok || normalized.normalizedUrl !== snapshot.normalizedUrl) return null;
      const original = validatePublicHttpsUrl(snapshot.originalUrl);
      if (!original.ok || original.normalizedUrl !== snapshot.normalizedUrl) return null;
      if ((await sha256Hex(snapshot.normalizedUrl)) !== id) return null;
      const expectedPreview = `${this.snapshotsFolder}/${id}/preview.webp`;
      if (snapshot.previewPath && snapshot.previewPath !== expectedPreview) return null;
      if (snapshot.previewPath) {
        const preview = this.vault.getAbstractFileByPath(snapshot.previewPath);
        if (!isFile(preview)) return null;
        const bytes = await this.vault.readBinary(preview);
        if (bytes.byteLength > MAX_IMAGE_BYTES || !matchesImageMagic(bytes, "image/webp")) {
          return null;
        }
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  private async fetchAndStore(
    id: string,
    originalUrl: string,
    normalizedUrl: string,
    sourceEntryIds: readonly string[],
    previous: TimePointLinkSnapshot | null,
  ): Promise<SnapshotLookupResult> {
    const host = new URL(normalizedUrl).hostname;
    await this.waitForHost(host);
    const response = await withTimeout(
      this.request({
        url: normalizedUrl,
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9",
          "Cache-Control": "no-cache",
        },
        throw: false,
      }),
      this.requestTimeoutMs,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Snapshot target returned HTTP ${response.status}.`);
    }
    if (response.arrayBuffer.byteLength > MAX_HTML_BYTES) {
      throw new Error("Snapshot HTML exceeds the 512 KiB safety limit.");
    }
    const contentType = header(response.headers, "content-type").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("Snapshot target is not an HTML document.");
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(response.arrayBuffer);
    const metadata = extractPageMetadata(html, normalizedUrl);
    const contentHash = await sha256Hex(new Uint8Array(response.arrayBuffer));
    let previewBytes: ArrayBuffer | null = null;
    if (metadata.imageUrl) {
      const imageValidation = validatePublicHttpsUrl(metadata.imageUrl);
      if (imageValidation.ok) {
        try {
          previewBytes = await this.fetchPreview(imageValidation.normalizedUrl);
        } catch {
          previewBytes = null;
        }
      }
    }
    const folder = `${this.snapshotsFolder}/${id}`;
    await ensureFolder(this.vault, folder);
    let previewPath: string | undefined;
    if (previewBytes) {
      previewPath = `${folder}/preview.webp`;
      const existingPreview = this.vault.getAbstractFileByPath(previewPath);
      if (isFile(existingPreview)) {
        await this.vault.modifyBinary(existingPreview, previewBytes);
      } else {
        await this.vault.createBinary(previewPath, previewBytes);
      }
    } else if (previous?.previewPath) {
      previewPath = previous.previewPath;
    }
    const snapshot: TimePointLinkSnapshot = {
      id,
      originalUrl,
      normalizedUrl,
      title: metadata.title || new URL(normalizedUrl).hostname,
      description: metadata.description,
      fetchedAt: this.now().toISOString(),
      contentHash,
      sourceEntryIds: normalizeSourceIds(sourceEntryIds),
      snapshotPath: `${folder}/snapshot.md`,
      ...(previewPath ? { previewPath } : {}),
    };
    // The Markdown marker is deliberately committed after every optional asset.
    await this.writeSnapshotMarkdown(snapshot);
    return { status: "fetched", normalizedUrl, snapshot };
  }

  private async fetchPreview(url: string): Promise<ArrayBuffer | null> {
    const host = new URL(url).hostname;
    await this.waitForHost(host);
    const response = await withTimeout(
      this.request({
        url,
        method: "GET",
        headers: { Accept: "image/webp,image/png,image/jpeg" },
        throw: false,
      }),
      this.requestTimeoutMs,
    );
    if (response.status < 200 || response.status >= 300) return null;
    if (response.arrayBuffer.byteLength > MAX_IMAGE_BYTES) return null;
    const mime = header(response.headers, "content-type").split(";", 1)[0]?.trim().toLowerCase();
    if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) return null;
    if (!matchesImageMagic(response.arrayBuffer, mime)) return null;
    const converted = await this.convertPreview(response.arrayBuffer, mime);
    if (!converted || converted.byteLength > MAX_IMAGE_BYTES) return null;
    return matchesImageMagic(converted, "image/webp") ? converted : null;
  }

  private async writeSnapshotMarkdown(snapshot: TimePointLinkSnapshot): Promise<void> {
    const markdown = serializeSnapshotMarkdown(snapshot);
    const existing = this.vault.getAbstractFileByPath(snapshot.snapshotPath);
    if (isFile(existing)) {
      await this.vault.process(existing, () => markdown);
    } else {
      await this.vault.create(snapshot.snapshotPath, markdown);
    }
  }

  /**
   * Association updates for one completed snapshot are serialized. Without
   * this chain, concurrent cache hits can all read the same marker and the
   * final writer can silently discard source IDs written by its siblings.
   */
  private async mergeSnapshotSourceIds(
    id: string,
    sourceEntryIds: readonly string[],
  ): Promise<TimePointLinkSnapshot> {
    const previous = this.sourceMergeChains.get(id);
    const gate = previous
      ? previous.then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
    const operation = gate.then(async () => {
      const current = await this.readSnapshot(id);
      if (!current) {
        throw new Error("Snapshot changed while its source associations were being updated.");
      }
      const merged = mergeSourceIds(current, sourceEntryIds);
      if (merged !== current) await this.writeSnapshotMarkdown(merged);
      return merged;
    });
    this.sourceMergeChains.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.sourceMergeChains.get(id) === operation) this.sourceMergeChains.delete(id);
    }
  }

  private async withConcurrency<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeRequests >= this.maximumConcurrentRequests) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeRequests += 1;
    try {
      return await operation();
    } finally {
      this.activeRequests -= 1;
      this.queue.shift()?.();
    }
  }

  private async waitForHost(host: string): Promise<void> {
    const now = Date.now();
    const readyAt = Math.max(now, this.hostReadyAt.get(host) ?? 0);
    this.hostReadyAt.set(host, readyAt + this.hostIntervalMs);
    const delay = readyAt - now;
    if (delay > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
  }
}

export type PublicUrlValidation =
  { ok: true; normalizedUrl: string } | { ok: false; reason: string };

export function validatePublicHttpsUrl(input: string): PublicUrlValidation {
  const normalizedUrl = normalizeExternalUrl(input);
  if (!normalizedUrl) {
    return { ok: false, reason: "Only public HTTPS URLs without credentials are supported." };
  }
  const hostname = new URL(normalizedUrl).hostname.toLowerCase().replace(/\.$/u, "");
  if (
    hostname === "localhost" ||
    !hostname.includes(".") ||
    /\.(?:local|localhost|internal|home|lan|test|example|invalid|onion)$/u.test(hostname)
  ) {
    return { ok: false, reason: "Local and reserved hostnames are blocked." };
  }
  if (hostname.startsWith("[") || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname)) {
    return { ok: false, reason: "IP-address URLs are blocked." };
  }
  return { ok: true, normalizedUrl };
}

export function extractPageMetadata(
  html: string,
  baseUrl: string,
): { title: string; description: string; imageUrl?: string } {
  const document =
    typeof DOMParser === "undefined" ? null : new DOMParser().parseFromString(html, "text/html");
  const readMeta = (name: string): string => {
    if (document) {
      const escaped = cssEscape(name);
      return (
        document.querySelector(`meta[property="${escaped}"]`)?.getAttribute("content") ??
        document.querySelector(`meta[name="${escaped}"]`)?.getAttribute("content") ??
        ""
      );
    }
    return regexMeta(html, name);
  };
  const rawTitle =
    readMeta("og:title") || document?.querySelector("title")?.textContent || regexTitle(html);
  const rawDescription = readMeta("og:description") || readMeta("description");
  const rawImage = readMeta("og:image");
  let imageUrl: string | undefined;
  if (rawImage) {
    try {
      imageUrl = new URL(rawImage, baseUrl).toString();
    } catch {
      imageUrl = undefined;
    }
  }
  return {
    title: cleanMetadataText(rawTitle, 240),
    description: cleanMetadataText(rawDescription, 600),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

export function matchesImageMagic(bytes: ArrayBuffer, mime: string): boolean {
  const view = new Uint8Array(bytes);
  if (mime === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => view[index] === value,
    );
  }
  if (mime === "image/jpeg") return view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
  if (mime === "image/webp") {
    return ascii(view, 0, 4) === "RIFF" && ascii(view, 8, 12) === "WEBP";
  }
  return false;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serializeSnapshotMarkdown(snapshot: TimePointLinkSnapshot): string {
  return [
    "---",
    "timepoint-link-snapshot: 1",
    `id: ${JSON.stringify(snapshot.id)}`,
    `originalUrl: ${JSON.stringify(snapshot.originalUrl)}`,
    `normalizedUrl: ${JSON.stringify(snapshot.normalizedUrl)}`,
    `title: ${JSON.stringify(snapshot.title)}`,
    `description: ${JSON.stringify(snapshot.description)}`,
    `fetchedAt: ${JSON.stringify(snapshot.fetchedAt)}`,
    `contentHash: ${JSON.stringify(snapshot.contentHash)}`,
    `sourceEntryIds: ${JSON.stringify(snapshot.sourceEntryIds)}`,
    ...(snapshot.previewPath ? [`previewPath: ${JSON.stringify(snapshot.previewPath)}`] : []),
    "---",
    "",
    `# ${snapshot.title || new URL(snapshot.normalizedUrl).hostname}`,
    "",
    snapshot.description || "_No description was published._",
    "",
    `[Open original URL](${snapshot.normalizedUrl})`,
    "",
  ].join("\n");
}

export function parseSnapshotMarkdown(
  markdown: string,
  snapshotPath: string,
): TimePointLinkSnapshot | null {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) return null;
  const fields = new Map<string, unknown>();
  for (const line of (match[1] ?? "").split(/\r?\n/u)) {
    const property = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line);
    if (!property?.[1]) continue;
    try {
      fields.set(property[1], JSON.parse(property[2] ?? "null") as unknown);
    } catch {
      fields.set(property[1], property[2]);
    }
  }
  if (fields.get("timepoint-link-snapshot") !== 1) return null;
  const id = fields.get("id");
  const originalUrl = fields.get("originalUrl");
  const normalizedUrl = fields.get("normalizedUrl");
  const title = fields.get("title");
  const description = fields.get("description");
  const fetchedAt = fields.get("fetchedAt");
  const contentHash = fields.get("contentHash");
  const sourceEntryIds = fields.get("sourceEntryIds");
  const previewPath = fields.get("previewPath");
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(id) ||
    typeof originalUrl !== "string" ||
    originalUrl.length > 4096 ||
    typeof normalizedUrl !== "string" ||
    normalizedUrl.length > 4096 ||
    typeof title !== "string" ||
    title.length > 240 ||
    typeof description !== "string" ||
    description.length > 600 ||
    typeof fetchedAt !== "string" ||
    Number.isNaN(Date.parse(fetchedAt)) ||
    typeof contentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(contentHash) ||
    !Array.isArray(sourceEntryIds)
  ) {
    return null;
  }
  return {
    id,
    originalUrl,
    normalizedUrl,
    title,
    description,
    fetchedAt,
    contentHash,
    sourceEntryIds: normalizeSourceIds(sourceEntryIds),
    snapshotPath,
    ...(typeof previewPath === "string" ? { previewPath } : {}),
  };
}

function mergeSourceIds(
  snapshot: TimePointLinkSnapshot,
  sourceEntryIds: readonly string[],
): TimePointLinkSnapshot {
  const merged = normalizeSourceIds([...snapshot.sourceEntryIds, ...sourceEntryIds]);
  return merged.length === snapshot.sourceEntryIds.length &&
    merged.every((id, index) => id === snapshot.sourceEntryIds[index])
    ? snapshot
    : { ...snapshot, sourceEntryIds: merged };
}

function normalizeSourceIds(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(value),
      ),
    ),
  ]
    .sort()
    .slice(0, 500);
}

function addSourceIds(target: Set<string>, values: readonly unknown[]): void {
  for (const id of normalizeSourceIds(values)) {
    if (target.size >= 500) break;
    target.add(id);
  }
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("Snapshot request timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function convertImageToWebp(bytes: ArrayBuffer, mime: string): Promise<ArrayBuffer | null> {
  if (mime === "image/webp") return bytes;
  if (typeof createImageBitmap === "undefined" || typeof document === "undefined") return null;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    const scale = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
    const canvas = createEl("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.82),
    );
    return blob ? blob.arrayBuffer() : null;
  } finally {
    bitmap.close();
  }
}

function header(headers: Record<string, string>, name: string): string {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ?? "";
}

function regexMeta(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "iu",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "iu",
    ),
  ];
  return decodeEntities(
    patterns.map((pattern) => pattern.exec(html)?.[1] ?? "").find(Boolean) ?? "",
  );
}

function regexTitle(html: string): string {
  return decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? "");
}

function cleanMetadataText(value: string | null | undefined, maximum: number): string {
  return decodeEntities(value ?? "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function isFile(file: TAbstractFile | null): file is TFile {
  return Boolean(file && "extension" in file && typeof file.extension === "string");
}
