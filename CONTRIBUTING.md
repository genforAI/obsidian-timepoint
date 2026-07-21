# Contributing to TimePoint

Thanks for helping improve a small, local-first Obsidian plugin. Keep changes focused and protect
ordinary Markdown before visual convenience.

## Development setup

Use Node.js 20 or 22 and a disposable Obsidian Vault:

```bash
npm ci
npm run check
```

For iterative bundling, run `npm run dev` and copy or link `manifest.json`, `main.js`, and
`styles.css` into the disposable Vault's `.obsidian/plugins/timepoint/` folder.

Automated checks must stay in the background. Do not automate a contributor's foreground Obsidian
window. When a visible runtime check is necessary, describe it first and let the user operate the
test window unless they explicitly authorize UI control.

## Data-safety rules

- Do not change event Markdown Schema 1 or silently migrate user data in a feature patch.
- Preserve unrelated frontmatter fields and complete event bodies.
- Treat future schemas, duplicate IDs, malformed boundaries, and stale previews as hard write
  blockers.
- Build the complete mutation or export plan before writing its first file.
- Never turn partial output into a success notice.
- Add round-trip and conflict tests for every import, export, repair, or migration change.

## UI rules

- Scope every selector under a TimePoint class or the TimePoint workspace leaf.
- Use Obsidian semantic variables. Do not add a fixed brand color or literal light/dark surface.
- Pass runtime geometry through `--tp-*` custom properties.
- Keep both appearance modes, light/dark themes, narrow splits, 200% zoom, keyboard operation, and
  44 px touch targets in mind.
- Keep full-document editing in a native `MarkdownView`; timeline cards remain bounded previews.
- Add both English and Simplified Chinese strings for every new translation key.

## Pull requests

Explain the user-visible behavior, affected storage paths, and safety boundary. Include tests and
privacy-reviewed screenshots only when layout changes. Run `npm run check` before requesting
review. Do not commit `main.js`, local test Vaults, internal runtime evidence, or note content.

By contributing, you agree that your changes are licensed under the repository's MIT license.
