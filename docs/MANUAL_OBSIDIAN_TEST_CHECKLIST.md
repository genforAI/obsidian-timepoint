# TimePoint 0.5.0-beta.1 manual Obsidian checklist

Use a disposable Vault and the exact three candidate runtime files. Record Obsidian, OS, theme,
scaling, version/hash, and synthetic fixture revision. Never include personal notes in evidence.

## Foreground-control protocol

- [ ] Run builds, file inspection, hashing, and automated tests in the background.
- [ ] Do not activate, resize, move, or cover the user's foreground applications for routine work.
- [ ] Explain why a real UI action is indispensable before requesting control.
- [ ] Prefer user-performed clicks in a dedicated test window.
- [ ] Stop visible control immediately after the specific runtime observation.

## Install and entry points

- [ ] Release assets are exactly `manifest.json`, `main.js`, and `styles.css` for
      `0.5.0-beta.1`; the tag has no `v` prefix.
- [ ] Plugin enables without a console exception and shows one non-blocking ready notice only once.
- [ ] Ribbon and **Open timeline** command open the view.
- [ ] The Settings **Open timeline** button opens the view.
- [ ] An empty day shows Create, Learn, and Export actions without creating a file or stealing a
      new workspace pane.
- [ ] `_Timeline.md` Reading View renders its embedded timeline.

## Theme and responsive UI

- [ ] Native mode follows default light/dark surfaces, borders, text, warnings, focus, and accent.
- [ ] Signature mode derives from the current accent and adds no fixed purple or black glow.
- [ ] Minimal and AnuPpuccin remain readable in light and dark variants.
- [ ] A high-contrast custom accent keeps text and focus visible.
- [ ] Axis and ordinary connectors remain quiet; current/selected/create states remain clear.
- [ ] Test widths near 320, 560, 720, 900, and 1200 px and 200% scaling.
- [ ] Toolbar wraps/compacts without clipping; all coarse-pointer targets are at least 44 px.
- [ ] Dense Elastic and same-time branches remain distinct without card overlap.
- [ ] Dense previews compact automatically while the complete Markdown remains unchanged in the
      native editor.
- [ ] Real-time nodes remain proportional; lanes are capped to the leaf width and packed cards do
      not overlap.
- [ ] Elastic → Real-time mode changes show the axis and earliest event on the first painted frame,
      with no stale horizontal blank region.
- [ ] Dense proportional badges never overlap; suppressed exact times appear on node hover/focus.
- [ ] Hand mode drags vertically and horizontally without creating or opening an event.
- [ ] 50–300% zoom and 100% reset preserve the relative viewport centre and never change Markdown
      or timestamps.

## Native records and previews

- [ ] Toolbar and axis creation each create one independent event Markdown note.
- [ ] Rapid repeated axis clicks start only one create/editor operation at a time.
- [ ] Hovering/clicking an occupied minute highlights its existing node without a duplicate time
      label or full-axis accent.
- [ ] The normal Obsidian editor opens with body focus and autosaves.
- [ ] Double-click, pencil, Enter, and node actions reuse the native editor pane.
- [ ] Long text, images, tables, callouts, code, embeds, and long tokens clip inside bounded cards.
- [ ] The lower image/text portion stays hidden until the complete note opens.
- [ ] Repeated split resize reflows cards without overlap or revealing clipped content.
- [ ] Delete, undo, external edit/create/rename/delete, legacy repair, and migration remain safe.

## Locale and embedded behavior

- [ ] English locale has no untranslated Simplified Chinese text.
- [ ] Simplified Chinese locale translates primary controls, empty state, settings, import/export,
      and embedded labels; date and weekday follow locale.
- [ ] Unsupported locales fall back to English.
- [ ] Editable and read-only embedded blocks behave independently; invalid config stays local.

## Export and re-import

- [ ] Day and inclusive range scopes show exact day/event/empty/conflict/error preview counts.
- [ ] A 366-day range is accepted; 367 days, reversed dates, invalid dates, future schema, parser
      errors, and duplicate IDs are blocked before writing.
- [ ] Change an event after preview; export requires a fresh preview and writes nothing.
- [ ] Day and range Markdown round-trip through Import.
- [ ] Day and range JSON round-trip through Import.
- [ ] CSV preserves multiple dates, multiline Markdown, quotes, commas, tags, and IDs.
- [ ] Portable folder contains ordinary event files, day indexes, and root guide; copy it to a
      second test Vault and open the indexes.
- [ ] Success reports exact file count/path; Markdown/portable Open works; path copy works; content
      copy appears only for single files no larger than 2 MiB.
- [ ] Existing exports receive a suffix and are not overwritten.

## Decision

- `PASS`: every beta-required interaction is tied to the exact candidate runtime.
- `FAIL`: Obsidian is available and a required behavior fails.
- `BLOCKED`: the required real runtime/platform is unavailable. Do not substitute mock screenshots.
