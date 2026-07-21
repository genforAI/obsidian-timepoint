# TimePoint architecture

## Runtime stance

TimePoint is a browser-compatible Obsidian plugin. Runtime source uses Obsidian and Web Platform
APIs only; it does not import Node.js, Electron, or direct filesystem APIs. Markdown in the vault is
authoritative. Visual layout and selected/editor state are disposable runtime data.

## Layers

| Layer       | Main files                                                                  | Responsibility                                                                                         |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bootstrap   | `src/main.ts`                                                               | Settings, commands, refresh routing, import/export coordination                                        |
| Main view   | `src/views/TimePointView.ts`, `nativeEditorTarget.ts`                       | Date state, diagnostics/actions, timeline orchestration, native Markdown leaf reuse                    |
| Timeline    | `src/views/TimelineRenderer.ts`, `cardDisplay.ts`, `timelineInteraction.ts` | Bounded Markdown cards, copy actions, measurement, nodes/connectors, hit area, responsive reflow       |
| Embedded    | `src/embedded/`                                                             | Strict code-block config, Reading View lifecycle, editable/read-only routing, per-day storage refresh  |
| Layout      | `src/layout/`                                                               | Pure Elastic and Real-time geometry and forward/inverse time scales                                    |
| Storage     | `src/storage/`                                                              | Hybrid day loading, standalone notes, legacy parsing/repair, non-destructive migration, guarded writes |
| Portability | `src/import-export/`, `src/services/ExportService.ts`                       | Day/range formats, preview fingerprints, portable folders, conflict and partial-write guards           |

## Hybrid load flow

1. Resolve the legacy `YYYY-MM-DD.md` path and the v0.4 `YYYY-MM-DD/_Timeline.md` path.
2. If the index exists, read direct child event notes independently and attach diagnostics to their
   source paths.
3. Otherwise, read the legacy day with the Schema 1 recovery parser. An absent date stays an empty
   in-memory day and creates no file.
4. Render valid entries even when another entry is damaged; error-level diagnostics block only
   operations that could lose or misidentify data.
5. Pass each event's own source path to Obsidian `MarkdownRenderer`, so relative links and embeds
   resolve as they do in the event note.

## Migration transaction shape

Migration is non-destructive and retryable:

1. Read the latest legacy bytes.
2. Build a conservative repair plan in memory. Use the repaired copy only if it eliminates every
   error; otherwise require a clean parse.
3. Create the dated event folder.
4. Write each independent event note. An existing byte-identical note is accepted on retry; any
   different collision aborts.
5. Create `_Timeline.md` last. Its presence selects the v0.4 layout on future reads.
6. Keep the original legacy file as an archive.

No repair or migration infers a mismatched identity, removes user content, or downgrades a future
schema.

## Native create/edit flow

1. Toolbar, axis click, card/node action, embedded action, or command identifies a date and time.
2. A new event is immediately created as a real Markdown file; this intentionally follows native
   autosave instead of maintaining a private draft.
3. Desktop reuses one adjacent `MarkdownView`; mobile requests a normal Obsidian tab.
4. For v0.4 notes, the cursor targets the first body byte after YAML and the editor otherwise has no
   special styling—it is a normal Obsidian note.
5. For an unmigrated legacy day, the compatibility target locates exactly one bounded body and
   scoped Live Preview CSS hides only machine-owned comment lines while that legacy file is active.
6. Vault events refresh the main and embedded timelines after Obsidian autosaves.

## Card preview contract

Comfortable and Compact modes both impose a hard measured Markdown height. Short notes render in
full; long text, images, tables, code, callouts, and embeds are clipped without changing source.
Clipped cards display an explicit full-note hint and open the event note on double-click/Enter.
Layout measures the visible border box, so hidden content cannot inflate Elastic geometry.

## Timeline and resize behavior

Elastic uses a monotonic piecewise time scale and measured visible card heights to expand dense
periods without reordering events. Real-time keeps node Y proportional to `minute / 1440` and uses
horizontal lanes for card collisions. Labels, ghost time, click inversion, and nodes share the same
active scale. Creation is restricted to the 22 px axis radius.

ResizeObserver runs a bounded convergence pass after real width/content changes. Zero-sized hidden
leaves do not consume the budget. Container queries wrap the toolbar, diagnostics, axis, cards, and
embedded header for narrow splits.

## Portability and safety

- `_Timeline.md` is both a human-readable link index and a Reading View interactive record.
- Event notes can move/copy independently; card actions copy note links or their portable Markdown.
- Markdown, JSON, and CSV imports are previewed with deterministic fingerprints.
- Day/range export reloads every source at commit and compares the preview fingerprint before
  creating a file. Range exports are capped at 366 inclusive days.
- Portable output stages canonical event/index contents and writes its human root index last.
- Exact note snapshots guard update/delete, while unrelated YAML properties are preserved.
- Duplicate IDs and unknown/future schemas fail closed.
- Export aborts on any error diagnostic rather than emitting incomplete data.

## Invalidation and cleanup

Storage events for either the legacy file or any direct file in the dated folder schedule debounced
refresh. Markdown render components, embedded children, ResizeObservers, and timers are released on
rerender/unload. No content cache persists; day state is reconstructed from Markdown.

## Theme and responsive posture

Native appearance uses Obsidian semantic variables only. Signature appearance derives its accent
surface, selected edge, and node halo from `--interactive-accent`. Runtime geometry is passed to
scoped CSS through `--tp-*` properties; no pixel state enters Markdown. Container queries adapt at
approximately 560, 720, and 900 px, while coarse-pointer controls have at least 44 px targets.

## Mobile posture

No direct filesystem API is used, essential actions are visible without hover, and narrow controls
wrap. Physical mobile loading, touch, and virtual-keyboard behavior remain platform-unverified, so
the beta manifest is honestly marked desktop-only.
