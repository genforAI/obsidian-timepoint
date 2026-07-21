import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import type {
  ExportFormat,
  ExportPreview,
  ExportRequest,
  ExportResult,
} from "../services/ExportService";
import type { AppearanceMode } from "../settings/settings";
import { isValidDateString } from "../utils/time";

export interface ExportModalOptions {
  initialDate: string;
  appearanceMode: AppearanceMode;
  preview: (request: ExportRequest) => Promise<ExportPreview>;
  commit: (request: ExportRequest, expectedFingerprint: string) => Promise<ExportResult>;
  openPath: (path: string) => Promise<void>;
}

type ScopeChoice = "day" | "range";

export class ExportModal extends Modal {
  private scopeChoice: ScopeChoice = "day";
  private format: ExportFormat = "markdown";
  private startDate: string;
  private endDate: string;
  private summaryEl!: HTMLElement;
  private rangeFieldsEl!: HTMLElement;
  private exportButton!: HTMLButtonElement;
  private previewButton!: HTMLButtonElement;
  private previewResult: ExportPreview | null = null;
  private requestVersion = 0;

  constructor(
    app: App,
    private readonly options: ExportModalOptions,
  ) {
    super(app);
    this.startDate = options.initialDate;
    this.endDate = options.initialDate;
  }

  override onOpen(): void {
    this.modalEl.addClass("timepoint-modal", "timepoint-export-modal");
    this.modalEl.addClass(`timepoint-appearance-${this.options.appearanceMode}`);
    this.titleEl.setText(t("export.title"));
    this.renderForm();
  }

  override onClose(): void {
    this.requestVersion += 1;
    this.contentEl.empty();
  }

