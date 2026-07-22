# TimePoint data format

## Canonical ownership

Markdown inside the vault is the source of truth. Settings and the last-opened date may live in
plugin `data.json`; event bodies, timestamps, IDs, tags, and durable card layout do not. Automatic
layout, responsive clamps, clipping, and measured Markdown height remain runtime-only.

Version 0.7 stores a day as a folder without changing event Schema 1:

```text
TimePoint/Days/YYYY/MM/YYYY-MM-DD/
├── _Timeline.md
├── 0815--tp-20260718-081500-a1.md
└── 0930--tp-20260718-093000-b2.md
```

The storage root is configurable. The `HHmm` filename prefix is for readable sorting; identity is
the stable `id` property and never depends on a card position.

## Independent event note

```markdown
---
timepoint-entry-schema: 1
id: "tp-20260718-081500-a1"
date: 2026-07-18
time: "08:15"
timezone: "Asia/Shanghai"
createdAt: "2026-07-18T00:15:00.000Z"
updatedAt: "2026-07-18T00:15:00.000Z"
tags: ["planning"]
source: "manual"
---

### Morning plan

- Review yesterday's notes
- Plan today's priorities
```

This is an ordinary Obsidian Markdown note. TimePoint owns the documented properties, but preserves
unrelated properties such as `aliases`, `cssclasses`, and data added by other plugins. The complete
body after frontmatter is user Markdown.

| Field                    | Rule                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `timepoint-entry-schema` | Currently `1`; newer schemas are read-only                                           |
| `id`                     | Stable identity; letters, digits, and hyphens; at most 128 characters                |
| `date`                   | Real calendar date in `YYYY-MM-DD`                                                   |
| `time`                   | Stored wall-clock time from `00:00` through `23:59`                                  |
| `timezone`               | Optional audit label; wall-clock `time` remains the display anchor                   |
| `createdAt`, `updatedAt` | ISO timestamps                                                                       |
| `tags`                   | String array                                                                         |
| `source`                 | Optional origin such as `manual`, `timeline-click`, or an import source              |
| Markdown body            | Full event content; headings, embeds, tables, callouts, code, images, and links work |

`minuteOfDay` is derived in memory. `24:00` is a visual axis endpoint, not a persisted event time.

## Optional card layout extension

Moving or resizing a main-timeline card adds an independent display extension to that event's
frontmatter. It does not alter event Schema 1, `time`, body, tags, or business `updatedAt`:

```yaml
timepoint-card-schema: 1
timepoint-card-x: 0.5
timepoint-card-y: 0.333333
timepoint-card-width: 0.45
timepoint-card-height: 180
timepoint-card-updated-at: "2026-07-21T12:00:00.000Z"
```

`x` and `y` are normalized card-center preferences in the logical card/day canvas (`0…1`). Width
is a fraction of the available card canvas (`0.2…1`). Height is a 100% zoom logical height
(`72…720` px). Responsive leaves temporarily clamp the resolved rectangle without overwriting the
wide-layout preference. Missing fields mean automatic density layout. Reset deletes all six
fields. Invalid values are diagnosed and ignored; safe numeric values are clamped, and the event
falls back to automatic layout rather than becoming unreadable.

The optional `timepoint-link-snapshots` array contains SHA-256 snapshot IDs currently associated
with external links in that event. Relationship refresh removes stale associations but never
silently deletes the cache folder.

## Portable day index

`_Timeline.md` contains `timepoint-layout: entry-files`, the date, a fenced `timepoint` block, and
relative links to event notes. In Reading View the block is interactive; in any Markdown reader the
links remain useful. Copy the dated folder into the matching TimePoint hierarchy of another vault
to transfer that day and retain stable IDs.

The index is derived and may be rebuilt after event mutations. Durable user content belongs in the
event notes, not in generated index sections. TimePoint preserves one managed display block:

