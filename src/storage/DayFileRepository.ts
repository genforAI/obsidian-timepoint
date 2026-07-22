import type { TAbstractFile, TFile, Vault } from "obsidian";
import type {
  EntryMutationExpectation,
  LayoutMutation,
  ParseDiagnostic,
  ParsedDayFile,
  TimePointCardLayout,
  TimePointDayViewState,
  TimePointEntry,
} from "../model/types";
import { isValidDateString } from "../utils/time";
import { planLegacyDayRepair, type LegacyRepairPlan } from "./LegacyRepair";
import {
  DAY_INDEX_BASENAME,
  entryFileName,
  parseStandaloneEntry,
  serializeDayIndex,
  serializeStandaloneEntry,
  preservedDayViewStateBlock,
  updateStandaloneCardLayoutMarkdown,
  updateStandaloneSnapshotIdsMarkdown,
  updateStandaloneEntryMarkdown,
} from "./StandaloneEntryFile";
import { parseSnapshotIds } from "./CardLayoutMetadata";
import { parseDayViewState, sanitizeDayViewState, upsertDayViewState } from "./DayViewState";
import { parseDayFile } from "./TimePointParser";
import { StorageMutationError, serializeDayFile } from "./TimePointSerializer";

export interface DayFileRepositoryOptions {
  getStorageFolder: () => string;
  getTimezone?: () => string | undefined;
  trashFile: (file: TFile) => Promise<void>;
}

export interface LegacyMigrationResult {
  date: string;
  migratedEntries: number;
  safeRepairsAppliedInCopy: number;
  indexPath: string;
  legacyPath?: string;
}

export type ManagedViewStateChange = "none" | "viewport-only" | "render-affecting";

interface ExpectedManagedViewStateWrite {
  markdown: string;
  renderAffecting: boolean;
  expiresAt: number;
}

/**
 * v0.4 repository: one ordinary Markdown file per event, plus one portable
 * `_Timeline.md` index per day. Legacy bounded day files remain readable and
 * migrate non-destructively when a day is next mutated.
 */
export class DayFileRepository {
  private readonly entryPaths = new WeakMap<TimePointEntry, string>();
  private readonly expectedManagedViewStateWrites = new Map<
    string,
    ExpectedManagedViewStateWrite[]
  >();

  constructor(
    private readonly vault: Vault,
    private readonly options: DayFileRepositoryOptions,
  ) {}

  /** Legacy Schema 1 day path retained for compatibility and recovery. */
  getDayPath(date: string): string {
    assertDate(date);
    const [year, month] = date.split("-");
    if (!year || !month) throw new StorageMutationError("INVALID_ENTRY", `Invalid date ${date}.`);
    return `${normalizeStorageFolder(this.options.getStorageFolder())}/${year}/${month}/${date}.md`;
  }

  getEntryFolderPath(date: string): string {
    return this.getDayPath(date).slice(0, -3);
  }

  getDayIndexPath(date: string): string {
    return `${this.getEntryFolderPath(date)}/${DAY_INDEX_BASENAME}.md`;
  }

  getEntrySourcePath(entry: TimePointEntry): string {
    const known = this.entryPaths.get(entry);
    if (known) return known;
    return this.findEntryFiles(entry.date, entry.id)[0]?.path ?? this.getDayPath(entry.date);
  }

  async loadDay(date: string): Promise<ParsedDayFile> {
    assertDate(date);
    const legacyPath = this.getDayPath(date);
    const legacyAbstract = this.vault.getAbstractFileByPath(legacyPath);
    const indexPath = this.getDayIndexPath(date);
    const indexAbstract = this.vault.getAbstractFileByPath(indexPath);
    const folderFiles = this.getDirectEntryFiles(date);

    if (indexAbstract || (!legacyAbstract && folderFiles.length > 0)) {
      return this.loadEntryFileDay(date, indexPath, folderFiles);
    }
    if (legacyAbstract) {
      const file = requireFile(legacyAbstract, legacyPath);
      const markdown = await this.vault.read(file);
      const parsed = parseDayFile(markdown, { expectedDate: date });
      for (const entry of parsed.entries) this.entryPaths.set(entry, legacyPath);
      const repair = planLegacyDayRepair(markdown, date);
      return {
        ...parsed,
        storageLayout: "legacy-day",
        canRepair: repair.canApply,
        viewState: parseDayViewState(markdown).state,
      };
    }
    return {
      ...parseDayFile(serializeDayFile(date, this.options.getTimezone?.()), {
        expectedDate: date,
      }),
      storageLayout: "empty",
      canRepair: false,
      viewState: parseDayViewState("").state,
    };
  }

