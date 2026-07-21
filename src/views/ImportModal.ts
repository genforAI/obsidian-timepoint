import { App, Modal, Notice } from "obsidian";
import {
  parseTimePointCsv,
  parseTimePointJson,
  parseTimePointMarkdown,
  type ImportConflictStrategy,
  type ParsedImport,
} from "../import-export";
import { t } from "../i18n";
import type { AppearanceMode } from "../settings/settings";

export interface ImportPreviewSummary {
  entryCount: number;
  conflictCount: number;
  insertCount: number;
  replaceCount: number;
  skipCount: number;
  rejectCount: number;
  dates: string[];
  planFingerprint: string;
}

export interface ImportModalOptions {
  appearanceMode: AppearanceMode;
  defaultStrategy: ImportConflictStrategy;
  preview: (
    parsed: ParsedImport,
    strategy: ImportConflictStrategy,
  ) => Promise<ImportPreviewSummary>;
  commit: (
    parsed: ParsedImport,
    strategy: ImportConflictStrategy,
    expectedPlanFingerprint: string,
  ) => Promise<ImportPreviewSummary>;
}

type ImportFormat = "auto" | "json" | "csv" | "markdown";

export class ImportModal extends Modal {
  private input!: HTMLTextAreaElement;
  private format: ImportFormat = "auto";
  private strategy: ImportConflictStrategy;
  private summaryEl!: HTMLElement;
  private importButton!: HTMLButtonElement;
  private parsed: ParsedImport | null = null;
  private planFingerprint: string | null = null;
  private previewVersion = 0;

  constructor(
    app: App,
    private readonly options: ImportModalOptions,
  ) {
    super(app);
    this.strategy = options.defaultStrategy;
  }