  private renderForm(): void {
    this.contentEl.empty();
    this.contentEl.addClass("timepoint-export");
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("export.description"),
    });

    const grid = this.contentEl.createDiv({ cls: "timepoint-export-options" });
    const scopeField = createField(grid, t("export.scope"));
    const scopeSelect = scopeField.createEl("select", { cls: "dropdown" });
    addOption(scopeSelect, "day", `${t("export.day")} · ${this.options.initialDate}`);
    addOption(scopeSelect, "range", t("export.range"));
    scopeSelect.value = this.scopeChoice;
    scopeSelect.addEventListener("change", () => {
      this.scopeChoice = scopeSelect.value as ScopeChoice;
      this.rangeFieldsEl.toggle(this.scopeChoice === "range");
      this.invalidatePreview();
    });

    const formatField = createField(grid, t("export.format"));
    const formatSelect = formatField.createEl("select", { cls: "dropdown" });
    addOption(formatSelect, "markdown", t("export.markdown"));
    addOption(formatSelect, "json", t("export.json"));
    addOption(formatSelect, "csv", t("export.csv"));
    addOption(formatSelect, "portable", t("export.portable"));
    formatSelect.value = this.format;
    formatSelect.addEventListener("change", () => {
      this.format = formatSelect.value as ExportFormat;
      this.invalidatePreview();
    });

    this.rangeFieldsEl = this.contentEl.createDiv({ cls: "timepoint-export-range" });
    const startField = createField(this.rangeFieldsEl, t("export.start"));
    const startInput = startField.createEl("input", { attr: { type: "date" } });
    startInput.value = this.startDate;
    startInput.addEventListener("change", () => {
      this.startDate = startInput.value;
      this.invalidatePreview();
    });
    const endField = createField(this.rangeFieldsEl, t("export.end"));
    const endInput = endField.createEl("input", { attr: { type: "date" } });
    endInput.value = this.endDate;
    endInput.addEventListener("change", () => {
      this.endDate = endInput.value;
      this.invalidatePreview();
    });
    this.rangeFieldsEl.toggle(this.scopeChoice === "range");

    this.summaryEl = this.contentEl.createDiv({ cls: "timepoint-export-summary" });
    this.summaryEl.setAttr("aria-live", "polite");
    this.summaryEl.setText(t("export.waiting"));

    const actions = this.contentEl.createDiv({ cls: "timepoint-editor-actions" });
    const close = actions.createEl("button", {
      cls: "timepoint-button",
      text: t("export.close"),
    });
    close.addEventListener("click", () => this.close());
    this.previewButton = actions.createEl("button", {
      cls: "timepoint-button",
      text: t("export.preview"),
    });
    this.previewButton.addEventListener("click", () => void this.preview());
    this.exportButton = actions.createEl("button", {
      cls: "timepoint-button is-accent",
      text: t("export.run"),
    });
    this.exportButton.disabled = true;
    this.exportButton.addEventListener("click", () => void this.commit());
  }

  private invalidatePreview(): void {
    this.requestVersion += 1;
    this.previewResult = null;
    this.exportButton.disabled = true;
    this.summaryEl.removeClass("is-error", "is-success");
    this.summaryEl.setText(t("export.waiting"));
  }

  private makeRequest(): ExportRequest {
    if (this.scopeChoice === "day") {
      return { scope: { kind: "day", date: this.options.initialDate }, format: this.format };
    }
    if (!isValidDateString(this.startDate) || !isValidDateString(this.endDate)) {
      throw new Error(t("export.rangeLimit"));
    }
    if (this.startDate > this.endDate) throw new Error(t("export.invalidRange"));
    return {
      scope: { kind: "range", startDate: this.startDate, endDate: this.endDate },
      format: this.format,
    };
  }

  private async preview(): Promise<void> {
    const version = ++this.requestVersion;
    this.previewResult = null;
    this.exportButton.disabled = true;
    this.previewButton.disabled = true;
    this.summaryEl.removeClass("is-error", "is-success");
    try {
      const result = await this.options.preview(this.makeRequest());
      if (version !== this.requestVersion) return;
      this.previewResult = result;
      this.renderPreview(result);
      this.exportButton.disabled = !result.canExport;
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.summaryEl.addClass("is-error");
      this.summaryEl.setText(error instanceof Error ? error.message : t("export.blocked"));
    } finally {
      if (version === this.requestVersion) this.previewButton.disabled = false;
    }
  }

  private renderPreview(preview: ExportPreview): void {
    this.summaryEl.empty();
    this.summaryEl.toggleClass("is-error", !preview.canExport);
    this.summaryEl.toggleClass("is-success", preview.canExport);
    this.summaryEl.createEl("strong", {
      text: t("export.summary", {
        days: preview.dayCount,
        entries: preview.entryCount,
        empty: preview.emptyDayCount,
        conflicts: preview.conflictCount,
        errors: preview.errorCount,
      }),
    });
    this.summaryEl.createDiv({
      text: preview.canExport ? t("export.ready") : t("export.blocked"),
    });
    if (preview.errors.length > 0) {
      const list = this.summaryEl.createEl("ul");
      for (const error of preview.errors.slice(0, 5)) list.createEl("li", { text: error });
      if (preview.errors.length > 5) {
        list.createEl("li", { text: `+${preview.errors.length - 5}` });
      }
    }
  }

  private async commit(): Promise<void> {
    const preview = this.previewResult;
    if (!preview?.canExport) return;
    this.exportButton.disabled = true;
    this.previewButton.disabled = true;
    this.exportButton.setText(t("export.running"));
    try {
      const result = await this.options.commit(preview.request, preview.sourceFingerprint);
      this.renderSuccess(result);
    } catch (error) {
      this.previewResult = null;
      this.summaryEl.removeClass("is-success");
      this.summaryEl.addClass("is-error");
      this.summaryEl.setText(error instanceof Error ? error.message : t("export.blocked"));
      this.exportButton.disabled = true;
      this.previewButton.disabled = false;
      this.exportButton.setText(t("export.run"));
    }
  }

  private renderSuccess(result: ExportResult): void {
    this.contentEl.empty();
    const success = this.contentEl.createDiv({ cls: "timepoint-export-success" });
    const icon = success.createDiv({ cls: "timepoint-export-success-icon" });
    setIcon(icon, "circle-check-big");
    success.createEl("h3", {
      text: t("export.success", { files: result.files.length, entries: result.entryCount }),
    });
    success.createDiv({ cls: "setting-item-name", text: t("export.pathLabel") });
    success.createEl("code", { cls: "timepoint-export-path", text: result.primaryPath });

    const resultActions = success.createDiv({ cls: "timepoint-export-result-actions" });
    if (result.primaryPath.endsWith(".md")) {
      const open = resultActions.createEl("button", {
        cls: "timepoint-button is-accent",
        text: t("export.open"),
      });
      open.addEventListener("click", () => void this.options.openPath(result.primaryPath));
    }
    const copyPath = resultActions.createEl("button", {
      cls: "timepoint-button",
      text: t("export.copyPath"),
    });
    copyPath.addEventListener("click", () => void this.copy(result.primaryPath, "path"));
    if (result.copyableContent !== undefined) {
      const copyContents = resultActions.createEl("button", {
        cls: "timepoint-button",
        text: t("export.copyContents"),
      });
      copyContents.addEventListener(
        "click",
        () => void this.copy(result.copyableContent ?? "", "contents"),
      );
    }

    const footer = success.createDiv({ cls: "timepoint-editor-actions" });
    const again = footer.createEl("button", {
      cls: "timepoint-button",
      text: t("export.again"),
    });
    again.addEventListener("click", () => this.renderForm());
    const close = footer.createEl("button", {
      cls: "timepoint-button is-accent",
      text: t("export.close"),
    });
    close.addEventListener("click", () => this.close());
  }

  private async copy(value: string, kind: "path" | "contents"): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      new Notice(t(kind === "path" ? "export.copiedPath" : "export.copiedContents"));
    } catch {
      new Notice(t("export.copyUnavailable", { value }), 8_000);
    }
  }
}

function createField(container: HTMLElement, label: string): HTMLElement {
  const field = container.createDiv({ cls: "timepoint-editor-field" });
  field.createEl("label", { text: label });
  return field;
}

function addOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = select.createEl("option", { text: label });
  option.value = value;
}
