import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { AppearanceMode } from "../settings/settings";

export type SnapshotConsentDecision = "granted" | "declined" | "dismissed";

export class ExternalSnapshotConsentModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly appearanceMode: AppearanceMode,
    private readonly resolveDecision: (decision: SnapshotConsentDecision) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("timepoint-modal", "timepoint-snapshot-consent");
    this.modalEl.addClass(`timepoint-appearance-${this.appearanceMode}`);
    this.contentEl.createEl("h2", { text: t("relations.consentTitle") });
    this.contentEl.createEl("p", { text: t("relations.consentBody") });
    const details = this.contentEl.createEl("ul", { cls: "timepoint-consent-details" });
    details.createEl("li", { text: t("relations.consentPublicHttps") });
    details.createEl("li", { text: t("relations.consentStored") });
    details.createEl("li", { text: t("relations.consentNoCookies") });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("relations.consentDeclineNote"),
    });
    const actions = this.contentEl.createDiv({ cls: "timepoint-confirmation-actions" });
    const decline = actions.createEl("button", {
      text: t("relations.decline"),
      attr: { type: "button" },
    });
    decline.addEventListener("click", () => this.finish("declined"));
    const allow = actions.createEl("button", {
      cls: "mod-cta",
      text: t("relations.allow"),
      attr: { type: "button" },
    });
    allow.addEventListener("click", () => this.finish("granted"));
    allow.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolveDecision("dismissed");
  }

  private finish(decision: SnapshotConsentDecision): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveDecision(decision);
    this.close();
  }
}
