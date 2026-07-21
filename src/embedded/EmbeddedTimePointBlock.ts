import { App, MarkdownRenderChild } from "obsidian";
import { t } from "../i18n";
import type { TimePointEntry } from "../model/types";
import type { TimePointSettings } from "../settings/settings";
import type { DayFileRepository } from "../storage";
import { TimelineRenderer } from "../views/TimelineRenderer";
import {
  pathsAffectEmbeddedDay,
  type TimePointBlockConfig,
  type TimePointBlockConfigIssue,
} from "./TimePointBlockConfig";

export interface EmbeddedTimePointBlockCallbacks {
  onCreateAtTime: (date: string, time: string) => void | Promise<void>;
  onCreateNow: (date: string) => void | Promise<void>;
  onEditEntry: (date: string, entry: TimePointEntry) => void | Promise<void>;
  onOpenSource: (date: string, entry: TimePointEntry) => void | Promise<void>;
}

export interface EmbeddedTimePointBlockOptions {
  app: App;
  repository: DayFileRepository;
  getSettings: () => TimePointSettings;
  config: TimePointBlockConfig;
  callbacks: EmbeddedTimePointBlockCallbacks;
}

/**
 * Reading View child for one `timepoint` code block.
 *
 * Every instance owns its renderer, listeners, refresh timer, and render token,
 * so multiple blocks in the same note cannot cancel or unload one another.
 */
export class EmbeddedTimePointBlock extends MarkdownRenderChild {
  private readonly renderer: TimelineRenderer;
  private readonly app: App;
  private readonly repository: DayFileRepository;
  private readonly getSettings: () => TimePointSettings;
  private readonly config: TimePointBlockConfig;
  private readonly callbacks: EmbeddedTimePointBlockCallbacks;
  private statusEl!: HTMLElement;
  private timelineHostEl!: HTMLElement;
  private refreshTimer: number | null = null;
  private renderToken = 0;

  constructor(containerEl: HTMLElement, options: EmbeddedTimePointBlockOptions) {
    super(containerEl);
    this.app = options.app;
    this.repository = options.repository;
    this.getSettings = options.getSettings;
    this.config = options.config;
    this.callbacks = options.callbacks;
    this.renderer = new TimelineRenderer(this.app);
  }

  override onload(): void {
    this.addChild(this.renderer);
    this.buildShell();
    this.registerVaultRefreshEvents();
    void this.refresh();
  }

  override onunload(): void {
    this.renderToken += 1;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.containerEl.empty();
  }

  async refresh(): Promise<void> {
    const token = ++this.renderToken;
    const settings = this.getSettings();
    this.containerEl.removeClass("timepoint-appearance-native", "timepoint-appearance-signature");
    this.containerEl.addClass(`timepoint-appearance-${settings.appearanceMode}`);
    this.statusEl.removeClass("is-error", "is-warning");
    this.statusEl.setText(t("embedded.loading"));
    this.statusEl.show();

    try {
      // loadDay returns an in-memory empty day when the file is absent. It never
      // calls ensureDayFile and therefore Reading View cannot create vault data.
      const day = await this.repository.loadDay(this.config.date);
      if (token !== this.renderToken) return;

      const errors = day.diagnostics.filter((item) => item.severity === "error");
      const warnings = day.diagnostics.filter((item) => item.severity === "warning");
      if (errors.length > 0 || warnings.length > 0) {
        this.statusEl.addClass(errors.length > 0 ? "is-error" : "is-warning");
        this.statusEl.setText(
          t("embedded.diagnostics", { errors: errors.length, warnings: warnings.length }),
        );
        this.statusEl.setAttr(
          "title",
          day.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
        );
      } else {
        this.statusEl.hide();
      }

      await this.renderer.render(
        this.timelineHostEl,
        day.entries,
        this.config.mode,
        this.repository.getDayPath(this.config.date),
        settings,
        {
          editable: this.config.editable,
          getEntrySourcePath: (entry) => this.repository.getEntrySourcePath(entry),
          onCreateAtTime: (time) => {
            if (this.config.editable) {
              this.runAction(() => this.callbacks.onCreateAtTime(this.config.date, time));
            }
          },
          onCreateNow: () => {
            if (this.config.editable) {
              this.runAction(() => this.callbacks.onCreateNow(this.config.date));
            }
          },
          onEditEntry: (entry) => {
            if (this.config.editable) {
              this.runAction(() => this.callbacks.onEditEntry(this.config.date, entry));
            }
          },
          onOpenSource: (entry) => {
            this.runAction(() => this.callbacks.onOpenSource(this.config.date, entry));
          },
        },
      );
      if (token !== this.renderToken) return;
    } catch (error) {
      if (token !== this.renderToken) return;
      this.timelineHostEl.empty();
      this.statusEl.show();
      this.statusEl.addClass("is-error");
      this.statusEl.setText(error instanceof Error ? error.message : t("embedded.readFailure"));
    }
  }

  private buildShell(): void {
    this.containerEl.empty();
    this.containerEl.addClass("timepoint-embedded");
    this.containerEl.addClass(`timepoint-appearance-${this.getSettings().appearanceMode}`);
    this.containerEl.toggleClass("is-editable", this.config.editable);
    this.containerEl.toggleClass("is-readonly", !this.config.editable);

    const header = this.containerEl.createDiv({ cls: "timepoint-embedded-header" });
    const heading = header.createDiv({ cls: "timepoint-embedded-heading" });
    heading.createEl("strong", { text: `TimePoint · ${this.config.date}` });
    heading.createSpan({
      cls: "timepoint-embedded-mode",
      text: this.config.mode === "elastic" ? t("embedded.elastic") : t("embedded.realtime"),
    });
    header.createSpan({
      cls: "timepoint-embedded-access",
      text: this.config.editable ? t("embedded.editable") : t("embedded.readonly"),
    });

    this.statusEl = this.containerEl.createDiv({ cls: "timepoint-view-status" });
    const scroll = this.containerEl.createDiv({ cls: "timepoint-embedded-scroll" });
    this.timelineHostEl = scroll.createDiv({ cls: "timepoint-embedded-timeline-host" });
  }

  private registerVaultRefreshEvents(): void {
    const consider = (...paths: string[]): void => {
      if (pathsAffectEmbeddedDay(this.repository.getDayPath(this.config.date), paths)) {
        this.scheduleRefresh();
      }
    };
    this.registerEvent(this.app.vault.on("create", (file) => consider(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => consider(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => consider(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => consider(oldPath, file.path)),
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 120);
  }

  private runAction(action: () => void | Promise<void>): void {
    Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        this.statusEl.show();
        this.statusEl.addClass("is-error");
        this.statusEl.setText(error instanceof Error ? error.message : t("embedded.actionFailure"));
      });
  }
}

export function renderTimePointBlockConfigError(
  containerEl: HTMLElement,
  issues: readonly TimePointBlockConfigIssue[],
): void {
  containerEl.empty();
  containerEl.addClass("timepoint-embedded", "timepoint-appearance-native", "is-error");
  const error = containerEl.createDiv({ cls: "timepoint-embedded-config-error" });
  error.createEl("strong", { text: t("embedded.invalid") });
  const list = error.createEl("ul");
  for (const issue of issues) list.createEl("li", { text: issue.message });
}