  /** Persist display geometry without touching body, time, tags, or business `updatedAt`. */
  async updateCardLayout(mutation: LayoutMutation): Promise<ParsedDayFile> {
    await this.ensureEntryLayout(mutation.date);
    const day = await this.loadDay(mutation.date);
    const blocking = day.diagnostics.find((item) => item.severity === "error");
    if (blocking) {
      throw new StorageMutationError(
        "CONFLICT",
        `Card layout write blocked by ${blocking.code}: ${blocking.message}`,
      );
    }
    const file = this.findEntryFile(mutation.date, mutation.entryId);
    if (!file) {
      throw new StorageMutationError(
        "ENTRY_NOT_FOUND",
        `Entry note ${mutation.entryId} does not exist.`,
      );
    }
    const desired = mutation.after;
    const before = mutation.before;
    const assertCurrentLayout = (current: TimePointCardLayout | undefined): void => {
      if (!sameCardLayout(current ?? null, before)) {
        throw new StorageMutationError(
          "CONFLICT",
          `Card layout for ${mutation.entryId} changed externally; reload before moving it.`,
        );
      }
    };

    await this.vault.process(file, (markdown) => {
      const parsed = parseStandaloneEntry(markdown, {
        expectedDate: mutation.date,
        sourcePath: file.path,
      });
      const error = parsed.diagnostics.find((item) => item.severity === "error");
      if (error || !parsed.entry) {
        throw new StorageMutationError(
          "CONFLICT",
          error?.message ?? `Entry note ${mutation.entryId} is no longer readable.`,
        );
      }
      assertCurrentLayout(parsed.entry.cardLayout);
      // Obsidian's processFrontMatter serializes the complete YAML document and
      // changes unrelated quoting/list style. This bounded mutator changes only
      // TimePoint's display extension so all business bytes remain untouched.
      const nextMarkdown = updateStandaloneCardLayoutMarkdown(markdown, desired);
      // The main timeline has already applied this geometry in memory. Mark
      // the exact write so the matching Vault modify event cannot rebuild all
      // mounted Markdown cards after pointer-up. Embedded timelines still see
      // this as render-affecting and refresh their read-only projection.
      this.rememberManagedWrite(file.path, nextMarkdown, true);
      return nextMarkdown;
    });
    return this.loadDay(mutation.date);
  }

  /** Update only the managed hidden index block, preserving the rest of `_Timeline.md`. */
  async updateDayViewState(
    date: string,
    updater: (current: TimePointDayViewState) => TimePointDayViewState,
  ): Promise<TimePointDayViewState> {
    await this.ensureEntryLayout(date);
    const day = await this.loadDay(date);
    const blocking = day.diagnostics.find((item) => item.severity === "error");
    if (blocking) {
      throw new StorageMutationError(
        "CONFLICT",
        `View-state write blocked by ${blocking.code}: ${blocking.message}`,
      );
    }
    const path = this.getDayIndexPath(date);
    const file = requireFile(
      this.vault.getAbstractFileByPath(path) ?? fail(`Day index ${path} is unavailable.`),
      path,
    );
    let committed: TimePointDayViewState | null = null;
    await this.vault.process(file, (markdown) => {
      const parsed = parseDayViewState(markdown);
      if (parsed.status === "future" || parsed.status === "invalid") {
        throw new StorageMutationError(
          "CONFLICT",
          parsed.warning ?? "The day view-state block cannot be changed safely.",
        );
      }
      const next = sanitizeDayViewState(updater(parsed.state));
      if (!next) throw new StorageMutationError("INVALID_ENTRY", "Invalid day view state.");
      committed = next;
      if (JSON.stringify(next) === JSON.stringify(parsed.state)) return markdown;
      const nextMarkdown = upsertDayViewState(markdown, next);
      this.rememberManagedViewStateWrite(path, nextMarkdown, parsed.state, next);
      return nextMarkdown;
    });
    if (!committed) throw new StorageMutationError("CONFLICT", "Day view state was not written.");
    return committed;
  }

