import type { TimePointEntry } from "../model/types";
import type { ImportAction, ImportConflictStrategy, ImportPlan } from "./types";
import { validateEntry } from "./validation";

/**
 * Creates a reviewable plan; it never mutates or overwrites the existing list.
 * Duplicate IDs are therefore visible as explicit skip/replace/rename actions.
 */
export function planImport(
  incoming: readonly TimePointEntry[],
  existing: readonly TimePointEntry[],
  strategy: ImportConflictStrategy,
): ImportPlan {
  assertExistingIdsAreUnique(existing);
  assertIncomingIdsAreUnique(incoming);

  const occupied = new Map(existing.map((entry) => [entry.id, entry]));
  const actions: ImportAction[] = [];
  let conflictCount = 0;

  for (const sourceEntry of incoming) {
    const entry = cloneEntry(sourceEntry);
    const reasons = validateEntry(entry);
    if (reasons.length > 0) {
      actions.push({ kind: "reject", entry, reasons });
      continue;
    }

    const conflict = occupied.get(entry.id);
    if (!conflict) {
      actions.push({ kind: "insert", entry });
      occupied.set(entry.id, entry);
      continue;
    }

    conflictCount += 1;
    if (strategy === "skip") {
      actions.push({
        kind: "skip",
        entry,
        conflictingEntry: conflict,
        reason: "duplicate-id",
      });
    } else if (strategy === "replace") {
      actions.push({ kind: "replace", entry, replacedEntry: conflict });
      occupied.set(entry.id, entry);
    } else {
      const originalId = entry.id;
      const renamed = { ...entry, id: makeUniqueImportId(entry.id, occupied) };
      actions.push({
        kind: "rename-and-insert",
        entry: renamed,
        originalId,
        conflictingEntry: conflict,
      });
      occupied.set(renamed.id, renamed);
    }
  }

  return {
    strategy,
    actions,
    insertCount: actions.filter(
      (action) => action.kind === "insert" || action.kind === "rename-and-insert",
    ).length,
    replaceCount: actions.filter((action) => action.kind === "replace").length,
    skipCount: actions.filter((action) => action.kind === "skip").length,
    rejectCount: actions.filter((action) => action.kind === "reject").length,
    conflictCount,
  };
}

function assertIncomingIdsAreUnique(entries: readonly TimePointEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(
        `Cannot create a safe import plan: incoming ID ${entry.id} occurs more than once; nothing was written.`,
      );
    }
    ids.add(entry.id);
  }
}

export function applyImportPlan(
  existing: readonly TimePointEntry[],
  plan: ImportPlan,
): TimePointEntry[] {
  assertExistingIdsAreUnique(existing);
  const result = new Map(existing.map((entry) => [entry.id, cloneEntry(entry)]));
  for (const action of plan.actions) {
    if (
      action.kind === "insert" ||
      action.kind === "replace" ||
      action.kind === "rename-and-insert"
    ) {
      result.set(action.entry.id, cloneEntry(action.entry));
    }
  }
  return [...result.values()].sort(compareEntries);
}

/** Stable in-memory binding between a reviewed import plan and the commit attempt. */
export function fingerprintImportPlans(plans: readonly ImportPlan[]): string {
  return JSON.stringify(plans);
}

function makeUniqueImportId(
  originalId: string,
  occupied: ReadonlyMap<string, TimePointEntry>,
): string {
  let suffix = 1;
  let candidate = withImportSuffix(originalId, suffix);
  while (occupied.has(candidate)) {
    suffix += 1;
    candidate = withImportSuffix(originalId, suffix);
  }
  return candidate;
}

function withImportSuffix(originalId: string, counter: number): string {
  const suffix = `-import-${counter}`;
  return `${originalId.slice(0, 128 - suffix.length)}${suffix}`;
}

function assertExistingIdsAreUnique(entries: readonly TimePointEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      throw new Error(
        `Cannot create a safe import plan: existing ID ${entry.id} occurs more than once.`,
      );
    }
    ids.add(entry.id);
  }
}

function cloneEntry(entry: TimePointEntry): TimePointEntry {
  return { ...entry, tags: [...entry.tags] };
}

function compareEntries(a: TimePointEntry, b: TimePointEntry): number {
  return a.date.localeCompare(b.date) || a.minuteOfDay - b.minuteOfDay || a.id.localeCompare(b.id);
}