  override onOpen(): void {
    this.modalEl.addClass("timepoint-modal");
    this.modalEl.addClass(`timepoint-appearance-${this.options.appearanceMode}`);
    this.titleEl.setText(t("import.title"));
    this.contentEl.empty();
    this.contentEl.addClass("timepoint-import");

    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("import.description"),
    });

    const options = this.contentEl.createDiv({ cls: "timepoint-import-options" });
    const formatField = options.createDiv({ cls: "timepoint-editor-field" });
    formatField.createEl("label", { text: t("import.format") });
    const formatSelect = formatField.createEl("select", { cls: "dropdown" });
    addSelectOption(formatSelect, "auto", t("import.auto"));
    addSelectOption(formatSelect, "json", t("import.json"));
    addSelectOption(formatSelect, "csv", t("import.csv"));
    addSelectOption(formatSelect, "markdown", t("import.markdown"));
    formatSelect.value = this.format;
    formatSelect.addEventListener("change", () => {
      this.format = formatSelect.value as ImportFormat;
      void this.updatePreview();
    });

    const strategyField = options.createDiv({ cls: "timepoint-editor-field" });
    strategyField.createEl("label", { text: t("import.strategy") });
    const strategySelect = strategyField.createEl("select", { cls: "dropdown" });
    addSelectOption(strategySelect, "skip", t("import.skip"));
    addSelectOption(strategySelect, "replace", t("import.replace"));
    addSelectOption(strategySelect, "new-id", t("import.newId"));
    strategySelect.value = this.strategy;
    strategySelect.addEventListener("change", () => {
      this.strategy = strategySelect.value as ImportConflictStrategy;
      void this.updatePreview();
    });

    this.input = this.contentEl.createEl("textarea", {
      attr: {
        placeholder: t("import.placeholder"),
        "aria-label": "Timeline import data",
        spellcheck: "false",
      },
    });
    this.input.addEventListener("input", () => void this.updatePreview());

    this.summaryEl = this.contentEl.createDiv({ cls: "timepoint-import-summary" });
    this.summaryEl.setText(t("import.waiting"));
    this.summaryEl.setAttr("aria-live", "polite");

    const actions = this.contentEl.createDiv({ cls: "timepoint-editor-actions" });
    const cancel = actions.createEl("button", {
      cls: "timepoint-button",
      text: t("import.cancel"),
    });
    cancel.addEventListener("click", () => this.close());
    const preview = actions.createEl("button", {
      cls: "timepoint-button",
      text: t("import.refresh"),
    });
    preview.addEventListener("click", () => void this.updatePreview());
    this.importButton = actions.createEl("button", {
      cls: "timepoint-button is-accent",
      text: t("import.commit"),
    });
    this.importButton.disabled = true;
    this.importButton.addEventListener("click", () => void this.commit());

    window.setTimeout(() => this.input.focus(), 0);
  }

  override onClose(): void {
    this.previewVersion += 1;
    this.contentEl.empty();
  }

  private async updatePreview(): Promise<void> {
    const version = ++this.previewVersion;
    this.importButton.disabled = true;
    this.planFingerprint = null;
    const input = this.input.value;
    if (!input.trim()) {
      this.parsed = null;
      this.summaryEl.setText(t("import.waiting"));
      return;
    }

    const format = this.format === "auto" ? detectFormat(input) : this.format;
    const parsed =
      format === "json"
        ? parseTimePointJson(input)
        : format === "markdown"
          ? parseTimePointMarkdown(input)
          : parseTimePointCsv(input);
    this.parsed = parsed;
    if (!parsed.ok || parsed.issues.length > 0) {
      const details = parsed.issues
        .slice(0, 4)
        .map((issue) => issue.message)
        .join(" ");
      this.summaryEl.setText(
        t("import.blocked", {
          details: `${details}${parsed.issues.length > 4 ? ` (+${parsed.issues.length - 4})` : ""}`,
        }),
      );
      return;
    }

    this.summaryEl.setText(t("import.checking", { format: format.toUpperCase() }));
    try {
      const summary = await this.options.preview(parsed, this.strategy);
      if (version !== this.previewVersion) return;
      this.summaryEl.setText(formatSummary(summary));
      this.planFingerprint = summary.planFingerprint;
      this.importButton.disabled = summary.entryCount === 0 || summary.rejectCount > 0;
    } catch (error) {
      if (version !== this.previewVersion) return;
      this.summaryEl.setText(error instanceof Error ? error.message : t("import.previewFailure"));
    }
  }

  private async commit(): Promise<void> {
    const parsed = this.parsed;
    const planFingerprint = this.planFingerprint;
    if (!parsed || !parsed.ok || parsed.issues.length > 0 || !planFingerprint) return;
    this.importButton.disabled = true;
    this.importButton.setText(t("import.committing"));
    try {
      const result = await this.options.commit(parsed, this.strategy, planFingerprint);
      new Notice(t("import.complete", { summary: formatSummary(result) }));
      this.close();
    } catch (error) {
      this.summaryEl.setText(error instanceof Error ? error.message : t("import.failure"));
      this.importButton.disabled = false;
      this.importButton.setText(t("import.commit"));
    }
  }
}

function detectFormat(input: string): Exclude<ImportFormat, "auto"> {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{")) return "json";
  if (trimmed.startsWith("---") && /timepoint-(?:(?:entry|range)-)?schema:/u.test(trimmed)) {
    return "markdown";
  }
  return "csv";
}

function addSelectOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = select.createEl("option", { value, text: label });
  option.value = value;
}

function formatSummary(summary: ImportPreviewSummary): string {
  const dateLabel =
    summary.dates.length === 1
      ? (summary.dates[0] ?? "")
      : t("import.days", { days: summary.dates.length });
  return t("import.summary", {
    entries: summary.entryCount,
    dates: dateLabel,
    inserted: summary.insertCount,
    replaced: summary.replaceCount,
    skipped: summary.skipCount,
    rejected: summary.rejectCount,
    conflicts: summary.conflictCount,
  });
}
