import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasTranslation, resolveLocale, translationKeys } from "../src/i18n";

describe("translation contract", () => {
  it("provides complete English and Simplified Chinese dictionaries", () => {
    const keys = translationKeys();
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.every((key) => hasTranslation(key, "en"))).toBe(true);
    expect(keys.every((key) => hasTranslation(key, "zh-CN"))).toBe(true);
  });

  it("follows Chinese Obsidian locales and falls back to English", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh-TW")).toBe("zh-CN");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("fr-FR")).toBe("en");
  });
});

describe("theme and geometry contract", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const renderer = [
    "../src/views/TimelineRenderer.ts",
    "../src/views/RelationLayerRenderer.ts",
    "../src/views/TimelineMinimap.ts",
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  const view = readFileSync(new URL("../src/views/TimePointView.ts", import.meta.url), "utf8");

  it("uses semantic theme colors without fixed brand literals", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/rgba?\s*\(/iu);
    expect(css).toContain("var(--interactive-accent)");
    expect(css).toContain(".timepoint-appearance-native");
    expect(css).toContain(".timepoint-appearance-signature");
  });

  it("keeps selectors scoped and passes runtime geometry through custom properties", () => {
    expect(css).not.toMatch(/(?:^|,)\s*(?:button|input|select|textarea|table|img)\b/mu);
    expect(renderer).not.toMatch(
      /\.style\.(?:top|right|bottom|left|width|height|transform|minWidth|minHeight|maxWidth|maxHeight|zIndex)\s*=/u,
    );
    expect(renderer).toContain('style.setProperty("--tp-card-y"');
    expect(renderer).toContain('style.setProperty("--tp-card-height"');
    expect(renderer).toContain("routeTimelineConnector({");
    expect(renderer).toContain('"data-minute": String(positioned.minuteOfDay)');
    expect(renderer).toContain('removeClass("is-create-target")');
    expect(renderer).toContain("callbacks.onCreateAtTime(pointerTime.time)");
    expect(renderer).toContain("this.installCanvasInteraction(");
    expect(renderer).toContain("timeline.setPointerCapture(event.pointerId)");
    expect(renderer).toContain('style.setProperty("--tp-card-z"');
    expect(renderer).toContain('style.setProperty("--tp-card-min-height"');
    expect(css).toContain(".timepoint-node.is-badge-suppressed::after");
    expect(css).toContain(".timepoint-connector-path.is-selected");
    expect(css).not.toContain(".timepoint-card.is-overlap-underlay");
    expect(css).not.toContain("clip-path: inset(0 0 calc(100% - 6px)");
    expect(css).not.toContain(".timepoint-timeline.is-moving-card .timepoint-card:not");
    expect(renderer).toContain("this.decorateOverlappingCards(");
  });

  it("keeps drag peers painted and zoom reuses the mounted Markdown DOM", () => {
    const fastZoomStart = renderer.indexOf("async updateTimelineScale(");
    const fullRenderStart = renderer.indexOf("private async renderSnapshot(", fastZoomStart);
    const fastZoomSource = renderer.slice(fastZoomStart, fullRenderStart);

    expect(fastZoomStart).toBeGreaterThanOrEqual(0);
    expect(fullRenderStart).toBeGreaterThan(fastZoomStart);
    expect(fastZoomSource).toContain("this.reflowExistingGeometry(scale)");
    expect(fastZoomSource).not.toContain("MarkdownRenderer.render");
    expect(fastZoomSource).not.toContain("container.empty()");
    expect(renderer).toContain("updateExistingCardsAndNodes(");
    expect(renderer).toContain("this.relationLayer?.updateScale(");
    expect(view).toContain("this.timelineRenderer.updateTimelineScale(normalized)");
    expect(renderer).toContain("previousSignature === presentation.signature");
    expect(renderer).toContain("if (!isTop) {");
    expect(renderer).toContain("const focusedEntryId =");
    expect(renderer).toContain("desired.set(focusedEntryId");
    expect(renderer).not.toContain("for (const id of group) desired.set");
    expect(renderer.match(/card\.dataset\.overlapSignature =/gu)).toHaveLength(1);
    expect(renderer).not.toContain("candidateCard?.toggleClass");
    expect(renderer).not.toContain("this.contentLayer.replaceChildren()");
    expect(renderer).toContain("changedCards = observedEntries.flatMap");
    expect(renderer).toContain("this.scheduleAutomaticReflow()");
    expect(renderer).not.toContain("measuredHeight: this.measureCardHeight(card)");
    expect(renderer).toContain("this.scheduleSettledConnectorRouting(runtime)");
    expect(renderer).toContain("performance.now() - startedAt < 6");
    expect(renderer).toContain("reconcileOverlaps = containerGeometryChanged");
    expect(renderer).toContain("this.reflowExistingGeometry(scale, false, true)");
    expect(renderer).toContain("this.installConnectorViewportUpdates(scrollContainer)");
    expect(renderer).toContain('runtime.mode === "elastic" && this.resizeObserver !== null');
    expect(renderer).toContain("this.updateResizeExpectations(layout)");
    expect(renderer).toContain('setStylePropertyIfChanged(card, "--tp-card-y"');
    expect(view).toContain("private async drainLatestWheelZoom()");
    expect(view).not.toContain("wheelZoomChain");
    expect(view).not.toContain("queuedWheelZoom");

    const commitStart = view.indexOf("private commitCardLayout(");
    const nextMethod = view.indexOf("private persistStackOrder(", commitStart);
    const commitSource = view.slice(commitStart, nextMethod);
    expect(commitSource).toContain("this.layoutCommitChain.then");
    expect(commitSource).not.toContain("requestRefresh()");
  });

  it("contains the required responsive thresholds and touch target", () => {
    expect(css).toMatch(/@container \(max-width: 899px\)/u);
    expect(css).toMatch(/@container \(max-width: 720px\)/u);
    expect(css).toMatch(/@container \(max-width: 559px\)/u);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/u);
  });
});
