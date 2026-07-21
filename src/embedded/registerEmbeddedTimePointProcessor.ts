import { Notice, Plugin, TFile } from "obsidian";
import { t } from "../i18n";
import type { TimePointEntry } from "../model/types";
import type { TimePointSettings } from "../settings/settings";
import type { DayFileRepository } from "../storage";
import { EmbeddedTimePointBlock, renderTimePointBlockConfigError } from "./EmbeddedTimePointBlock";
import { parseTimePointBlockConfig } from "./TimePointBlockConfig";

interface EmbeddedEditorTarget {
  getDate(): string;
  openAddEditor(clickedTime?: string): void;
  openEntryEditor(entry: TimePointEntry): void;
}

interface EmbeddedProcessorHost {
  repository: DayFileRepository;
  settings: TimePointSettings;
  getCurrentDate(): string;
  activateTimePoint(date?: string): Promise<EmbeddedEditorTarget>;
}

/** Register the isolated Reading View implementation for fenced `timepoint` blocks. */
export function registerEmbeddedTimePointProcessor(plugin: Plugin & EmbeddedProcessorHost): void {
  plugin.registerMarkdownCodeBlockProcessor("timepoint", (source, element, context) => {
    const parsed = parseTimePointBlockConfig(source, { today: plugin.getCurrentDate() });
    if (!parsed.ok) {
      renderTimePointBlockConfigError(element, parsed.issues);
      return;
    }

    const child = new EmbeddedTimePointBlock(element, {
      app: plugin.app,
      repository: plugin.repository,
      getSettings: () => plugin.settings,
      config: parsed.config,
      callbacks: {
        onCreateAtTime: async (date, time) => {
          const view = await plugin.activateTimePoint(date);
          if (!confirmActivatedDate(view, date)) return;
          view.openAddEditor(time);
        },
        onCreateNow: async (date) => {
          const view = await plugin.activateTimePoint(date);
          if (!confirmActivatedDate(view, date)) return;
          view.openAddEditor();
        },
        onEditEntry: async (date, entry) => {
          const view = await plugin.activateTimePoint(date);
          if (!confirmActivatedDate(view, date)) return;
          view.openEntryEditor(entry);
        },
        onOpenSource: async (_date, entry) => {
          const path = plugin.repository.getEntrySourcePath(entry);
          const file = plugin.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) {
            new Notice(t("notice.sourceUnavailable", { path }));
            return;
          }
          await plugin.app.workspace.getLeaf("tab").openFile(file);
        },
      },
    });
    context.addChild(child);
  });
}

function confirmActivatedDate(view: EmbeddedEditorTarget, requestedDate: string): boolean {
  if (view.getDate() === requestedDate) return true;
  new Notice("Kept the unsaved timeline draft; the embedded action was cancelled.");
  return false;
}