  /**
   * Match exact content produced by a managed display-only writer. This lets
   * Vault listeners distinguish internal viewport/layout persistence from an
   * actual external Markdown edit without hiding byte-different changes.
   */
  async classifyManagedViewStateChange(file: TAbstractFile): Promise<ManagedViewStateChange> {
    if (!isFileLike(file)) return "none";
    this.pruneManagedViewStateWrites();
    const expected = this.expectedManagedViewStateWrites.get(file.path);
    if (!expected || expected.length === 0) return "none";
    let current: string;
    try {
      current = await this.vault.cachedRead(file);
    } catch {
      this.expectedManagedViewStateWrites.delete(file.path);
      return "none";
    }
    const match = [...expected].reverse().find((candidate) => candidate.markdown === current);
    if (!match) {
      this.expectedManagedViewStateWrites.delete(file.path);
      return "none";
    }
    return match.renderAffecting ? "render-affecting" : "viewport-only";
  }

  private rememberManagedViewStateWrite(
    path: string,
    markdown: string,
    previous: TimePointDayViewState,
    next: TimePointDayViewState,
  ): void {
    this.rememberManagedWrite(path, markdown, !viewStateIsViewportOnlyChange(previous, next));
  }

  private rememberManagedWrite(path: string, markdown: string, renderAffecting: boolean): void {
    this.pruneManagedViewStateWrites();
    const expected = this.expectedManagedViewStateWrites.get(path) ?? [];
    expected.push({
      markdown,
      renderAffecting,
      expiresAt: Date.now() + 5_000,
    });
    this.expectedManagedViewStateWrites.set(path, expected.slice(-4));
  }

  private pruneManagedViewStateWrites(now = Date.now()): void {
    for (const [path, writes] of this.expectedManagedViewStateWrites) {
      const active = writes.filter((write) => write.expiresAt >= now);
      if (active.length > 0) this.expectedManagedViewStateWrites.set(path, active);
      else this.expectedManagedViewStateWrites.delete(path);
    }
  }

  /** Associate only completed snapshots without rewriting the event note body. */
  async updateLinkSnapshotIds(
    entry: TimePointEntry,
    nextIds: readonly string[],
  ): Promise<ParsedDayFile> {
    await this.ensureEntryLayout(entry.date);
    const file = this.findEntryFile(entry.date, entry.id);
    if (!file) {
      throw new StorageMutationError("ENTRY_NOT_FOUND", `Entry note ${entry.id} does not exist.`);
    }
    const expected = [...(entry.linkSnapshotIds ?? [])].sort();
    const next = parseSnapshotIds(nextIds);
    if (JSON.stringify(expected) === JSON.stringify(next)) return this.loadDay(entry.date);
    const assertCurrent = (current: readonly string[]): void => {
      if (JSON.stringify([...current].sort()) !== JSON.stringify(expected)) {
        throw new StorageMutationError(
          "CONFLICT",
          `Snapshot associations for ${entry.id} changed externally; reload before refreshing relations.`,
        );
      }
    };
    await this.vault.process(file, (markdown) => {
      const parsed = parseStandaloneEntry(markdown, { expectedDate: entry.date });
      if (!parsed.entry) {
        throw new StorageMutationError("CONFLICT", `Entry note ${entry.id} is unreadable.`);
      }
      assertCurrent(parsed.entry.linkSnapshotIds ?? []);
      return updateStandaloneSnapshotIdsMarkdown(markdown, next);
    });
    return this.loadDay(entry.date);
  }

  async addEntry(entry: TimePointEntry): Promise<ParsedDayFile> {
    await this.ensureEntryLayout(entry.date);
    const path = `${this.getEntryFolderPath(entry.date)}/${entryFileName(entry)}`;
    if (this.findEntryFiles(entry.date, entry.id).length > 0) {
      throw new StorageMutationError(
        "DUPLICATE_ID",
        `An entry note with ID ${entry.id} already exists in this day.`,
      );
    }
    if (this.vault.getAbstractFileByPath(path)) {
      throw new StorageMutationError("CONFLICT", `A different note already exists at ${path}.`);
    }
    await this.vault.create(path, serializeStandaloneEntry(entry));
    this.entryPaths.set(entry, path);
    await this.rebuildDayIndex(entry.date);
    return this.loadDay(entry.date);
  }

