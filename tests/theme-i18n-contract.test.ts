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
  const renderer = readFileSync(
    new URL("../src/views/TimelineRenderer.ts", import.meta.url),
    "utf8",
  );

  it("uses semantic theme colors without fixed brand literals", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/rgba?\s*\(/iu);
    expect(css).toContain("var(--interactive-accent)");
    expect(css).toContain(".timepoint-appearance-native");
    expect(css).toContain(".timepoint-appearance-signature");
  });

  it("keeps selectors scoped and passes runtime geometry through custom properties", () => {
    expect(css).not.toMatch(/(?:^|,)\s*(?:button|input|select|textarea|table|img)\b/mu);
    expect(renderer).not.toMatch(/\.style\.(?:top|left|width|height|transform|minWidth)\s*=/u);
    expect(renderer).toContain('style.setProperty("--tp-card-y"');
    expect(renderer).toContain('style.setProperty("--tp-connector-angle"');
    expect(renderer).toContain('"data-minute": String(positioned.minuteOfDay)');
    expect(renderer).toContain('removeClass("is-create-target")');
    expect(renderer).toContain("hideGhost();\n      createPending = true;");
  });

  it("contains the required responsive thresholds and touch target", () => {
    expect(css).toMatch(/@container \(max-width: 899px\)/u);
    expect(css).toMatch(/@container \(max-width: 720px\)/u);
    expect(css).toMatch(/@container \(max-width: 559px\)/u);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 44px/u);
  });
});
