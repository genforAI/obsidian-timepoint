import type { LayoutMutation, LayoutUndoEntry } from "../model/types";

export class LayoutHistory {
  private undoStack: LayoutUndoEntry[] = [];
  private redoStack: LayoutUndoEntry[] = [];

  constructor(private readonly maximumEntries = 100) {}

  push(mutation: LayoutMutation, committedAt = new Date().toISOString()): LayoutUndoEntry {
    const entry: LayoutUndoEntry = { ...cloneMutation(mutation), committedAt };
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maximumEntries) this.undoStack.shift();
    this.redoStack = [];
    return entry;
  }

  takeUndo(date: string): LayoutUndoEntry | null {
    const index = findLastIndex(this.undoStack, (entry) => entry.date === date);
    if (index < 0) return null;
    const [entry] = this.undoStack.splice(index, 1);
    if (!entry) return null;
    this.redoStack.push(entry);
    return cloneUndoEntry(entry);
  }

  takeRedo(date: string): LayoutUndoEntry | null {
    const index = findLastIndex(this.redoStack, (entry) => entry.date === date);
    if (index < 0) return null;
    const [entry] = this.redoStack.splice(index, 1);
    if (!entry) return null;
    this.undoStack.push(entry);
    return cloneUndoEntry(entry);
  }

  restoreFailedUndo(entry: LayoutUndoEntry): void {
    removeIdentity(this.redoStack, entry);
    this.undoStack.push(cloneUndoEntry(entry));
  }

  restoreFailedRedo(entry: LayoutUndoEntry): void {
    removeIdentity(this.undoStack, entry);
    this.redoStack.push(cloneUndoEntry(entry));
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

export function inverseLayoutMutation(
  entry: LayoutUndoEntry,
  current = entry.after,
): LayoutMutation {
  return {
    date: entry.date,
    entryId: entry.entryId,
    before: current ? { ...current } : null,
    after: entry.before ? { ...entry.before, updatedAt: new Date().toISOString() } : null,
    reason: entry.reason,
  };
}

export function redoLayoutMutation(entry: LayoutUndoEntry, current = entry.before): LayoutMutation {
  return {
    date: entry.date,
    entryId: entry.entryId,
    before: current ? { ...current } : null,
    after: entry.after ? { ...entry.after, updatedAt: new Date().toISOString() } : null,
    reason: entry.reason,
  };
}

function cloneMutation(mutation: LayoutMutation): LayoutMutation {
  return {
    ...mutation,
    before: mutation.before ? { ...mutation.before } : null,
    after: mutation.after ? { ...mutation.after } : null,
  };
}

function cloneUndoEntry(entry: LayoutUndoEntry): LayoutUndoEntry {
  return { ...cloneMutation(entry), committedAt: entry.committedAt };
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return index;
  }
  return -1;
}

function removeIdentity(values: LayoutUndoEntry[], target: LayoutUndoEntry): void {
  const index = values.findIndex(
    (entry) =>
      entry.date === target.date &&
      entry.entryId === target.entryId &&
      entry.committedAt === target.committedAt,
  );
  if (index >= 0) values.splice(index, 1);
}