  async updateEntry(
    entry: TimePointEntry,
    expectation: EntryMutationExpectation = {},
  ): Promise<ParsedDayFile> {
    await this.ensureEntryLayout(entry.date);
    const file = this.findEntryFile(entry.date, entry.id);
    if (!file) {
      throw new StorageMutationError("ENTRY_NOT_FOUND", `Entry note ${entry.id} does not exist.`);
    }
    const oldPath = file.path;
    await this.vault.process(file, (currentMarkdown) => {
      assertStandaloneExpectation(currentMarkdown, entry.id, expectation);
      return updateStandaloneEntryMarkdown(currentMarkdown, entry);
    });
    const desiredPath = `${this.getEntryFolderPath(entry.date)}/${entryFileName(entry)}`;
    if (desiredPath !== oldPath) {
      const collision = this.vault.getAbstractFileByPath(desiredPath);
      if (collision) {
        throw new StorageMutationError(
          "CONFLICT",
          `Cannot rename entry note; ${desiredPath} exists.`,
        );
      }
      await this.vault.rename(file, desiredPath);
    }
    this.entryPaths.set(entry, desiredPath);
    await this.rebuildDayIndex(entry.date);
    return this.loadDay(entry.date);
  }

  async deleteEntry(
    date: string,
    id: string,
    expectation: EntryMutationExpectation = {},
  ): Promise<ParsedDayFile> {
    await this.ensureEntryLayout(date);
    const file = this.findEntryFile(date, id);
    if (!file)
      throw new StorageMutationError("ENTRY_NOT_FOUND", `Entry note ${id} does not exist.`);
    const currentMarkdown = await this.vault.read(file);
    assertStandaloneExpectation(currentMarkdown, id, expectation);
    await this.options.trashFile(file);
    await this.rebuildDayIndex(date);
    return this.loadDay(date);
  }

  async getLegacyRepairPlan(date: string): Promise<LegacyRepairPlan | null> {
    const path = this.getDayPath(date);
    const abstract = this.vault.getAbstractFileByPath(path);
    if (!abstract) return null;
    const file = requireFile(abstract, path);
    return planLegacyDayRepair(await this.vault.read(file), date);
  }

  async repairLegacyDay(date: string): Promise<ParsedDayFile> {
    const path = this.getDayPath(date);
    const abstract = this.vault.getAbstractFileByPath(path);
    if (!abstract)
      throw new StorageMutationError("ENTRY_NOT_FOUND", `Legacy day ${path} is absent.`);
    const file = requireFile(abstract, path);
    await this.vault.process(file, (currentMarkdown) => {
      const plan = planLegacyDayRepair(currentMarkdown, date);
      if (!plan.canApply) {
        throw new StorageMutationError(
          "CONFLICT",
          "No fully safe automatic repair is available; the file was not changed.",
        );
      }
      return plan.repairedMarkdown;
    });
    return this.loadDay(date);
  }

  async migrateLegacyDay(date: string): Promise<LegacyMigrationResult> {
    assertDate(date);
    const indexPath = this.getDayIndexPath(date);
    if (this.vault.getAbstractFileByPath(indexPath)) {
      const day = await this.loadDay(date);
      return {
        date,
        migratedEntries: day.entries.length,
        safeRepairsAppliedInCopy: 0,
        indexPath,
        ...(this.vault.getAbstractFileByPath(this.getDayPath(date))
          ? { legacyPath: this.getDayPath(date) }
          : {}),
      };
    }

    const legacyPath = this.getDayPath(date);
    const legacyAbstract = this.vault.getAbstractFileByPath(legacyPath);
    if (!legacyAbstract) {
      await this.ensureNestedFolders(this.getEntryFolderPath(date));
      await this.vault.create(indexPath, serializeDayIndex(date, [], this.options.getTimezone?.()));
      return { date, migratedEntries: 0, safeRepairsAppliedInCopy: 0, indexPath };
    }

    const legacyFile = requireFile(legacyAbstract, legacyPath);
    const original = await this.vault.read(legacyFile);
    const repair = planLegacyDayRepair(original, date);
    const candidate = repair.canApply ? repair.repairedMarkdown : original;
    const parsed = parseDayFile(candidate, { expectedDate: date });
    const error = parsed.diagnostics.find((item) => item.severity === "error");
    if (error) {
      throw new StorageMutationError(
        "CONFLICT",
        `Legacy migration blocked: ${error.code}: ${error.message}`,
      );
    }

    await this.ensureNestedFolders(this.getEntryFolderPath(date));
    for (const entry of parsed.entries) {
      const path = `${this.getEntryFolderPath(date)}/${entryFileName(entry)}`;
      const existing = this.vault.getAbstractFileByPath(path);
      const serialized = serializeStandaloneEntry(entry, original.includes("\r\n") ? "\r\n" : "\n");
      if (existing) {
        const existingFile = requireFile(existing, path);
        if ((await this.vault.read(existingFile)) !== serialized) {
          throw new StorageMutationError(
            "CONFLICT",
            `Migration stopped because ${path} already contains different data.`,
          );
        }
      } else {
        await this.vault.create(path, serialized);
      }
      this.entryPaths.set(entry, path);
    }

    const index = serializeDayIndex(
      date,
      parsed.entries,
      parsed.timezone ?? this.options.getTimezone?.(),
      legacyPath,
    );
    await this.vault.create(indexPath, index);
    return {
      date,
      migratedEntries: parsed.entries.length,
      safeRepairsAppliedInCopy: repair.canApply ? repair.changes.length : 0,
      indexPath,
      legacyPath,
    };
  }

