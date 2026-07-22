# TimePoint 0.8.0-beta.1 manual Obsidian checklist

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
      `0.8.0-beta.1`; the tag has no `v` prefix.
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
- [ ] Space temporarily enables Hand behavior; releasing it restores the selected tool.
- [ ] 50–300% button zoom preserves the viewport centre; Command/Ctrl+wheel anchors the pointer;
      Fit and Now are correct and none changes event content or timestamps.
- [ ] 40–400% vertical controls and Alt/Option+wheel change only temporal spacing. The value is
      independent from canvas zoom and persists separately for each date and layout mode.
- [ ] Wide minimap shows nodes, event/reference rectangles, and current viewport; click and frame
      drag navigate correctly. Below 720 px it opens from a floating overlay button without
      overwriting the saved wide-screen preference.

## Card canvas and persistence

- [ ] Card single-click selects and persistently raises it; double-click opens the native note.
- [ ] Card drag changes only visual position. Eight edge/corner handles resize within limits.
- [ ] Links/buttons inside cards retain their native action and never start a card drag.
- [ ] Mouse movement below 6 px and coarse movement below 10 px remains a click.
- [ ] Axis-near drag pans after the threshold; an axis-near click still creates. Ordinary blank
      drag pans, while ordinary blank click clears selection.
- [ ] Escape, pointer-capture loss, and interrupted gestures restore the starting geometry and
      produce no layout write.
- [ ] Command/Ctrl+Z and Command/Ctrl+Shift+Z undo/redo layout while the timeline is focused.
- [ ] Reload, date switch, mode switch, index rebuild, and external file refresh preserve final
      geometry, stacking, viewport, minimap state, and relationship toggle.
- [ ] Drag/resize does not change `time`, body bytes, tags, `createdAt`, or business `updatedAt`.
- [ ] Manual cards may intentionally overlap; automatic cards avoid them with visible spacing.
- [ ] After move/resize, overlapping cards form an opaque, theme-correct deck: only the top
      Markdown is visible, covered cards remain quiet clipped edges, and the `+N` chooser can raise
      or open every covered note.
- [ ] Narrow leaves temporarily clamp card geometry and restore the wider preference when widened.
- [ ] Embedded timelines render saved geometry but expose no move/resize persistence controls.
- [ ] Same-time events use distinct quiet path ports; only the selected path is emphasized and no
      connector blocks card interaction.

## Native records and previews

- [ ] Toolbar and axis creation each create one independent event Markdown note.
- [ ] Rapid repeated axis clicks start only one create/editor operation at a time.
- [ ] Hovering/clicking an occupied minute highlights its existing node without a duplicate time
      label or full-axis accent.
- [ ] The normal Obsidian editor opens with body focus and autosaves.
- [ ] Double-click, pencil, Enter, and node actions reuse the native editor pane.
- [ ] Long text, images, tables, callouts, code, embeds, and long tokens clip inside bounded cards.
- [ ] The lower image/text portion stays hidden until the complete note opens.
- [ ] A quiet theme-derived fade appears only when the card truly overflows. There is no repeated
      clipping hint, and delayed image loading adds/removes the fade without flashing peer cards.
- [ ] Repeated split resize reflows cards without overlap or revealing clipped content.
- [ ] Delete, undo, external edit/create/rename/delete, legacy repair, and migration remain safe.

## Locale and embedded behavior

- [ ] English locale has no untranslated Simplified Chinese text.
- [ ] Simplified Chinese locale translates primary controls, empty state, settings, import/export,
      and embedded labels; date and weekday follow locale.
- [ ] Unsupported locales fall back to English.
- [ ] Editable and read-only embedded blocks behave independently; invalid config stays local.

## Relationship view and optional network

- [ ] Relationship view defaults off and is remembered independently for each date.
- [ ] Same-day TimePoint links connect the existing event card; cross-day links show a day entry;
      ordinary local Markdown opens through Obsidian; duplicate targets and cycles stay bounded.
- [ ] Only direct links appear initially. Explicit expansion never exceeds 50 reference cards or
      100 edges.
- [ ] Reference cards move, resize, stack, reload, and reset without changing referenced notes.
- [ ] First snapshot enable explains target, cache, and privacy before any request. Decline keeps
      local relations working and leaves URL placeholders inert.
- [ ] With explicit consent, only public HTTPS targets are requested. Credential URLs, HTTP,
      localhost, `.local`, IP literals, private/reserved targets, SVG, bad MIME/magic, responses
      above 512 KiB HTML/2 MiB image, and late results are rejected.
- [ ] Two simultaneous requests maximum and per-host pacing are observable with synthetic targets;
      duplicate references share one request and merge source associations.
- [ ] A complete cache hit makes no request; explicit Refresh does. Offline failure can retry and
      never creates a successful event association.
- [ ] Cache contains only metadata plus optional WebP, with `snapshot.md` committed last; no script
      or full page HTML is stored.

## Export and re-import

- [ ] Day and inclusive range scopes show exact day/event/empty/conflict/error preview counts.
- [ ] A 366-day range is accepted; 367 days, reversed dates, invalid dates, future schema, parser
      errors, and duplicate IDs are blocked before writing.
- [ ] Change an event after preview; export requires a fresh preview and writes nothing.
- [ ] Day and range Markdown round-trip through Import.
- [ ] Day and range JSON round-trip through Import.
- [ ] CSV preserves multiple dates, multiline Markdown, quotes, commas, tags, and IDs.
- [ ] Portable folder contains `manifest.json`, ordinary event files, day indexes, directly
      referenced local attachments, and the root guide. Confirm attachment references are rewritten
      only in exported copies and the source notes remain byte-identical.
- [ ] ZIP the Portable tree and import it into a second test Vault. Confirm Web/Obsidian manifest
      compatibility, layout/view/relationship state, attachments, and used snapshots survive.
- [ ] Traversal, case-colliding paths, encrypted/ZIP64 archives, header mismatch, compression bombs,
      invalid MIME/magic/SHA-256, duplicate IDs, and any existing target block the whole import.
- [ ] Missing or changed associated snapshots and changed daily view state invalidate preview and
      block the whole portable write.
- [ ] Success reports exact file count/path; Markdown/portable Open works; path copy works; content
      copy appears only for single files no larger than 2 MiB.
- [ ] Existing exports receive a suffix and are not overwritten.

## Decision

- `PASS`: every beta-required interaction is tied to the exact candidate runtime.
- `FAIL`: Obsidian is available and a required behavior fails.
- `BLOCKED`: the required real runtime/platform is unavailable. Do not substitute mock screenshots.