```text
<!-- timepoint:view-state
{"schemaVersion":1,"modes":{"elastic":{"zoom":1,"centerX":0.5,"centerY":0},"realtime":{"zoom":1,"centerX":0.5,"centerY":0}},"minimapExpanded":true,"relationsEnabled":false,"stackOrder":[],"referenceCards":{}}
-->
```

The validated block remembers separate Elastic/Real-time zoom and normalized viewport centers,
the wide-screen minimap preference, the daily relationship toggle, event/reference stacking, and
reference-card layout/expansion. Zoom is clamped to `0.5…3`; reference cards are capped at 50 and
stack entries at 500. A future view-state schema is preserved but ignored and never blocks event
reading. Duplicate/malformed managed blocks block display-state writes rather than guessing.

## External snapshot cache

After explicit networking consent, a completed external metadata snapshot uses:

```text
TimePoint/Snapshots/<normalized-url-sha256>/
├── snapshot.md
└── preview.webp
```

The Markdown marker contains the original/normalized public HTTPS URL, escaped truncated title and
description, fetch time, content hash, source event IDs, and optional preview path. It is written
last. There is no stored script or full page HTML. The optional image is a validated size-limited
WebP. A matching complete marker is a cache hit and prevents automatic refetch; refresh is
explicit.

## Legacy Schema 1 compatibility

Versions 0.1–0.3 used one `YYYY-MM-DD.md` file containing ID-bounded event blocks and hidden JSON
metadata. Version 0.4 retains the complete parser and read path for those files.

- A valid legacy day can migrate explicitly or on its first new mutation.
- Migration creates independent event files first and `_Timeline.md` last.
- The original `YYYY-MM-DD.md` is never overwritten or deleted by migration.
- Existing identical partial migration files make a retry idempotent; conflicting files stop the
  migration before the index commit marker is written.
- A day with unresolved parser errors remains read-only.

## Conservative legacy repair

The repair planner never writes while inspecting. It auto-repairs only when all current errors are
eliminated by an unambiguous operation:

- complete a truncated matching end marker such as a missing final `>`; or
- append the sole missing matching end marker at end of file when the start marker, heading ID, and
  metadata ID all agree and no later managed block exists.

Any mismatched ID, duplicate, future schema, malformed metadata, invalid time/date, or combined
damage that remains after the plan blocks automatic repair. Valid events still render, and the UI
opens the owning source for manual correction.

## Mutation and conflict policy

- Add creates one new event note, then rebuilds the daily index.
- Update uses `Vault.process()` to reread the exact note, compares the complete snapshot captured
  when it was opened, preserves unrelated YAML, and renames the file if its time prefix changed.
- Delete verifies the same snapshot and sends only that event note to trash.
- Duplicate IDs in separate files are diagnosed; ambiguous update/delete is blocked.
- A malformed independent note is isolated instead of making unrelated notes unreadable.

External or sync changes therefore cause a conflict message rather than a silent overwrite.

## Copy, import, and export

- Card actions copy either a normal note link or a complete portable event Markdown document.
- Paste import accepts a portable event note, a complete legacy/day Markdown export, JSON, or CSV.
- Imports are parsed and conflict-planned before any write; `skip`, `replace`, and `new-id` are
  explicit duplicate strategies.
- Day exports remain compatible as Markdown, JSON, and RFC4180 CSV.
- Inclusive date ranges use independent `timepoint-range-schema: 1` Markdown/JSON manifests; CSV
  carries a date per row, and portable export recreates the canonical folder tree.
- Markdown and JSON preserve card layout/snapshot metadata. CSV exposes optional card fields but is
  not a complete canvas-state format. Portable export preserves event extensions, daily view
  state, relationship layout, and used completed snapshots.
- Error-level diagnostics block export so a partial recovery is never presented as complete data.

The import preview fingerprint must still match a fresh vault read at commit time. Repository
snapshot guards remain the final defense against a race during the individual write.

See [EXPORT_FORMATS.md](EXPORT_FORMATS.md) for range boundaries, fingerprints, paths, and portable
output.