  async openOrCreateDayIndex(date: string): Promise<TFile> {
    await this.ensureEntryLayout(date);
    const path = this.getDayIndexPath(date);
    const file = this.vault.getAbstractFileByPath(path);
    return requireFile(file ?? fail(`Day index ${path} was not created.`), path);
  }

  private async ensureEntryLayout(date: string): Promise<void> {
    if (this.vault.getAbstractFileByPath(this.getDayIndexPath(date))) return;
    await this.migrateLegacyDay(date);
  }

  private async loadEntryFileDay(
    date: string,
    indexPath: string,
    files = this.getDirectEntryFiles(date),
  ): Promise<ParsedDayFile> {
    const diagnostics: ParseDiagnostic[] = [];
    const entries: TimePointEntry[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const parsed = parseStandaloneEntry(await this.vault.cachedRead(file), {
        expectedDate: date,
        sourcePath: file.path,
        fallbackUpdatedAt: new Date(file.stat.mtime).toISOString(),
      });
      diagnostics.push(...parsed.diagnostics);
      if (!parsed.entry) continue;
      if (seen.has(parsed.entry.id)) {
        diagnostics.push({
          severity: "error",
          code: "DUPLICATE_ID",
          message: `Duplicate entry ID ${parsed.entry.id}; ${file.path} was ignored.`,
          entryId: parsed.entry.id,
          sourcePath: file.path,
        });
        continue;
      }
      seen.add(parsed.entry.id);
      entries.push(parsed.entry);
      this.entryPaths.set(parsed.entry, file.path);
    }
    entries.sort(
      (left, right) =>
        left.minuteOfDay - right.minuteOfDay ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
    const indexAbstract = this.vault.getAbstractFileByPath(indexPath);
    const rawMarkdown = indexAbstract
      ? await this.vault.cachedRead(requireFile(indexAbstract, indexPath))
      : "";
    const parsedViewState = parseDayViewState(rawMarkdown);
    if (parsedViewState.warning) {
      diagnostics.push({
        severity: "warning",
        code: "INVALID_VIEW_STATE",
        message: parsedViewState.warning,
        sourcePath: indexPath,
      });
    }
    return {
      schemaVersion: 2,
      date,
      timezone: entries.find((entry) => entry.timezone)?.timezone ?? this.options.getTimezone?.(),
      entries,
      diagnostics,
      rawMarkdown,
      storageLayout: "entry-files",
      indexPath,
      canRepair: false,
      viewState: parsedViewState.state,
    };
  }

  private getDirectEntryFiles(date: string): TFile[] {
    const folder = this.vault.getFolderByPath(this.getEntryFolderPath(date));
    if (!folder) return [];
    return folder.children
      .filter(
        (file): file is TFile =>
          isFileLike(file) &&
          file.extension.toLowerCase() === "md" &&
          file.basename !== DAY_INDEX_BASENAME &&
          !file.basename.startsWith("_"),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private findEntryFile(date: string, id: string): TFile | undefined {
    const matches = this.findEntryFiles(date, id);
    if (matches.length > 1) {
      throw new StorageMutationError(
        "DUPLICATE_ID",
        `Entry ID ${id} appears in ${matches.length} separate notes; resolve the duplicate before editing.`,
      );
    }
    return matches[0];
  }

  private findEntryFiles(date: string, id: string): TFile[] {
    return this.getDirectEntryFiles(date).filter(
      (file) => file.basename === id || file.basename.endsWith(`--${id}`),
    );
  }

  private async rebuildDayIndex(date: string): Promise<void> {
    const loaded = await this.loadEntryFileDay(date, this.getDayIndexPath(date));
    const path = this.getDayIndexPath(date);
    const content = serializeDayIndex(
      date,
      loaded.entries,
      loaded.timezone ?? this.options.getTimezone?.(),
      this.vault.getAbstractFileByPath(this.getDayPath(date)) ? this.getDayPath(date) : undefined,
      preservedDayViewStateBlock(loaded.rawMarkdown),
    );
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing) {
      await this.vault.process(requireFile(existing, path), () => content);
    } else {
      await this.vault.create(path, content);
    }
  }

  private async ensureNestedFolders(path: string): Promise<void> {
    const segments = path.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.vault.getAbstractFileByPath(current);
      if (existing) {
        if (isFileLike(existing)) {
          throw new StorageMutationError(
            "CONFLICT",
            `Cannot create folder ${current}; a file already uses that path.`,
          );
        }
        continue;
      }
      try {
        await this.vault.createFolder(current);
      } catch (error) {
        const racedFolder = this.vault.getAbstractFileByPath(current);
        if (!racedFolder || isFileLike(racedFolder)) throw error;
      }
    }
  }
}

function sameCardLayout(
  left: TimePointCardLayout | null,
  right: TimePointCardLayout | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.updatedAt === right.updatedAt
  );
}

