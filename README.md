# TimePoint

TimePoint is a local-first, Markdown-native daily timeline for Obsidian. It turns ordinary event
notes into a responsive 00:00–24:00 record of what happened without requiring an account, backend,
telemetry, or network request.

> `0.5.0-beta.1` is a desktop beta. Keep a normal vault backup and report reproducible problems
> with private note text removed.

## What it does

- Stores every event as an independent Markdown note with stable Schema 1 metadata.
- Opens the complete event in a normal Obsidian Markdown editor; double-click a card to edit.
- Keeps long text, images, tables, code, callouts, and embeds clipped inside timeline cards.
- Reflows dense periods in Elastic mode or preserves proportional time in Real-time mode.
- Follows the active Obsidian theme in Native mode; Signature mode derives a restrained accent
  layer from the user's `--interactive-accent`.
- Adapts at narrow split widths with container queries and 44 px touch targets.
- Displays English or Simplified Chinese from the Obsidian locale, with English fallback.
- Embeds an editable or read-only timeline in an ordinary note's Reading View.
- Previews and safely exports one day or an inclusive date range in Markdown, JSON, CSV, or a
  portable notes folder.

## Install the beta with BRAT

After the GitHub beta release is published:

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Run **BRAT: Add a beta plugin for testing**.
3. Enter `https://github.com/GITHUB_OWNER/obsidian-timepoint`.
4. Enable **TimePoint** under **Settings → Community plugins**.

`GITHUB_OWNER` is intentionally a local publishing placeholder until the maintainer signs in with
`gh auth login`. It must be replaced before a release can pass the repository preflight.

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

- Select **Add TimePoint**, or move within about 22 px of the axis and click the previewed time.
- TimePoint immediately creates one normal Markdown file and opens it in an adjacent native
  Obsidian editor.
- Edit and save as usual. Obsidian owns the editor and autosave behavior.
- Double-click a card, select its pencil, press Enter on a focused card, or select a node to reopen
  the complete note.
- Delete moves the event note to Obsidian's trash. **Undo last entry delete** restores the latest
  deletion during the current plugin session.

Cards never expand into full documents inside the timeline. A visible fade and “preview ends
here” label mark clipped content, including the lower portion of oversized images.

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
CSV includes one row per event with its date. Portable export recreates standard
`TimePoint/Days/...` event notes, day indexes, and a root `_TimePoint_Export.md` guide.

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
timestamps, tags, timezone, and source. Unrelated user properties such as `aliases` and
`cssclasses` are preserved. No pixel geometry is persisted.

Legacy multi-event Schema 1 day files remain readable and can migrate non-destructively to event
notes; the original file remains as an archive. See [Data format](docs/DATA_FORMAT.md).

## Privacy and security

TimePoint has no runtime dependencies, account system, telemetry, analytics, or required network
requests. Event content remains in the Vault. User-authored remote images or links retain normal
Obsidian behavior. Review [Privacy](docs/PRIVACY.md) and [Security](SECURITY.md) before sharing a
diagnostic or screenshot.

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

## Known limitations

- This beta is marked desktop-only. macOS is the first runtime gate; Windows is required before the
  stable community submission.
- Physical iOS and Android behavior is not verified and is not claimed as supported.
- Embedded timelines run in Reading View, not Live Preview.
- There is no drag-to-reschedule, week/month analytics, cloud backend, or AI summarization.
- Vault APIs cannot provide a filesystem transaction; TimePoint validates and stages output first,
  removes newly created files after a caught write failure, and never publishes the portable root
  index before its contents.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Local release and community-directory steps are documented
in [Publishing](docs/PUBLISHING.md). External publishing is deliberately not automated until the
maintainer authenticates and explicitly authorizes it.

## License

[MIT](LICENSE) © J. Hall
