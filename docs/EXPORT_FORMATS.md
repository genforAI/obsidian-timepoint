# Export formats

TimePoint exports are a two-step operation: preview, then commit with the preview fingerprint. The
commit reloads every selected date and fails if the normalized source changed.

## Scopes and paths

- Day: `TimePoint/Exports/YYYY-MM-DD/`
- Inclusive range: `TimePoint/Exports/YYYY-MM-DD_to_YYYY-MM-DD/`
- Maximum range: 366 days, including both endpoints

Empty dates count toward the preview and range limit. An all-empty scope may still produce an empty
Markdown, JSON, CSV, or portable manifest.

## Single-day compatibility

Single-day Markdown and JSON retain `timepoint-schema: 1` / `schemaVersion: 1`. Existing compatible
imports continue to parse them. Optional card-layout and snapshot-association fields round-trip
without changing the event schema. CSV retains its original columns and appends optional
`cardSchema`, `cardX`, `cardY`, `cardWidth`, `cardHeight`, `cardUpdatedAt`, and `linkSnapshotIds`
columns. CSV does not promise complete daily viewport/reference-card state.

## Range Schema 1

Range JSON declares:

```json
{
  "timepointRangeSchema": 1,
  "startDate": "2028-02-28",
  "endDate": "2028-03-01",
  "entries": []
}
```

Range Markdown frontmatter declares `timepoint-range-schema: 1`, `startDate`, `endDate`, and an
`eventCount`. Each non-empty day is enclosed by explicit range-day boundaries and contains a
complete single-day Schema 1 document. The importer verifies the event count, dates, parser
diagnostics, and globally unique IDs before planning writes.

CSV contains one row per event and carries `date` on every row. It has no separate range manifest,
so an empty CSV represents no dated rows.

## Portable notes folder

Portable export creates:

```text
portable/
├── _TimePoint_Export.md
├── TimePoint/Days/YYYY/MM/YYYY-MM-DD/
│   ├── _Timeline.md
│   └── HHmm--<stable-id>.md
└── TimePoint/Snapshots/<snapshot-id>/
    ├── snapshot.md
    └── preview.webp
```

Copy the enclosed `TimePoint` folder into another Vault. The root guide is written last. If a
caught write fails, TimePoint attempts to remove every file created by that operation and does not
show a success result. Every selected date receives an index, including empty dates, so its
validated viewport, minimap, relationship toggle, stacking, and reference-card layout survive.
Only completed snapshots associated with exported events are included; each preview is written
before its `snapshot.md` completion marker. A missing or invalid associated snapshot blocks the
portable operation instead of silently producing a broken relationship graph.

## Whole-operation blockers

No output is written when any selected date contains an error diagnostic or future schema, when an
ID repeats in the selected range, or when data changes after preview. Existing output is never
overwritten; a numeric suffix is chosen instead. The preview fingerprint covers event data, daily
view-state blocks, and used snapshot files, so a layout, relationship, or cache change also requires
a new preview.