function viewStateIsViewportOnlyChange(
  previous: TimePointDayViewState,
  next: TimePointDayViewState,
): boolean {
  return (
    previous.schemaVersion === next.schemaVersion &&
    previous.minimapExpanded === next.minimapExpanded &&
    previous.relationsEnabled === next.relationsEnabled &&
    JSON.stringify(previous.stackOrder) === JSON.stringify(next.stackOrder) &&
    JSON.stringify(previous.referenceCards) === JSON.stringify(next.referenceCards)
  );
}

export function normalizeStorageFolder(folder: string): string {
  const segments = folder
    .replace(/\\/gu, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return "TimePoint/Days";
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new StorageMutationError(
      "INVALID_ENTRY",
      "Storage folder cannot contain . or .. path segments.",
    );
  }
  return segments.join("/");
}

function assertStandaloneExpectation(
  currentMarkdown: string,
  entryId: string,
  expectation: EntryMutationExpectation,
): void {
  if (
    expectation.expectedSourceBlock !== undefined &&
    expectation.expectedSourceBlock !== currentMarkdown
  ) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry note ${entryId} changed after it was opened; reload before replacing or deleting it.`,
    );
  }
  const current = parseStandaloneEntry(currentMarkdown).entry;
  if (!current) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry note ${entryId} is no longer a valid TimePoint note.`,
    );
  }
  if (
    expectation.expectedUpdatedAt !== undefined &&
    current.updatedAt !== expectation.expectedUpdatedAt
  ) {
    throw new StorageMutationError("CONFLICT", `Entry note ${entryId} updatedAt mismatch.`);
  }
  if (expectation.expectedTime !== undefined && current.time !== expectation.expectedTime) {
    throw new StorageMutationError("CONFLICT", `Entry note ${entryId} time mismatch.`);
  }
  if (
    expectation.expectedContentMarkdown !== undefined &&
    current.contentMarkdown !== expectation.expectedContentMarkdown
  ) {
    throw new StorageMutationError("CONFLICT", `Entry note ${entryId} content mismatch.`);
  }
  if (!expectation.expectedEntry) return;
  if (current.id !== expectation.expectedEntry.id) {
    throw new StorageMutationError("CONFLICT", `Entry note ${entryId} no longer matches its ID.`);
  }
  if (entryFingerprint(current) !== entryFingerprint(expectation.expectedEntry)) {
    throw new StorageMutationError(
      "CONFLICT",
      `Entry note ${entryId} changed after it was opened; reload before replacing or deleting it.`,
    );
  }
}

function entryFingerprint(entry: TimePointEntry): string {
  return JSON.stringify({
    ...entry,
    tags: [...entry.tags].sort(),
  });
}

function requireFile(file: TAbstractFile, path: string): TFile {
  if (!isFileLike(file)) {
    throw new StorageMutationError("CONFLICT", `Expected a Markdown file at ${path}.`);
  }
  if (file.extension.toLowerCase() !== "md") {
    throw new StorageMutationError("CONFLICT", `Expected a Markdown file at ${path}.`);
  }
  return file;
}

function isFileLike(file: TAbstractFile): file is TFile {
  return "extension" in file && typeof (file as { extension?: unknown }).extension === "string";
}

function assertDate(date: string): void {
  if (!isValidDateString(date)) {
    throw new StorageMutationError("INVALID_ENTRY", `Invalid date ${date}.`);
  }
}

function fail(message: string): never {
  throw new StorageMutationError("ENTRY_NOT_FOUND", message);
}
