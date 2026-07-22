# TimePoint

TimePoint is a local-first, Markdown-native daily timeline for Obsidian. It turns ordinary event
notes into a responsive 00:00–24:00 record of what happened without requiring an account, backend,
or telemetry. Optional external-link snapshots make bounded public HTTPS requests only after the
user enables them.

> `0.8.0-beta.1` is a desktop beta. Keep a normal vault backup and report reproducible problems
> with private note text removed.

## How this project was built

J. Hall defines the product direction and performs hands-on testing and acceptance in Obsidian.
OpenAI Codex produced the implementation, UI, performance optimization, automated test suite,
packaging, and release automation under that human direction and review.

The current public candidate passes 215/215 full-suite tests and 91/91 focused stress tests. The
same source also passes formatting, ESLint, strict TypeScript, production build, bundle smoke, and
high-severity dependency audit gates on Node.js 20 and 22. See [Validation](docs/VALIDATION.md) and
[Stress tests](docs/STRESS_TESTS.md) for the exact scope and remaining physical runtime gates.

## What it does

- Stores every event as an independent Markdown note with stable Schema 1 metadata.
- Opens the complete event in a normal Obsidian Markdown editor; double-click a card to edit.
- Keeps long text, images, tables, code, callouts, and embeds clipped inside timeline cards.
- Reflows dense periods in Elastic mode or preserves proportional time in Real-time mode.
- Provides an explicit Hand tool, Space-to-pan, two-dimensional panning, 50–300% anchored zoom,
  independent 40–400% vertical scale, fit-to-window, jump-to-now, and a responsive minimap.
- Lets the main timeline move and resize cards without changing their real event time, content,
  tags, or business timestamp; layout changes support cancel, undo, redo, and reset.
- Optionally builds a bounded daily relationship view for TimePoint links, local notes, and
  consent-gated external-link metadata snapshots.
- Follows the active Obsidian theme in Native mode; Signature mode derives a restrained accent
  layer from the user's `--interactive-accent`.
- Adapts at narrow split widths with container queries and 44 px touch targets.
- Displays English or Simplified Chinese from the Obsidian locale, with English fallback.
- Embeds an editable or read-only timeline in an ordinary note's Reading View.
- Previews and safely exports one day or an inclusive date range in Markdown, JSON, CSV, or a
  cross-compatible Portable package with directly referenced local attachments.

## Install the beta with BRAT

After the GitHub beta release is published:

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Run **BRAT: Add a beta plugin for testing**.
3. Enter `https://github.com/genforAI/obsidian-timepoint`.
4. Enable **TimePoint** under **Settings → Community plugins**.

### Manual install

Copy these three files from the matching GitHub release into
`<vault>/.obsidian/plugins/timepoint/`, then reload and enable the plugin:

- `manifest.json`
- `main.js`
- `styles.css`

The release tag must exactly match the manifest version and must not begin with `v`.

## Open TimePoint

Use any of these entry points after enabling the plugin:

1. Select the `calendar-clock` icon in the left ribbon.
2. Run **TimePoint: Open timeline** from the command palette.
3. Select **Open timeline** on the TimePoint settings page.
4. Open any generated `_Timeline.md` note in Reading View to use its embedded timeline.

The one-time ready notice is non-blocking. Opening an empty date does not create a file or steal
focus. Its welcome card offers **Create first entry**, **How the timeline works**, and **Open
export**.

## Record and edit

- Select **Add TimePoint**, or move within about 22 px of an unoccupied axis position and click the
  previewed time.
- TimePoint immediately creates one normal Markdown file and opens it in an adjacent native
  Obsidian editor.
- Edit and save as usual. Obsidian owns the editor and autosave behavior.
- Double-click a card or node, select its pencil, or press Enter on a focused card to reopen the
  complete note. A single node click only selects its event.
- Delete moves the event note to Obsidian's trash. **Undo last entry delete** restores the latest
  deletion during the current plugin session.

Cards never expand into full documents inside the timeline. Only genuinely clipped content receives
a quiet, theme-derived bottom fade; there is no repeated hint strip or label. The complete note,
including the hidden lower portion of an oversized image, remains available in the native editor.

Drag ordinary blank space to pan, hold Space for temporary Hand behavior, or enable the Hand button
to pan from any non-control surface without opening, creating, or moving cards. Drag a card body to
store a visual position and use its eight edge/corner handles to store a visual size. These actions
never reschedule the event: edit the native note's `time` property to change real time. Press Escape
to cancel an active gesture, and use Command/Ctrl+Z or Command/Ctrl+Shift+Z while the timeline is
focused to undo or redo layout changes.

Zoom Out, the percentage button, Zoom In, Fit, and Now affect the saved viewport for that date and
layout mode, not event content. Command/Ctrl+wheel zooms around the pointer. The separate vertical
scale controls—or Alt/Option+wheel—compress or expand temporal spacing from 40% to 400% without
changing canvas zoom or event time. Both values are remembered per date and layout mode. On wide
leaves the minimap is visible; below about 720 px it opens from a floating button.

## Relationship view

Relationship view is off by default and remembered per day. When enabled, direct Wiki links,
Markdown links, same-day/cross-day TimePoint references, and ordinary local notes appear as
bounded cards to the right of the event canvas. Expand buttons reveal additional local levels up
to 50 reference cards and 100 edges; duplicate targets and cycles are bounded. Reference cards can
be moved and resized without modifying the referenced note.

External URLs remain placeholders unless **External link snapshots** is enabled. The first enable
shows a consent explanation. With consent, TimePoint requests only public HTTPS targets through
Obsidian, without login cookies, scripts, or full-page storage. It caches a truncated title,
description, fetch time, source association, and an optional validated PNG/JPEG/WebP preview under
`TimePoint/Snapshots/`. Cache hits do not reconnect; refresh is explicit. Private/reserved hosts,
credential URLs, SVG, executable content, oversized responses, and invalid image bytes are
rejected. Local relations continue to work if consent is declined.

## Embed a timeline

Add this block to an ordinary note and open Reading View:

````markdown
```timepoint
date: today
mode: elastic
editable: true
```
````

Use `editable: false` for review-only timelines. Fixed `YYYY-MM-DD` dates and `realtime` mode are
also supported. Rendering an absent day never creates vault data.

## Export and transfer

Select the visible **Export** button in the timeline toolbar. The unified panel supports:

- **Scope:** current day or an inclusive date range of at most 366 days.
- **Formats:** Markdown, JSON, CSV, and Portable notes folder.
- **Preview:** exact day, event, empty-day, conflict, warning, and error counts before writing.
- **Completion actions:** open the Markdown/portable index, copy the Vault path, and copy complete
  single-file content when it is no larger than 2 MiB.

Default locations are:

```text
TimePoint/Exports/YYYY-MM-DD/
TimePoint/Exports/YYYY-MM-DD_to_YYYY-MM-DD/
```

Markdown and JSON date-range exports use `timepoint-range-schema: 1` and can be imported again.
CSV includes one row per event with its date and optional card fields. Portable export recreates
standard `TimePoint/Days/...` event notes, day indexes with viewport/relationship state, used
completed snapshots, and a root `_TimePoint_Export.md` guide. It also packages the first layer of
directly referenced, non-Markdown local attachments, rewrites paths only in exported event copies,
and leaves every Vault source note untouched. The Import panel accepts the shared
`timepoint-portable` ZIP emitted by TimePoint Web or the Obsidian plugin.

An error-level parser diagnostic, future schema, or duplicate ID blocks the whole export. If data
changes after preview, TimePoint requires another preview and writes nothing. See
[Export formats](docs/EXPORT_FORMATS.md).

## Vault data

The canonical layout is:

```text
TimePoint/Days/YYYY/MM/YYYY-MM-DD/
├── _Timeline.md
├── HHmm--<stable-id>.md
└── HHmm--<stable-id>.md
```

Each event body is unrestricted Markdown. TimePoint-owned YAML stores its stable ID, date, time,
timestamps, tags, timezone, and source. A separate optional `timepoint-card-schema: 1` extension
stores normalized visual position/width and logical height; it never changes `time` or business
`updatedAt`. Unrelated properties such as `aliases` and `cssclasses` are preserved. `_Timeline.md`
stores a validated hidden view-state block for per-mode viewport, minimap, relationship toggle,
reference-card geometry, and stacking order.

Legacy multi-event Schema 1 day files remain readable and can migrate non-destructively to event
notes; the original file remains as an archive. See [Data format](docs/DATA_FORMAT.md).

## Privacy and security

TimePoint has no account system, telemetry, analytics, or required network requests. Event content
remains in the Vault. The production bundle includes a small ZIP parser used only for Portable
interchange. Optional external-link snapshots use a disclosed,
consent-gated and bounded public HTTPS request path; they never send event bodies. User-authored
remote images or links retain normal Obsidian behavior. Review [Privacy](docs/PRIVACY.md) and
[Security](SECURITY.md) before enabling snapshots or sharing a diagnostic.

## Build and verify

Use Node.js 20 or 22:

```bash
npm ci
npm run check
```

The full check runs Prettier, ESLint with Obsidian-specific rules, strict TypeScript, Vitest,
minified production build, bundle smoke evaluation, and a high-severity dependency audit. CI runs
the same gates on Node 20 and 22. `main.js` is intentionally ignored by Git and is attached only to
GitHub Releases.

To prepare the exact local upload set after verification, run:

```bash
npm run release:stage
```

This rebuilds `Release/<version>/` with the three official GitHub/BRAT assets, a manual-install ZIP,
SHA-256 files, release notes, and an upload checklist. `Release/` is deliberately ignored by Git:
upload its files to the matching GitHub Release, but never commit the compiled bundle to the source
branch. See [Publishing](docs/PUBLISHING.md) for the owner placeholder and exact tag rules.

The [density and interaction stress matrix](docs/STRESS_TESTS.md) covers clustered and same-minute
records, narrow leaves, deterministic packing, preview clipping, mode switches, and the remaining
real-Obsidian checks.

## Known limitations

- This beta is marked desktop-only. macOS is the first runtime gate; Windows is required before the
  stable community submission.
- Physical iOS and Android behavior is not verified and is not claimed as supported.
- Embedded timelines run in Reading View, not Live Preview.
- Card dragging is visual layout only. There is no drag-to-reschedule, multi-select, rotation,
  free drawing, week/month analytics, cloud backend, or AI summarization.
- Relationship expansion is deliberately bounded and external snapshots are metadata previews,
  not complete web archives.
- Vault APIs cannot provide a filesystem transaction; TimePoint validates and stages output first,
  removes newly created files after a caught write failure, and never publishes the portable root
  index before its contents.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Local release and community-directory steps are documented
in [Publishing](docs/PUBLISHING.md). External publishing is deliberately not automated until the
maintainer authenticates and explicitly authorizes it.

## License

[MIT](LICENSE) © J. Hall
